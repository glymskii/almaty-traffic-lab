import type { Connector, Lane, Network, Point2, TurnKind, VehicleClass } from "@atl/contracts";
import { polylineLength } from "@atl/contracts";
import { idealAngleDeg } from "../geometry/angles.ts";
import { cubicBezierPolyline, laneCentrePoint } from "../geometry/bezier.ts";
import { round, roundPolyline } from "../geometry/polyline.ts";
import {
  type Approach,
  type Exit,
  type ExitOption,
  exitOptions,
  type NodeMovements,
  pickExit,
  sourceLanes,
  targetLanes,
} from "./movements.ts";

/** Movements are generated in this order so connector ids come out in a stable sequence. */
const TURN_ORDER: TurnKind[] = ["left", "through", "right", "merge", "uturn", "diverge"];

/** A connector shorter than this (two lane ends that coincide) still needs a positive length. */
const MIN_CONNECTOR_LENGTH_M = 0.05;

export function connectorId(fromLaneId: string, toLaneId: string): string {
  return `${fromLaneId}>${toLaneId}`;
}

/** A lane that admits cars must not feed a bus lane; otherwise any shared class is enough. */
function isAccessible(from: Lane, to: Lane): boolean {
  const carrying: VehicleClass = "car";
  if (from.allowed.includes(carrying)) return to.allowed.includes(carrying);
  return from.allowed.some((c) => to.allowed.includes(c));
}

/** Nearest target to `index` that the source lane's classes may legally enter (card T-07 §2). */
function accessibleTarget(targets: readonly Lane[], index: number, from: Lane): number {
  if (targets.length === 0) return -1;
  const start = Math.max(0, Math.min(targets.length - 1, index));
  for (let d = 0; d < targets.length; d++) {
    for (const j of d === 0 ? [start] : [start - d, start + d]) {
      const lane = targets[j];
      if (lane !== undefined && isAccessible(from, lane)) return j;
    }
  }
  return start;
}

interface PairPlan {
  from: Lane;
  to: Lane;
}

/** An acceleration lane only accepts merging traffic; nothing else may be steered into it. */
function isAccelerationLane(lane: Lane): boolean {
  return lane.turns.length === 1 && lane.turns[0] === "merge";
}

/**
 * Target lanes open to one kind of movement: merges take the acceleration lane, others avoid it.
 * A street whose only lane is marked `merge` (OSM `turn:lanes=merge_to_left`, not an acceleration
 * lane the compiler opened) would otherwise be unreachable, so an empty result falls back to all
 * of the lanes.
 */
function movementTargets(targets: readonly Lane[], turn: TurnKind): Lane[] {
  if (turn !== "merge") {
    const ordinary = targets.filter((l) => !isAccelerationLane(l));
    return ordinary.length > 0 ? ordinary : [...targets];
  }
  const accelerating = targets.filter(isAccelerationLane);
  return accelerating.length > 0 ? accelerating : [...targets];
}

/**
 * Through movements: a lane keeps its distance from the right kerb. Exit lanes nobody reached
 * (the street widens) are fed from the nearest approach lane.
 */
function planThrough(sources: readonly Lane[], targets: readonly Lane[], nIn: number): PairPlan[] {
  const nOut = targets.length;
  const plans: PairPlan[] = [];
  const used = new Set<number>();
  for (const from of sources) {
    const rightOffset = nIn - 1 - from.index;
    const j = accessibleTarget(targets, nOut - 1 - rightOffset, from);
    const to = targets[j];
    if (to === undefined) continue;
    plans.push({ from, to });
    used.add(j);
  }
  for (let j = 0; j < nOut; j++) {
    if (used.has(j)) continue;
    const to = targets[j];
    if (to === undefined) continue;
    const wantedIndex = nIn - 1 - (nOut - 1 - j);
    let best: Lane | undefined;
    for (const from of sources) {
      if (!isAccessible(from, to)) continue;
      if (
        best === undefined ||
        Math.abs(from.index - wantedIndex) < Math.abs(best.index - wantedIndex)
      )
        best = from;
    }
    if (best !== undefined) plans.push({ from: best, to });
  }
  return plans;
}

/** Turns pair off from one kerb: left turns from the left, right turns and merges from the right. */
function planSideBySide(
  sources: readonly Lane[],
  targets: readonly Lane[],
  fromRight: boolean,
): PairPlan[] {
  const src = fromRight ? [...sources].reverse() : [...sources];
  const tgt = fromRight ? [...targets].reverse() : [...targets];
  const plans: PairPlan[] = [];
  for (let k = 0; k < src.length; k++) {
    const from = src[k];
    if (from === undefined) continue;
    const wanted = Math.min(k, tgt.length - 1);
    const j = accessibleTarget(tgt, wanted, from);
    const to = tgt[j];
    if (to === undefined) continue;
    plans.push({ from, to });
  }
  return plans;
}

/**
 * Every exit a movement of this kind may take, straightest first. A node can offer two exits of
 * the same kind — a fork with two through arms, a five-way junction with two lefts — and keeping
 * only the straightest one would leave the other street unreachable from the node. `merge` and
 * `diverge` are never produced by the angle classifier, so they still follow the single
 * straightest exit.
 */
function exitsForTurn(turn: TurnKind, options: readonly ExitOption[]): ExitOption[] {
  if (turn === "merge" || turn === "diverge") {
    const one = pickExit(turn, options);
    return one === undefined ? [] : [one];
  }
  const ideal = idealAngleDeg(turn);
  return options
    .filter((o) => o.turn === turn)
    .sort((a, b) => {
      const d = Math.abs(a.angleDeg - ideal) - Math.abs(b.angleDeg - ideal);
      if (d !== 0) return d;
      return a.exit.link.id < b.exit.link.id ? -1 : 1;
    });
}

function laneEndPoint(approach: Approach, lane: Lane): Point2 {
  return laneCentrePoint(
    approach.point,
    approach.heading,
    lane.index,
    approach.link.laneIds.length,
    lane.widthM,
  );
}

function laneStartPoint(exit: Exit, lane: Lane): Point2 {
  return laneCentrePoint(
    exit.point,
    exit.heading,
    lane.index,
    exit.link.laneIds.length,
    lane.widthM,
  );
}

/**
 * Lane-to-lane movements of every node except gates (card T-07 §2). A movement is generated only
 * when the approach lane permits that turn, so `Lane.turns` fully controls what exists.
 */
export function buildConnectors(
  net: Network,
  byNode: ReadonlyMap<string, NodeMovements>,
): Connector[] {
  const connectors: Connector[] = [];
  const seen = new Set<string>();
  for (const node of net.nodes) {
    if (node.kind === "gate") continue;
    const movements = byNode.get(node.id);
    if (movements === undefined) continue;
    for (const approach of movements.approaches) {
      const options = exitOptions(approach, movements);
      if (options.length === 0) continue;
      const sources = sourceLanes(approach);
      for (const turn of TURN_ORDER) {
        const turning = sources.filter((l) => l.turns.includes(turn));
        if (turning.length === 0) continue;
        for (const chosen of exitsForTurn(turn, options)) {
          const targets = movementTargets(targetLanes(chosen.exit), turn);
          if (targets.length === 0) continue;
          const plans =
            turn === "through"
              ? planThrough(turning, targets, approach.link.laneIds.length)
              : planSideBySide(turning, targets, turn === "right" || turn === "merge");
          for (const plan of plans) {
            const id = connectorId(plan.from.id, plan.to.id);
            if (seen.has(id)) continue;
            seen.add(id);
            const geometry = roundPolyline(
              cubicBezierPolyline(
                laneEndPoint(approach, plan.from),
                approach.heading,
                laneStartPoint(chosen.exit, plan.to),
                chosen.exit.heading,
              ),
            );
            connectors.push({
              id,
              fromLaneId: plan.from.id,
              toLaneId: plan.to.id,
              viaNodeId: node.id,
              turn,
              geometry,
              lengthM: Math.max(round(polylineLength(geometry)), MIN_CONNECTOR_LENGTH_M),
              protection: "yield",
              conflicts: [],
              crosswalkIds: [],
              provenance: { protection: "default" },
            });
          }
        }
      }
    }
  }
  connectors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return connectors;
}
