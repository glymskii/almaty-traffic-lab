import type { Lane, Link, Network, NetworkNode, Point2, TurnKind } from "@atl/contracts";
import {
  classifyTurn,
  headingAtEnd,
  headingAtStart,
  idealAngleDeg,
  negate,
  normalizeVec,
  signedAngleDeg,
} from "../geometry/angles.ts";

/** A lane may only be a connector's source if it still exists at the end of its link. */
export const LANE_END_EPS_M = 0.5;
/** A lane may only be a connector's target if it already exists at the start of its link. */
export const LANE_START_EPS_M = 0.01;

/** One incoming link of a node, with everything the connector builder needs about it. */
export interface Approach {
  link: Link;
  lanes: Lane[];
  /** Unit direction of travel where the link meets the node. */
  heading: Point2;
  /** Last point of the link centreline. */
  point: Point2;
  /** Node at the far end of the link. */
  neighbourId: string;
}

/** One outgoing link of a node. */
export interface Exit {
  link: Link;
  lanes: Lane[];
  /** Unit direction of travel where the link leaves the node. */
  heading: Point2;
  /** First point of the link centreline. */
  point: Point2;
  neighbourId: string;
}

/** One street end at a node: all links to and from the same neighbour. */
export interface Arm {
  neighbourId: string;
  /** Unit vector pointing from the node towards the neighbour. */
  direction: Point2;
  inLinks: Link[];
  outLinks: Link[];
  /** Total carriageway width of both directions. */
  widthM: number;
}

export interface NodeMovements {
  node: NetworkNode;
  /** Sorted by link id. */
  approaches: Approach[];
  /** Sorted by link id. */
  exits: Exit[];
  /** Sorted by neighbour node id. */
  arms: Arm[];
  /** Number of arms: the topological degree of the node. */
  degree: number;
}

/** An exit seen from one approach: which way the movement turns and by how much. */
export interface ExitOption {
  exit: Exit;
  /** Signed angle from the approach heading to the exit heading, degrees. */
  angleDeg: number;
  turn: TurnKind;
}

export function indexLanes(net: Network): Map<string, Lane> {
  return new Map(net.lanes.map((l) => [l.id, l] as const));
}

function lanesOf(link: Link, byId: Map<string, Lane>): Lane[] {
  const out: Lane[] = [];
  for (const id of link.laneIds) {
    const lane = byId.get(id);
    if (lane !== undefined) out.push(lane);
  }
  return out;
}

/** Lanes that reach the node and may start a movement (an acceleration lane ends earlier). */
export function sourceLanes(approach: Approach): Lane[] {
  return approach.lanes.filter((l) => l.endS >= approach.link.lengthM - LANE_END_EPS_M);
}

/** Lanes that already exist at the node and may receive a movement (a pocket opens later). */
export function targetLanes(exit: Exit): Lane[] {
  return exit.lanes.filter((l) => l.startS <= LANE_START_EPS_M);
}

/** Approaches, exits and arms of every node, keyed by node id. Deterministic order everywhere. */
export function buildNodeMovements(net: Network): Map<string, NodeMovements> {
  const laneById = indexLanes(net);
  const byNode = new Map<string, NodeMovements>();
  for (const node of net.nodes) {
    byNode.set(node.id, { node, approaches: [], exits: [], arms: [], degree: 0 });
  }
  const links = [...net.links].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const link of links) {
    const lanes = lanesOf(link, laneById);
    const to = byNode.get(link.toNodeId);
    if (to !== undefined) {
      to.approaches.push({
        link,
        lanes,
        heading: headingAtEnd(link.geometry),
        point: link.geometry[link.geometry.length - 1] as Point2,
        neighbourId: link.fromNodeId,
      });
    }
    const from = byNode.get(link.fromNodeId);
    if (from !== undefined) {
      from.exits.push({
        link,
        lanes,
        heading: headingAtStart(link.geometry),
        point: link.geometry[0] as Point2,
        neighbourId: link.toNodeId,
      });
    }
  }
  for (const movements of byNode.values()) {
    movements.arms = buildArms(movements);
    movements.degree = movements.arms.length;
  }
  return byNode;
}

function buildArms(movements: NodeMovements): Arm[] {
  const byNeighbour = new Map<string, { dirs: Point2[]; arm: Arm }>();
  const entry = (neighbourId: string) => {
    let e = byNeighbour.get(neighbourId);
    if (e === undefined) {
      e = {
        dirs: [],
        arm: { neighbourId, direction: [1, 0], inLinks: [], outLinks: [], widthM: 0 },
      };
      byNeighbour.set(neighbourId, e);
    }
    return e;
  };
  for (const a of movements.approaches) {
    const e = entry(a.neighbourId);
    e.arm.inLinks.push(a.link);
    e.arm.widthM += widthOf(a.lanes);
    e.dirs.push(negate(a.heading));
  }
  for (const x of movements.exits) {
    const e = entry(x.neighbourId);
    e.arm.outLinks.push(x.link);
    e.arm.widthM += widthOf(x.lanes);
    e.dirs.push(x.heading);
  }
  const arms: Arm[] = [];
  for (const key of [...byNeighbour.keys()].sort()) {
    const e = byNeighbour.get(key);
    if (e === undefined) continue;
    let sx = 0;
    let sy = 0;
    for (const d of e.dirs) {
      sx += d[0];
      sy += d[1];
    }
    const dir = normalizeVec([sx, sy]);
    e.arm.direction = dir[0] === 0 && dir[1] === 0 ? (e.dirs[0] ?? [1, 0]) : dir;
    arms.push(e.arm);
  }
  return arms;
}

function widthOf(lanes: readonly Lane[]): number {
  let w = 0;
  for (const lane of lanes) w += lane.widthM;
  return w;
}

/**
 * Exits reachable from one approach with their turn kind. The exit back along the arm the vehicle
 * came from is always a u-turn, whatever the geometry says about it.
 */
export function exitOptions(approach: Approach, movements: NodeMovements): ExitOption[] {
  const out: ExitOption[] = [];
  for (const exit of movements.exits) {
    if (exit.link.id === approach.link.id) continue;
    const angleDeg = signedAngleDeg(approach.heading, exit.heading);
    const turn = exit.neighbourId === approach.neighbourId ? "uturn" : classifyTurn(angleDeg);
    out.push({ exit, angleDeg, turn });
  }
  return out;
}

/**
 * Best exit for a turn kind: the one whose angle is closest to the ideal angle of that turn.
 * A merge follows the straightest exit even when the ramp meets it beyond the through corridor
 * (a slip road joins at up to 35 deg, see card T-07 §4).
 */
export function pickExit(turn: TurnKind, options: readonly ExitOption[]): ExitOption | undefined {
  const straightest = turn === "merge" || turn === "diverge";
  const wanted: TurnKind = straightest ? "through" : turn;
  const ideal = idealAngleDeg(wanted);
  let best: ExitOption | undefined;
  for (const option of options) {
    if (straightest ? option.turn === "uturn" : option.turn !== wanted) continue;
    if (best === undefined) {
      best = option;
      continue;
    }
    const d = Math.abs(Math.abs(option.angleDeg) - Math.abs(ideal));
    const bd = Math.abs(Math.abs(best.angleDeg) - Math.abs(ideal));
    if (d < bd || (d === bd && option.exit.link.id < best.exit.link.id)) best = option;
  }
  return best;
}
