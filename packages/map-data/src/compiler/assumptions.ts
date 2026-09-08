import type { Network, NodeKind } from "@atl/contracts";

/**
 * Kinds of assumptions the generator makes (provenance "default"). Keys are stable identifiers;
 * the UI translates them (apps/web/src/i18n/ru.ts). Counting unit: links for link attributes,
 * lanes for lane attributes, and the entity itself for nodes, connectors, zebras, gates and
 * attractors.
 */
export const ASSUMPTION_KINDS = [
  "speed_limit_default",
  "lane_count_default",
  "turns_default",
  "left_pocket_default",
  "pocket_length_default",
  "bus_lane_hours_default",
  "bus_lane_position_assumed",
  "merge_node_default",
  "acceleration_lane_default",
  "connector_priority_default",
  "crosswalk_default",
  "signal_plan_default",
  "left_turn_protected_default",
  "left_turn_protected_permissive_default",
  "left_turn_permissive_default",
  "left_turn_prohibited_default",
  "gate_weight_default",
  "attractor_weight_default",
] as const;
export type AssumptionKind = (typeof ASSUMPTION_KINDS)[number];

export interface AssumptionEntry {
  kind: string;
  count: number;
  example: string;
}

export interface AssumptionCollector {
  add(kind: AssumptionKind, example: string): void;
  count(kind: AssumptionKind): number;
  /** Grouped counters in the fixed order of ASSUMPTION_KINDS, kinds with zero count omitted. */
  list(): AssumptionEntry[];
}

export function createAssumptionCollector(): AssumptionCollector {
  const counts = new Map<AssumptionKind, number>();
  const examples = new Map<AssumptionKind, string>();
  return {
    add(kind, example) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (!examples.has(kind)) examples.set(kind, example);
    },
    count(kind) {
      return counts.get(kind) ?? 0;
    },
    list() {
      const out: AssumptionEntry[] = [];
      for (const kind of ASSUMPTION_KINDS) {
        const count = counts.get(kind) ?? 0;
        if (count > 0) out.push({ kind, count, example: examples.get(kind) ?? "" });
      }
      return out;
    },
  };
}

export interface CompileStats {
  nodes: number;
  links: number;
  lanes: number;
  nodesByKind: Record<NodeKind, number>;
  /** Share of links whose speed limit is a default, 0..1. */
  speedDefaultShare: number;
  /** Share of links whose lane count is a default, 0..1. */
  laneCountDefaultShare: number;
  /** Share of lanes whose turns are a default, 0..1. */
  turnsDefaultShare: number;
  busLanes: number;
  pockets: number;
  totalLengthKm: number;
}

export function computeStats(net: Network): CompileStats {
  const nodesByKind: Record<NodeKind, number> = {
    junction: 0,
    signalized: 0,
    merge: 0,
    gate: 0,
    dead_end: 0,
    bend: 0,
  };
  for (const n of net.nodes) nodesByKind[n.kind] += 1;
  let speedDefault = 0;
  let laneCountDefault = 0;
  let lengthM = 0;
  for (const l of net.links) {
    if (l.provenance.speedLimitKph === "default") speedDefault += 1;
    if (l.provenance.laneIds === "default") laneCountDefault += 1;
    lengthM += l.lengthM;
  }
  let turnsDefault = 0;
  let busLanes = 0;
  let pockets = 0;
  for (const lane of net.lanes) {
    if (lane.provenance.turns === "default") turnsDefault += 1;
    if (lane.kind === "bus") busLanes += 1;
    if (lane.kind === "turn_pocket") pockets += 1;
  }
  const share = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000);
  return {
    nodes: net.nodes.length,
    links: net.links.length,
    lanes: net.lanes.length,
    nodesByKind,
    speedDefaultShare: share(speedDefault, net.links.length),
    laneCountDefaultShare: share(laneCountDefault, net.links.length),
    turnsDefaultShare: share(turnsDefault, net.lanes.length),
    busLanes,
    pockets,
    totalLengthKm: Math.round(lengthM / 100) / 10,
  };
}
