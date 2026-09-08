import type { Gate, HighwayClass, Link, Network } from "@atl/contracts";
import type { AssumptionCollector } from "./assumptions.ts";
import type { NodeMovements } from "./movements.ts";
import type { Warn } from "./tags.ts";

/**
 * Demand weight of one lane of each class (card T-07 §6). A `*_link` ramp carries the traffic of
 * the road it serves, so it takes the weight of its base class; `service` is negligible.
 */
export const GATE_CLASS_WEIGHT: Record<HighwayClass, number> = {
  trunk: 3,
  trunk_link: 3,
  primary: 2,
  primary_link: 2,
  secondary: 1.2,
  secondary_link: 1.2,
  tertiary: 0.6,
  tertiary_link: 0.6,
  residential: 0.2,
  unclassified: 0.2,
  living_street: 0.05,
  service: 0.05,
};

/**
 * A junction sitting right on the bbox boundary leaves a stub of a few centimetres between it and
 * the gate (see the T-02 notes on card T-07). Such a gate cannot hold a queue, so it is kept for
 * referential integrity but never used as a source or a sink.
 */
export const GATE_MIN_LINK_M = 5;

export interface GateInput {
  net: Network;
  byNode: ReadonlyMap<string, NodeMovements>;
  assumptions: AssumptionCollector;
  warn: Warn;
}

function weightOf(links: readonly Link[]): number {
  let w = 0;
  for (const link of links) w += GATE_CLASS_WEIGHT[link.highwayClass] * link.laneIds.length;
  return Math.round(w * 1000) / 1000;
}

/** One `Gate` per `kind: gate` node, with demand weights derived from class and lane count. */
export function buildGates(input: GateInput): Gate[] {
  const { net, byNode, assumptions, warn } = input;
  const gates: Gate[] = [];
  for (const node of net.nodes) {
    if (node.kind !== "gate") continue;
    const movements = byNode.get(node.id);
    if (movements === undefined) continue;
    const inLinks = movements.exits.map((e) => e.link);
    const outLinks = movements.approaches.map((a) => a.link);
    const all = [...inLinks, ...outLinks];
    const tooShort = all.length > 0 && all.every((l) => l.lengthM < GATE_MIN_LINK_M);
    if (tooShort)
      warn(
        `node ${node.id}: gate only ${all[0]?.lengthM ?? 0} m from a junction; weights set to 0 (no traffic is born or removed here)`,
      );
    const gate: Gate = {
      id: `${node.id}.gate`,
      nodeId: node.id,
      inLinkIds: inLinks.map((l) => l.id),
      outLinkIds: outLinks.map((l) => l.id),
      weightIn: tooShort ? 0 : weightOf(inLinks),
      weightOut: tooShort ? 0 : weightOf(outLinks),
      provenance: { weightIn: "default", weightOut: "default" },
    };
    assumptions.add("gate_weight_default", gate.id);
    gates.push(gate);
  }
  gates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return gates;
}
