import {
  type BusLaneRule,
  checkNetworkIntegrity,
  defaultSimConfig,
  type Lane,
  type Link,
  type Network,
  type NetworkOverride,
  parseNetwork,
  type SimConfig,
  type VehicleClass,
} from "@atl/contracts";
import { generateController } from "../signals/generate.ts";
import { regenerateController, type SignalOverrideSet } from "../signals/regenerate.ts";
import { createAssumptionCollector } from "./assumptions.ts";
import { computeConflicts } from "./conflicts.ts";
import { buildConnectors } from "./connectors.ts";
import { buildCrosswalksForNodes } from "./crosswalks.ts";
import { defaultTurns, LANE_WIDTH_M } from "./lanes.ts";
import { buildNodeMovements, type NodeMovements } from "./movements.ts";

/**
 * Applies scenario overrides (`docs/CONTRACTS.md` "Scenario и overrides") on top of an already
 * compiled network, producing a new `Network` deterministically - no OSM snapshot or graph is
 * available here, only what the compiled network already carries, so this stays a pure function of
 * (network, overrides, config) and imports no node:* module (browser build, card T-24 §1).
 */

const ALL_CLASSES: VehicleClass[] = ["car", "bus", "trolleybus", "taxi"];
const PT_CLASSES: VehicleClass[] = ["bus", "trolleybus"];
const MIN_POCKET_LENGTH_M = 0.1;

type LinkOverrideSet = Extract<NetworkOverride, { kind: "link" }>["set"];
type BusStopOverrideSet = Extract<NetworkOverride, { kind: "bus_stop" }>["set"];
type BusRouteOverrideSet = Extract<NetworkOverride, { kind: "bus_route" }>["set"];

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// link overrides: lane rebuild
// ---------------------------------------------------------------------------

/** Lanes of a link, leftmost first, resolved via `link.laneIds` (not array order in `net.lanes`). */
function lanesOfLink(net: Network, link: Link): Lane[] {
  const byLaneId = new Map(net.lanes.map((l) => [l.id, l] as const));
  const out: Lane[] = [];
  for (const id of link.laneIds) {
    const lane = byLaneId.get(id);
    if (lane !== undefined) out.push(lane);
  }
  return out;
}

function defaultBusLaneRule(): BusLaneRule {
  return {
    allowed: [...PT_CLASSES],
    activeFromMin: 0,
    activeToMin: 1440,
    carsMayEnterForRightTurnWithinM: 50,
  };
}

/**
 * Resolves the bus lane rule a link should end up with: `undefined` (`set.busLane` omitted) keeps
 * whatever the link already has; `null` removes it; an object adds one (falling back to defaults)
 * or merges onto the existing rule, field by field, so a scenario can tweak just the hours without
 * restating `allowed`.
 */
function resolveBusLane(
  existing: BusLaneRule | undefined,
  set: LinkOverrideSet["busLane"],
): BusLaneRule | undefined {
  if (set === undefined) return existing;
  if (set === null) return undefined;
  const base = existing ?? defaultBusLaneRule();
  return {
    allowed: set.allowed ?? base.allowed,
    activeFromMin: set.activeFromMin ?? base.activeFromMin,
    activeToMin: set.activeToMin ?? base.activeToMin,
    carsMayEnterForRightTurnWithinM:
      set.carsMayEnterForRightTurnWithinM ?? base.carsMayEnterForRightTurnWithinM,
  };
}

/**
 * Rebuilds the lanes of one link from a scenario override (card T-24 §1). A field left out of
 * `set` keeps whatever the *current* lanes already express, so re-applying the same override is a
 * no-op and independent link overrides in the same scenario don't clobber each other's part of the
 * lane layout. Lane order is fixed: `[leftPocket?] [general x N] [rightPocket?] [busLane?]` - a
 * right-turn pocket sits to the left of a bus lane, since the bus lane already owns the kerb.
 * Returns whether anything actually changed the lane layout (the caller only needs to rebuild
 * connectors/conflicts/the controller at the link's ends when it did).
 */
function rebuildLinkLanes(net: Network, link: Link, set: LinkOverrideSet): boolean {
  if (set.speedLimitKph !== undefined) {
    link.speedLimitKph = set.speedLimitKph;
    link.provenance = { ...link.provenance, speedLimitKph: "manual" };
  }

  const structural =
    set.generalLanes !== undefined ||
    set.leftPocketLengthM !== undefined ||
    set.rightPocketLengthM !== undefined ||
    set.busLane !== undefined;
  if (!structural) return false;

  const oldLanes = lanesOfLink(net, link);
  const oldBusLane = oldLanes.find((l) => l.kind === "bus");
  const oldLeftPocket = oldLanes.find((l) => l.kind === "turn_pocket" && l.turns.includes("left"));
  const oldRightPocket = oldLanes.find(
    (l) => l.kind === "turn_pocket" && l !== oldLeftPocket && l.turns.includes("right"),
  );
  const oldGeneral = oldLanes.filter(
    (l) => l !== oldBusLane && l !== oldLeftPocket && l !== oldRightPocket,
  );

  const generalLanes = set.generalLanes ?? Math.max(1, oldGeneral.length);
  const leftPocketLengthM =
    set.leftPocketLengthM ?? (oldLeftPocket ? link.lengthM - oldLeftPocket.startS : 0);
  const rightPocketLengthM =
    set.rightPocketLengthM ?? (oldRightPocket ? link.lengthM - oldRightPocket.startS : 0);
  const busLane = resolveBusLane(oldBusLane?.busLane, set.busLane);

  const hasLeftPocket = leftPocketLengthM > 0;
  const hasRightPocket = rightPocketLengthM > 0;

  const generalTurns = defaultTurns(generalLanes, hasLeftPocket);
  if (hasRightPocket) {
    const lastIndex = generalTurns.length - 1;
    const last = generalTurns[lastIndex];
    if (last !== undefined) generalTurns[lastIndex] = last.filter((t) => t !== "right");
  }

  const lengthM = link.lengthM;
  const newLanes: Lane[] = [];
  let index = 0;
  const push = (partial: Omit<Lane, "id" | "linkId" | "index" | "widthM">): void => {
    const id = `${link.id}:${index}`;
    newLanes.push({ id, linkId: link.id, index, widthM: LANE_WIDTH_M, ...partial });
    index += 1;
  };

  if (hasLeftPocket) {
    push({
      startS: Math.max(MIN_POCKET_LENGTH_M, roundS(lengthM - leftPocketLengthM)),
      endS: roundS(lengthM),
      kind: "turn_pocket",
      allowed: [...ALL_CLASSES],
      turns: ["left"],
      provenance: { turns: "manual", startS: "manual" },
    });
  }
  for (let i = 0; i < generalLanes; i++) {
    push({
      startS: 0,
      endS: roundS(lengthM),
      kind: "general",
      allowed: [...ALL_CLASSES],
      turns: [...(generalTurns[i] ?? ["through"])],
      provenance: { turns: "manual" },
    });
  }
  if (hasRightPocket) {
    push({
      startS: Math.max(MIN_POCKET_LENGTH_M, roundS(lengthM - rightPocketLengthM)),
      endS: roundS(lengthM),
      kind: "turn_pocket",
      allowed: [...ALL_CLASSES],
      turns: ["right"],
      provenance: { turns: "manual", startS: "manual" },
    });
  }
  if (busLane !== undefined) {
    push({
      startS: 0,
      endS: roundS(lengthM),
      kind: "bus",
      allowed: [...PT_CLASSES],
      turns: ["through", "right"],
      busLane,
      provenance: { turns: "manual", busLane: "manual", busLaneHours: "manual" },
    });
  }

  net.lanes = net.lanes.filter((l) => l.linkId !== link.id).concat(newLanes);
  link.laneIds = newLanes.map((l) => l.id);
  link.provenance = { ...link.provenance, laneIds: "manual" };
  return true;
}

function roundS(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Connectors, conflicts, crosswalks and controllers of the nodes a link touches
// ---------------------------------------------------------------------------

/**
 * Rebuilds connectors, conflicts, zebras and (for a signalized node) a fresh baseline plan for
 * exactly `nodeIds` - the two ends of every link a scenario touched (card T-24 §1, T-07's
 * per-node scope). Everything elsewhere in the network - other nodes' connectors, protection,
 * signal plans - is left untouched, which is why this never calls the whole-network
 * `runIntersections`/`runSignals` stages again.
 */
function regenerateNodes(net: Network, nodeIds: ReadonlySet<string>, config: SimConfig): void {
  if (nodeIds.size === 0) return;
  const assumptions = createAssumptionCollector();
  const byNode = buildNodeMovements(net);

  const scopedByNode = new Map<string, NodeMovements>();
  for (const id of nodeIds) {
    const movements = byNode.get(id);
    if (movements !== undefined) scopedByNode.set(id, movements);
  }
  const freshConnectors = buildConnectors(net, scopedByNode);
  net.connectors = net.connectors.filter((c) => !nodeIds.has(c.viaNodeId)).concat(freshConnectors);

  const crosswalkNodeIds = [...nodeIds]
    .filter((id) => net.crosswalks.some((cw) => cw.nodeId === id))
    .sort();
  if (crosswalkNodeIds.length > 0) {
    const freshCrosswalks = buildCrosswalksForNodes(net, byNode, crosswalkNodeIds, assumptions);
    net.crosswalks = net.crosswalks.filter((cw) => !nodeIds.has(cw.nodeId)).concat(freshCrosswalks);
  }

  // Conflicts (and the baseline `protection` they assign) are entirely local to one node's
  // connectors (conflicts.ts never compares connectors of two different nodes), so scoping the
  // network handed to `computeConflicts` to just these nodes' connectors leaves every other
  // connector's protection - including one a signal plan already set elsewhere - untouched.
  const scopedNet: Network = {
    ...net,
    connectors: net.connectors.filter((c) => nodeIds.has(c.viaNodeId)),
  };
  // `Network` has no field for a link's bridge/tunnel layer (T-07's `linkLevels` is a compiler-only
  // side channel that never reaches the schema), so every link here is treated as ground level -
  // the same information a scenario editor has to work with, and moot on the bboxes this project
  // ships (`report.linkLevels` is `{}` for the small square; see compile.test.ts).
  computeConflicts({ net: scopedNet, byNode, linkLevels: {}, assumptions });

  for (const nodeId of [...nodeIds].sort()) {
    const node = net.nodes.find((n) => n.id === nodeId);
    if (node === undefined || node.kind !== "signalized") continue;
    const movements = byNode.get(nodeId);
    if (movements === undefined) continue;
    // A baseline plan; a `signal` override for this node (applied right after, see
    // `applyOverrides`) overwrites it again with the scenario's manual settings.
    generateController(net, nodeId, config.signals, { movements });
  }
}

// ---------------------------------------------------------------------------
// bus_stop / bus_route overrides
// ---------------------------------------------------------------------------

function applyBusStopOverride(net: Network, stopId: string, set: BusStopOverrideSet): void {
  const stop = net.busStops.find((s) => s.id === stopId);
  if (stop === undefined) throw new Error(`applyOverrides: unknown bus stop "${stopId}"`);
  if (set.kind === undefined) return;
  stop.kind = set.kind;
  stop.provenance = { ...stop.provenance, kind: "manual" };
}

function applyBusRouteOverride(net: Network, routeId: string, set: BusRouteOverrideSet): void {
  if (set.enabled === false) {
    net.busRoutes = net.busRoutes.filter((r) => r.id !== routeId);
    return;
  }
  const route = net.busRoutes.find((r) => r.id === routeId);
  if (route === undefined) throw new Error(`applyOverrides: unknown bus route "${routeId}"`);
  const provenance = { ...route.provenance };
  if (set.headwayPeakS !== undefined) {
    route.headwayPeakS = set.headwayPeakS;
    provenance.headwayPeakS = "manual";
  }
  if (set.headwayOffpeakS !== undefined) {
    route.headwayOffpeakS = set.headwayOffpeakS;
    provenance.headwayOffpeakS = "manual";
  }
  route.provenance = provenance;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Re-applies scenario overrides on top of an already compiled network (card T-24). Deterministic
 * and side-effect free: `network` is never mutated, and calling this again with the very same
 * `overrides` - on the input network or on a network this function already produced - yields a
 * deep-equal result (tests: "idempotency").
 *
 * Order (docs/CONTRACTS.md "Scenario и overrides"): every `link` override rebuilds its lanes first;
 * then the connectors/conflicts/zebras/baseline plan of every node any of those links touched are
 * rebuilt once for the whole batch; then every `signal` override regenerates its controller
 * (`regenerateController`, T-08), which - for a node a `link` override also touched - runs on top
 * of that fresh baseline and so preserves the scenario's manual settings; then `bus_stop` and
 * `bus_route` overrides, which touch neither lanes nor connectors.
 *
 * `scenarioId`, when given, is appended to `meta.networkId` (`<base>+<scenarioId>`) so the worker
 * and the UI can tell which scenario produced a given network; omit it to keep `meta.networkId`
 * unchanged (e.g. re-applying the baseline scenario, which carries no overrides at all).
 */
export function applyOverrides(
  network: Network,
  overrides: readonly NetworkOverride[],
  config: SimConfig = defaultSimConfig(),
  scenarioId?: string,
): Network {
  const net: Network = structuredClone(network);

  const affectedNodeIds = new Set<string>();
  for (const override of overrides) {
    if (override.kind !== "link") continue;
    const link = net.links.find((l) => l.id === override.linkId);
    if (link === undefined) throw new Error(`applyOverrides: unknown link "${override.linkId}"`);
    if (rebuildLinkLanes(net, link, override.set)) {
      affectedNodeIds.add(link.fromNodeId);
      affectedNodeIds.add(link.toNodeId);
    }
  }
  regenerateNodes(net, affectedNodeIds, config);

  for (const override of overrides) {
    if (override.kind !== "signal") continue;
    const node = net.nodes.find((n) => n.id === override.nodeId);
    if (node === undefined) throw new Error(`applyOverrides: unknown node "${override.nodeId}"`);
    if (node.kind !== "signalized")
      throw new Error(`applyOverrides: node "${override.nodeId}" is not signalized`);
    const report = regenerateController(net, override.nodeId, override.set, config.signals);
    if (report === undefined)
      throw new Error(`applyOverrides: node "${override.nodeId}" has no vehicle movement`);
  }

  for (const override of overrides) {
    if (override.kind === "bus_stop") applyBusStopOverride(net, override.stopId, override.set);
    else if (override.kind === "bus_route")
      applyBusRouteOverride(net, override.routeId, override.set);
  }

  net.lanes.sort(byId);
  net.connectors.sort(byId);
  net.crosswalks.sort(byId);
  net.signalControllers.sort(byId);
  net.busRoutes.sort(byId);

  if (scenarioId !== undefined) {
    net.meta = { ...net.meta, networkId: `${net.meta.networkId}+${scenarioId}` };
  }

  const parsed = parseNetwork(net);
  const errors = checkNetworkIntegrity(parsed);
  if (errors.length > 0) {
    const shown = errors.slice(0, 20).join("\n");
    throw new Error(`applyOverrides produced an invalid network (${errors.length}):\n${shown}`);
  }
  return parsed;
}

export type { BusRouteOverrideSet, BusStopOverrideSet, LinkOverrideSet, SignalOverrideSet };
