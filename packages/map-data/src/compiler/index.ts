import { createHash } from "node:crypto";
import {
  checkNetworkIntegrity,
  type Network,
  type NetworkOverride,
  parseNetwork,
  SCHEMA_VERSION,
  type SimConfig,
} from "@atl/contracts";
import { type BBoxPreset, bboxCentre } from "../bboxes.ts";
import type { OsmSnapshot } from "../importer/index.ts";
import { createProjection } from "../projection.ts";
import { runSignals } from "../signals/index.ts";
import {
  type AssumptionEntry,
  type CompileStats,
  computeStats,
  createAssumptionCollector,
} from "./assumptions.ts";
import { runIntersections } from "./intersections.ts";
import { buildLinks, type LinkLevel, type WayLinks } from "./links.ts";
import { buildOsmGraph } from "./osm-graph.ts";
import { applyOverrides as applyOverridesImpl } from "./overrides.ts";
import { type CompileContext, LATER_STAGES, runLaterStages } from "./stages.ts";
import { buildTopology } from "./topology.ts";
import { runTransit } from "./transit.ts";

export const GENERATOR = "@atl/map-data compiler 0.0.1";

/** Stage registry wiring: `stages.ts` stays free of runtime imports of the stage modules. */
const intersectionsStage = LATER_STAGES.find((s) => s.name === "intersections");
if (intersectionsStage !== undefined) intersectionsStage.run = runIntersections;
const signalsStage = LATER_STAGES.find((s) => s.name === "signals");
if (signalsStage !== undefined) signalsStage.run = runSignals;
const transitStage = LATER_STAGES.find((s) => s.name === "transit");
if (transitStage !== undefined) transitStage.run = runTransit;

export interface CompileOptions {
  bbox: BBoxPreset;
  snapshot: OsmSnapshot;
  /** Signal plan generator and defaults read timing constants from here. */
  config: SimConfig;
  /** Scenario overrides applied after generation. */
  overrides?: NetworkOverride[];
  /** Fixed value for meta.generatedAt so output is byte-stable across runs (tests, regression). */
  generatedAt?: string;
}

export interface CompileReport {
  network: Network;
  /** Human-readable assumptions made ("default" provenance), grouped by kind, for the UI legend and QA. */
  assumptions: AssumptionEntry[];
  warnings: string[];
  stats: CompileStats;
  /** Bridges, tunnels and `layer` per link id (ground-level links omitted); T-07 uses it to skip conflicts between levels. */
  linkLevels: Record<string, LinkLevel>;
  /** OSM way id -> links in order along the way (forward = node order, backward = against it); for T-17 route relations. */
  wayLinks: Record<number, WayLinks>;
}

export type { AssumptionEntry, AssumptionKind, CompileStats } from "./assumptions.ts";
export { ASSUMPTION_KINDS } from "./assumptions.ts";
export { ATTRACTOR_SEARCH_M, DEAD_END_WEIGHT } from "./attractors.ts";
export { RULE_CONFLICT_NEAR_M } from "./conflicts.ts";
export { connectorId } from "./connectors.ts";
export { CROSSING_ATTACH_M } from "./crosswalks.ts";
export { APPROACH_FROM_RU, approachCompassIndex, describeApproach } from "./describe.ts";
export { GATE_CLASS_WEIGHT, GATE_MIN_LINK_M } from "./gates.ts";
export {
  DEFAULT_LANES_PER_DIRECTION,
  defaultTurns,
  LANE_WIDTH_M,
  parseTurnLanes,
} from "./lanes.ts";
export type { LinkLevel, WayLinks } from "./links.ts";
export { ACCELERATION_LANE_M, MERGE_MAX_ANGLE_DEG } from "./merges.ts";
export type { Approach, Arm, Exit, NodeMovements } from "./movements.ts";
export { buildNodeMovements } from "./movements.ts";
export { DEFAULT_SPEED_KPH, parseMaxspeed } from "./speeds.ts";
export type { CompileContext, CompileStage } from "./stages.ts";
export { LATER_STAGES } from "./stages.ts";
export { HIGHWAY_CLASS_RANK, SIGNAL_COLLAPSE_M } from "./topology.ts";
export {
  DEFAULT_HEADWAY_OFFPEAK_S,
  DEFAULT_HEADWAY_PEAK_S,
  parseIntervalMinutes,
  STOP_ATTACH_M,
} from "./transit.ts";

/** sha256 of the snapshot's JSON form, recorded as meta.sourceHash. */
export function snapshotHash(snapshot: OsmSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

/**
 * OSM snapshot -> Network. Pipeline (each stage is a task, see docs/PLAN.md):
 *   topology (T-02) -> lanes & speeds (T-02) -> intersections, connectors, conflicts, crosswalks, gates, attractors (T-07)
 *   -> signal plans (T-08) -> bus routes & stops (T-17) -> city layers (T-27) -> overrides (T-24) -> integrity check.
 * Deterministic: the same snapshot gives the same network byte for byte (fix `generatedAt`).
 */
export function compileNetwork(opts: CompileOptions): CompileReport {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (message: string) => {
    if (seen.has(message)) return;
    seen.add(message);
    warnings.push(message);
  };
  const assumptions = createAssumptionCollector();
  const projection = createProjection(bboxCentre(opts.bbox));

  const graph = buildOsmGraph(opts.snapshot, opts.bbox, projection, warn);
  const topology = buildTopology(graph, warn);
  const built = buildLinks(topology, assumptions);

  const { snapshot, bbox } = opts;
  const osmSnapshotAt = snapshot.osmTimestamp ?? (snapshot.fetchedAt || undefined);
  const network: Network = {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      networkId: bbox.id,
      bboxId: bbox.id,
      bbox: { south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east },
      origin: projection.origin,
      generatedAt: opts.generatedAt ?? new Date().toISOString(),
      generator: GENERATOR,
      ...(osmSnapshotAt !== undefined ? { osmSnapshotAt } : {}),
      sourceHash: snapshotHash(snapshot),
    },
    nodes: built.nodes,
    links: built.links,
    lanes: built.lanes,
    connectors: [],
    crosswalks: [],
    signalControllers: [],
    busStops: [],
    busRoutes: [],
    gates: [],
    attractors: [],
    buildings: [],
    areas: [],
    waterways: [],
  };

  const ctx: CompileContext = {
    opts,
    projection,
    graph,
    network,
    linkLevels: built.linkLevels,
    wayLinks: built.wayLinks,
    assumptions,
    warn,
  };
  runLaterStages(ctx);

  const parsed = parseNetwork(ctx.network);
  const errors = checkNetworkIntegrity(parsed);
  if (errors.length > 0) {
    const shown = errors.slice(0, 20).join("\n");
    throw new Error(`compiled network failed the integrity check (${errors.length}):\n${shown}`);
  }
  return {
    network: parsed,
    assumptions: assumptions.list(),
    warnings,
    stats: computeStats(parsed),
    linkLevels: ctx.linkLevels,
    wayLinks: ctx.wayLinks,
  };
}

/**
 * Re-applies scenario overrides to an already compiled network (T-24). The implementation lives in
 * `./overrides.ts`, which the browser also reaches directly via the `@atl/map-data/overrides`
 * subpath export (package.json) so it never has to load this module's `node:crypto` import or the
 * OSM importer the rest of the package barrel pulls in.
 */
export function applyOverrides(
  network: Network,
  overrides: NetworkOverride[],
  config: SimConfig,
  scenarioId?: string,
): Network {
  return applyOverridesImpl(network, overrides, config, scenarioId);
}
