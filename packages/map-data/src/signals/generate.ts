import type {
  Connector,
  LeftTurnMode,
  Network,
  SignalController,
  SignalGroup,
  SignalTiming,
} from "@atl/contracts";
import { buildNodeMovements, type NodeMovements } from "../compiler/movements.ts";
import {
  type ApproachPlan,
  approachGroups,
  buildGroups,
  controllerId,
  type GroupPlan,
} from "./groups.ts";
import { buildPhases } from "./phases.ts";

export interface ControllerOptions {
  /** approach linkId -> forced handling of its left turn; the rest use the default rule. */
  leftTurnModes?: Readonly<Record<string, LeftTurnMode>>;
  /** false: no pedestrian groups at all; zebras stay without a signal group. */
  pedestrianPhase?: boolean;
  /** Shift of the cycle start; the generator itself always produces 0 (coordination is T-22). */
  offsetS?: number;
  /** Movements of this node, when the caller already built them for the whole network. */
  movements?: NodeMovements;
}

/** What the plan of one node assumed, for the compile report. */
export interface ControllerReport {
  controller: SignalController;
  cycleS: number;
  /** Σy of the phases Webster split; > 0.9 means the node is assumed to be saturated. */
  flowRatioSum: number;
  /** approach linkId -> mode, only for the approaches whose mode came from the default rule. */
  defaultLeftTurnModes: Record<string, LeftTurnMode>;
}

/**
 * Fixed-time plan of one signalized node (card T-08 §1). Groups, phases and Webster timings are
 * built from the network alone; the controller is written into `net.signalControllers` and every
 * connector and zebra of the node gets its `signalGroupId` and `protection`.
 *
 * Returns `undefined` when the node carries no vehicle movement at all — such a node cannot have
 * a controller that passes the integrity check, and the caller reports it as a warning.
 */
export function generateController(
  net: Network,
  nodeId: string,
  cfg: SignalTiming,
  opts: ControllerOptions = {},
): ControllerReport | undefined {
  const movements = opts.movements ?? buildNodeMovements(net).get(nodeId);
  if (movements === undefined) return undefined;
  const groups = buildGroups(
    net,
    movements,
    cfg,
    opts.leftTurnModes ?? {},
    opts.pedestrianPhase ?? true,
  );
  const vehicleGroups = groups.approaches.flatMap(approachGroups);
  if (vehicleGroups.length === 0) return undefined;

  const { phases, cycleS, flowRatioSum } = buildPhases(movements, groups, cfg);
  if (phases.length === 0) return undefined;

  const controller: SignalController = {
    id: controllerId(nodeId),
    nodeId,
    offsetS: opts.offsetS ?? 0,
    groups: [...vehicleGroups, ...groups.pedestrians.map((p) => p.group)],
    phases,
    leftTurnModes: leftTurnModesOf(groups.approaches),
    pedestrianPhase: opts.pedestrianPhase ?? true,
    provenance: { phases: "default", leftTurnModes: "default", offsetS: "default" },
  };

  applyToNetwork(net, controller, groups);
  const defaultLeftTurnModes: Record<string, LeftTurnMode> = {};
  for (const plan of groups.approaches)
    if (plan.leftTurnModeIsDefault) defaultLeftTurnModes[plan.linkId] = plan.leftTurnMode;
  return { controller, cycleS, flowRatioSum, defaultLeftTurnModes };
}

function leftTurnModesOf(approaches: readonly ApproachPlan[]): Record<string, LeftTurnMode> {
  const out: Record<string, LeftTurnMode> = {};
  for (const plan of approaches) out[plan.linkId] = plan.leftTurnMode;
  return out;
}

/**
 * Writes the controller into the network: it replaces any previous controller of the node, gives
 * every connector of the node its group and protection, and points the zebras at their pedestrian
 * groups. Connectors that stay outside every group (a `prohibited` left) fall back to `yield`.
 */
function applyToNetwork(net: Network, controller: SignalController, groups: GroupPlan): void {
  const byId = new Map(net.connectors.map((c) => [c.id, c] as const));
  const groupOfConnector = new Map<string, SignalGroup>();
  for (const group of controller.groups)
    for (const id of group.connectorIds) groupOfConnector.set(id, group);
  const protectedIds = protectedConnectorIds(controller, groupOfConnector, byId);

  for (const connector of groups.connectors) {
    const group = groupOfConnector.get(connector.id);
    if (group === undefined) {
      delete connector.signalGroupId;
      connector.protection = "yield";
      connector.provenance = { ...connector.provenance, protection: "default" };
      continue;
    }
    connector.signalGroupId = group.id;
    connector.protection = protectedIds.has(connector.id) ? "protected" : "permissive";
    connector.provenance = {
      ...connector.provenance,
      protection: "default",
      signalGroupId: "default",
    };
  }

  const pedGroupOf = new Map(groups.pedestrians.map((p) => [p.crosswalk.id, p.group.id] as const));
  for (const crosswalk of net.crosswalks) {
    if (crosswalk.nodeId !== controller.nodeId) continue;
    const groupId = pedGroupOf.get(crosswalk.id);
    if (groupId === undefined) delete crosswalk.signalGroupId;
    else crosswalk.signalGroupId = groupId;
  }

  const rest = net.signalControllers.filter((c) => c.nodeId !== controller.nodeId);
  rest.push(controller);
  rest.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  net.signalControllers = rest;
}

/**
 * A movement is protected when, in every phase where its group is green, all movements it conflicts
 * with are red (card T-08 §1); everything else is permissive and must accept gaps. The rule is
 * applied per connector, not per group, exactly as the synthetic plans of T-03 do it: a permissive
 * left does not turn the through movements sharing its main section into gap-accepting traffic.
 * Two conflicting movements that are green together are therefore both permissive, which makes
 * "no phase releases a conflicting pair of protected movements" true by construction.
 */
export function protectedConnectorIds(
  controller: SignalController,
  groupOfConnector: ReadonlyMap<string, SignalGroup>,
  connectorById: ReadonlyMap<string, Connector>,
): Set<string> {
  const greenTogether = new Map<string, Set<string>>();
  for (const group of controller.groups) greenTogether.set(group.id, new Set());
  for (const phase of controller.phases)
    for (const a of phase.greenGroupIds) {
      const set = greenTogether.get(a);
      if (set === undefined) continue;
      for (const b of phase.greenGroupIds) if (b !== a) set.add(b);
    }

  const out = new Set<string>();
  for (const group of controller.groups) {
    if (group.kind !== "vehicle") continue;
    const together = greenTogether.get(group.id) ?? new Set<string>();
    for (const id of group.connectorIds) {
      const connector = connectorById.get(id);
      if (connector === undefined) continue;
      let isProtected = true;
      for (const conflict of connector.conflicts) {
        const other = groupOfConnector.get(conflict.otherConnectorId);
        // A conflicting movement with no group of its own is never released by this controller.
        if (other === undefined || other.id === group.id) continue;
        if (together.has(other.id)) {
          isProtected = false;
          break;
        }
      }
      if (isProtected) out.add(id);
    }
  }
  return out;
}
