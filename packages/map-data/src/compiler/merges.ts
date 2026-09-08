import type { HighwayClass, Lane, Link, Network, Point2 } from "@atl/contracts";
import { crossZ, headingAtStart, signedAngleDeg } from "../geometry/angles.ts";
import { round } from "../geometry/polyline.ts";
import type { AssumptionCollector } from "./assumptions.ts";
import type { Arm, NodeMovements } from "./movements.ts";
import type { Warn } from "./tags.ts";
import { HIGHWAY_CLASS_RANK } from "./topology.ts";

/** A ramp joining a carriageway at a smaller angle than this is a merge, not an intersection. */
export const MERGE_MAX_ANGLE_DEG = 35;
/** Length of an acceleration lane where the main carriageway gains a lane at the merge. */
export const ACCELERATION_LANE_M = 300;

/** Classes a ramp may merge into. */
const MAIN_CLASSES: ReadonlySet<HighwayClass> = new Set<HighwayClass>([
  "trunk",
  "trunk_link",
  "primary",
]);

function isRampClass(cls: HighwayClass): boolean {
  return cls.endsWith("_link");
}

/** One recognised merge: which arm is the ramp and which links form the carriageway it joins. */
interface MergeShape {
  rampArm: Arm;
  ramp: Link;
  mainOutArm: Arm;
  mainIn: Link;
  mainOut: Link;
  mainHeading: Point2;
}

export interface MergeInput {
  net: Network;
  byNode: ReadonlyMap<string, NodeMovements>;
  assumptions: AssumptionCollector;
  warn: Warn;
}

/** Node ids turned into merges, so the conflict stage can hand out `yield` / `priority` after it. */
export interface MergeResult {
  nodeIds: Set<string>;
}

function soleInLink(arm: Arm): Link | undefined {
  if (arm.outLinks.length > 0 || arm.inLinks.length !== 1) return undefined;
  return arm.inLinks[0];
}

/**
 * Turns 3-arm junctions where a slip road or a minor street flows into a trunk/primary
 * carriageway into `merge` nodes (card T-07 §4): the ramp lanes get `turns: [merge]`, and where
 * the main carriageway gains a lane the extra right lane becomes an acceleration lane.
 */
export function applyMerges(input: MergeInput): MergeResult {
  const { net, byNode, assumptions, warn } = input;
  const laneById = new Map(net.lanes.map((l) => [l.id, l] as const));
  const nodeIds = new Set<string>();

  for (const node of net.nodes) {
    if (node.kind !== "junction") continue;
    const movements = byNode.get(node.id);
    if (movements === undefined || movements.degree !== 3) continue;

    const found = movements.arms
      .map((arm) => describeMerge(arm, movements))
      .filter((m): m is MergeShape => m !== undefined);
    if (found.length !== 1) continue;
    const shape = found[0] as MergeShape;

    // A ramp joining from the left would have to cross the oncoming carriageway first.
    const oncoming = shape.mainOutArm.inLinks.length > 0;
    if (oncoming && crossZ(shape.mainHeading, shape.rampArm.direction) >= 0) {
      warn(
        `node ${node.id}: ramp ${shape.ramp.id} joins ${shape.mainOut.id} from the left across oncoming traffic; kept as a junction`,
      );
      continue;
    }

    node.kind = "merge";
    nodeIds.add(node.id);
    assumptions.add("merge_node_default", node.id);
    for (const laneId of shape.ramp.laneIds) {
      const lane = laneById.get(laneId);
      if (lane === undefined) continue;
      lane.turns = ["merge"];
      lane.provenance = { ...lane.provenance, turns: "default" };
    }
    addAccelerationLane(shape.mainIn, shape.mainOut, laneById, assumptions);
  }
  return { nodeIds };
}

/**
 * Reads one arm of a 3-arm node as the ramp of a merge: it must be a one-way approach of a lesser
 * class than the carriageway that continues through the node, and join it at a shallow angle.
 * Both ways of splitting the other two arms into "carriageway in" and "carriageway out" are tried;
 * the straighter one wins.
 */
function describeMerge(rampArm: Arm, movements: NodeMovements): MergeShape | undefined {
  const ramp = soleInLink(rampArm);
  if (ramp === undefined) return undefined;
  const approach = movements.approaches.find((a) => a.link.id === ramp.id);
  if (approach === undefined) return undefined;
  const others = movements.arms.filter((a) => a !== rampArm);
  const [first, second] = others;
  if (first === undefined || second === undefined) return undefined;

  let best: MergeShape | undefined;
  let bestAngle = MERGE_MAX_ANGLE_DEG;
  for (const [mainOutArm, mainInArm] of [
    [first, second],
    [second, first],
  ] as [Arm, Arm][]) {
    const mainOut = mainOutArm.outLinks.find((l) => MAIN_CLASSES.has(l.highwayClass));
    if (mainOut === undefined) continue;
    const mainRank = HIGHWAY_CLASS_RANK[mainOut.highwayClass];
    const mainIn = mainInArm.inLinks.find(
      (l) => MAIN_CLASSES.has(l.highwayClass) && HIGHWAY_CLASS_RANK[l.highwayClass] <= mainRank,
    );
    if (mainIn === undefined) continue;
    if (!isRampClass(ramp.highwayClass) && HIGHWAY_CLASS_RANK[ramp.highwayClass] <= mainRank)
      continue;
    const mainHeading = headingAtStart(mainOut.geometry);
    const angle = Math.abs(signedAngleDeg(approach.heading, mainHeading));
    if (angle >= bestAngle) continue;
    bestAngle = angle;
    best = { rampArm, ramp, mainOutArm, mainIn, mainOut, mainHeading };
  }
  return best;
}

/** The lanes the main carriageway gains at the merge run out after `ACCELERATION_LANE_M`. */
function addAccelerationLane(
  mainIn: Link,
  mainOut: Link,
  laneById: ReadonlyMap<string, Lane>,
  assumptions: AssumptionCollector,
): void {
  const gained = mainOut.laneIds.length - mainIn.laneIds.length;
  if (gained <= 0) return;
  const endS = round(Math.min(ACCELERATION_LANE_M, mainOut.lengthM));
  if (endS >= mainOut.lengthM) return;
  for (let k = 0; k < gained; k++) {
    const laneId = mainOut.laneIds[mainOut.laneIds.length - 1 - k];
    const lane = laneId === undefined ? undefined : laneById.get(laneId);
    if (lane === undefined || lane.kind !== "general") continue;
    lane.endS = endS;
    lane.turns = ["merge"];
    lane.provenance = { ...lane.provenance, endS: "default", turns: "default" };
    assumptions.add("acceleration_lane_default", lane.id);
  }
}

/** After the conflict stage: the ramp gives way, the carriageway it joins keeps priority. */
export function applyMergeProtection(net: Network, merges: MergeResult): void {
  if (merges.nodeIds.size === 0) return;
  for (const connector of net.connectors) {
    if (!merges.nodeIds.has(connector.viaNodeId)) continue;
    connector.protection = connector.turn === "merge" ? "yield" : "priority";
  }
}
