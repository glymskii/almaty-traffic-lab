import type { Network } from "@atl/contracts";

/**
 * Share of `provenance: "default"` attributes per category, computed directly from a loaded
 * `Network` (docs/tasks/T-23 п.6: "считается из provenance сети") - not from the compiler's
 * `data/networks/<id>.assumptions.json` sidecar, which the demo fallback network doesn't have.
 *
 * Keys mirror `ASSUMPTION_KINDS` (packages/map-data/src/compiler/assumptions.ts) so the two stay
 * readable side by side, but this list is shorter: a compiled `Network` only records provenance
 * per attribute name, not the compiler's finer-grained "which rule produced this default" kind,
 * so `left_pocket_default`/`pocket_length_default` collapse into one ("startS" on a turn-pocket
 * lane) and `bus_lane_position_assumed` (a one-off flag, never written to the network) is dropped.
 */
export type AssumptionKind =
  | "speed_limit_default"
  | "lane_count_default"
  | "turns_default"
  | "left_pocket_default"
  | "bus_lane_hours_default"
  | "merge_node_default"
  | "acceleration_lane_default"
  | "connector_priority_default"
  | "crosswalk_default"
  | "gate_weight_default"
  | "attractor_weight_default";

export interface AssumptionShare {
  kind: AssumptionKind;
  /** Entities in this category with provenance "default". */
  count: number;
  /** Entities in this category total (the share's denominator). */
  total: number;
  /** count / total, 0 when total is 0. */
  share: number;
}

function tally(
  defaultCount: number,
  total: number,
): { count: number; total: number; share: number } {
  return { count: defaultCount, total, share: total === 0 ? 0 : defaultCount / total };
}

/** Fixed order kept stable across runs so the legend doesn't reshuffle as the network updates. */
export function computeAssumptionShares(network: Network): AssumptionShare[] {
  const links = network.links;
  const lanes = network.lanes;
  const pockets = lanes.filter((lane) => lane.kind === "turn_pocket");
  const busLanes = lanes.filter((lane) => lane.kind === "bus");

  const entries: [AssumptionKind, { count: number; total: number; share: number }][] = [
    [
      "speed_limit_default",
      tally(links.filter((l) => l.provenance.speedLimitKph === "default").length, links.length),
    ],
    [
      "lane_count_default",
      tally(links.filter((l) => l.provenance.laneIds === "default").length, links.length),
    ],
    [
      "turns_default",
      tally(lanes.filter((l) => l.provenance.turns === "default").length, lanes.length),
    ],
    [
      "left_pocket_default",
      tally(pockets.filter((l) => l.provenance.startS === "default").length, pockets.length),
    ],
    [
      "bus_lane_hours_default",
      tally(
        busLanes.filter((l) => l.provenance.busLaneHours === "default").length,
        busLanes.length,
      ),
    ],
    // Merge nodes and acceleration lanes have no "osm" code path at all (packages/map-data's
    // merges.ts always writes provenance "default" for both) - the denominator is the category's
    // own population, not every node/lane, so the row reads "100% of the N merges are assumed"
    // instead of a near-zero, misleading share of the whole network.
    [
      "merge_node_default",
      tally(
        network.nodes.filter((n) => n.kind === "merge").length,
        network.nodes.filter((n) => n.kind === "merge").length,
      ),
    ],
    [
      "acceleration_lane_default",
      tally(
        lanes.filter((l) => l.provenance.endS === "default").length,
        lanes.filter((l) => l.provenance.endS === "default").length,
      ),
    ],
    [
      "connector_priority_default",
      tally(
        network.connectors.filter((c) => c.provenance.protection === "default").length,
        network.connectors.length,
      ),
    ],
    [
      "crosswalk_default",
      tally(
        network.crosswalks.filter((c) => c.provenance.geometry === "default").length,
        network.crosswalks.length,
      ),
    ],
    [
      "gate_weight_default",
      tally(
        network.gates.filter((g) => g.provenance.weightIn === "default").length,
        network.gates.length,
      ),
    ],
    [
      "attractor_weight_default",
      tally(
        network.attractors.filter((a) => a.provenance.weightIn === "default").length,
        network.attractors.length,
      ),
    ],
  ];

  return entries.filter(([, t]) => t.total > 0).map(([kind, t]) => ({ kind, ...t }));
}
