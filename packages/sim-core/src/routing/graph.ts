import type { Network } from "@atl/contracts";
import { cycleLengthS } from "@atl/contracts";
import { MERGE_ROUTING_PENALTY_S } from "../runtime/merges.ts";
import type { RuntimeNetwork } from "../runtime/network.ts";
import { TURN_COUNT, TurnCode } from "../runtime/turns.ts";

/**
 * Manoeuvre penalties in seconds (T-12). They are what makes a route prefer a straight run over a
 * chain of turns even when the turns are geometrically shorter.
 */
export const TURN_PENALTY_S = new Float64Array(TURN_COUNT);
TURN_PENALTY_S[TurnCode.through] = 0;
TURN_PENALTY_S[TurnCode.left] = 8;
TURN_PENALTY_S[TurnCode.right] = 3;
TURN_PENALTY_S[TurnCode.uturn] = 20;
TURN_PENALTY_S[TurnCode.merge] = MERGE_ROUTING_PENALTY_S;
TURN_PENALTY_S[TurnCode.diverge] = 0;

/** Route costs assume traffic actually runs at this share of the speed limit. */
export const ROUTING_SPEED_FACTOR = 0.9;

/**
 * Routing graph over **links** (a node of the graph is one direction of a street; an edge is a
 * permitted movement through a junction). Built once next to `RuntimeNetwork` and never mutated:
 * congestion changes the *costs* (`RouteTrees`), never the topology.
 *
 * An edge exists for a pair (fromLink, toLink) when at least one connector between them
 *  - admits the routing class, and
 *  - is not `IntersectionRuntime.connProhibited` (a movement at a signalized node with no signal
 *    group: no phase ever releases it, so a route through it would stand at the stop line forever,
 *    see the notes of T-08/T-11).
 *
 * Several connectors may join the same pair of links (one per lane, or a left and a u-turn onto the
 * same street); the graph keeps the cheapest of them, so the cost is what the best driver can do.
 *
 * Edge cost = `freeTravelS[fromLink] + edgeExtraS[edge]`, where the extra part is the manoeuvre
 * penalty plus the expected wait at a signalized node (half a cycle times the red share). Splitting
 * it this way lets navigator trees replace the travel part with a measured one (`liveCost`) while
 * keeping the penalties, without rebuilding the graph.
 */
export class RoutingGraph {
  readonly linkCount: number;
  readonly edgeCount: number;
  /** CSR over links: outgoing edges of link L are [edgeStart[L], edgeStart[L + 1]). */
  readonly edgeStart: Int32Array;
  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeTurn: Uint8Array;
  /** Manoeuvre penalty plus expected signal delay of the edge, seconds. */
  readonly edgeExtraS: Float64Array;
  /** CSR of incoming edge indices per link (for the backward Dijkstra). */
  readonly inStart: Int32Array;
  readonly inEdges: Int32Array;
  /** Free-flow traversal time of every link at `ROUTING_SPEED_FACTOR` of its limit, seconds. */
  readonly freeTravelS: Float64Array;

  constructor(net: Network, rt: RuntimeNetwork, connProhibited: Uint8Array, clsCode: number) {
    const linkCount = rt.linkCount;
    this.linkCount = linkCount;
    this.freeTravelS = new Float64Array(linkCount);
    for (let l = 0; l < linkCount; l++) {
      const speed = (rt.linkSpeedMps[l] as number) * ROUTING_SPEED_FACTOR;
      this.freeTravelS[l] = speed > 0 ? (rt.linkLengthM[l] as number) / speed : 0;
    }

    const signalDelayS = expectedSignalDelayByGroup(net);
    const bit = 1 << clsCode;
    // (fromLink * linkCount + toLink) -> slot in the temporary edge arrays; the cheapest wins.
    const slotOf = new Map<number, number>();
    const tmpFrom: number[] = [];
    const tmpTo: number[] = [];
    const tmpTurn: number[] = [];
    const tmpExtra: number[] = [];
    for (let c = 0; c < rt.connectorCount; c++) {
      const t = rt.laneCount + c;
      if (connProhibited[t] === 1) continue;
      if (((rt.trackAllowedMask[t] as number) & bit) === 0) continue;
      const fromLink = rt.trackLink[rt.connFromLane[c] as number] as number;
      const toLink = rt.trackLink[rt.connToLane[c] as number] as number;
      if (fromLink < 0 || toLink < 0) continue;
      const turn = rt.connTurn[t] as number;
      const group = rt.connSignalGroup[t] as number;
      const extra =
        (TURN_PENALTY_S[turn] as number) + (group >= 0 ? (signalDelayS[group] as number) : 0);
      const key = fromLink * linkCount + toLink;
      const slot = slotOf.get(key);
      if (slot === undefined) {
        slotOf.set(key, tmpFrom.length);
        tmpFrom.push(fromLink);
        tmpTo.push(toLink);
        tmpTurn.push(turn);
        tmpExtra.push(extra);
      } else if (extra < (tmpExtra[slot] as number)) {
        tmpExtra[slot] = extra;
        tmpTurn[slot] = turn;
      }
    }

    // CSR by fromLink, edges of one link ordered by toLink: the order of `net.connectors` must not
    // leak into the trees.
    const edgeCount = tmpFrom.length;
    this.edgeCount = edgeCount;
    this.edgeStart = new Int32Array(linkCount + 1);
    this.edgeFrom = new Int32Array(edgeCount);
    this.edgeTo = new Int32Array(edgeCount);
    this.edgeTurn = new Uint8Array(edgeCount);
    this.edgeExtraS = new Float64Array(edgeCount);
    const order = new Int32Array(edgeCount);
    for (let e = 0; e < edgeCount; e++) order[e] = e;
    const sorted = Array.from(order).sort((a, b) => {
      const fa = tmpFrom[a] as number;
      const fb = tmpFrom[b] as number;
      if (fa !== fb) return fa - fb;
      return (tmpTo[a] as number) - (tmpTo[b] as number);
    });
    for (let k = 0; k < edgeCount; k++) {
      const e = sorted[k] as number;
      this.edgeFrom[k] = tmpFrom[e] as number;
      this.edgeTo[k] = tmpTo[e] as number;
      this.edgeTurn[k] = tmpTurn[e] as number;
      this.edgeExtraS[k] = tmpExtra[e] as number;
    }
    for (let k = 0; k < edgeCount; k++) {
      const f = this.edgeFrom[k] as number;
      this.edgeStart[f + 1] = (this.edgeStart[f + 1] as number) + 1;
    }
    for (let l = 0; l < linkCount; l++) {
      this.edgeStart[l + 1] = (this.edgeStart[l + 1] as number) + (this.edgeStart[l] as number);
    }

    this.inStart = new Int32Array(linkCount + 1);
    this.inEdges = new Int32Array(edgeCount);
    for (let k = 0; k < edgeCount; k++) {
      const to = this.edgeTo[k] as number;
      this.inStart[to + 1] = (this.inStart[to + 1] as number) + 1;
    }
    for (let l = 0; l < linkCount; l++) {
      this.inStart[l + 1] = (this.inStart[l + 1] as number) + (this.inStart[l] as number);
    }
    const cursor = Int32Array.from(this.inStart.subarray(0, linkCount));
    for (let k = 0; k < edgeCount; k++) {
      const to = this.edgeTo[k] as number;
      this.inEdges[cursor[to] as number] = k;
      cursor[to] = (cursor[to] as number) + 1;
    }
  }

  /** Movement leading from `link` to `toLink`, or -1 when the graph has no such edge. */
  turnTo(link: number, toLink: number): number {
    const start = this.edgeStart[link] as number;
    const end = this.edgeStart[link + 1] as number;
    for (let e = start; e < end; e++) {
      if ((this.edgeTo[e] as number) === toLink) return this.edgeTurn[e] as number;
    }
    return -1;
  }
}

/**
 * Expected wait of a movement at a signalized node, by global signal-group index (the order of
 * `RuntimeNetwork.signalGroupIds`): half a cycle times the share of the cycle the group is not
 * released, i.e. `0.5 * (cycle - green)`. A group that no phase ever turns green pays half a cycle.
 */
function expectedSignalDelayByGroup(net: Network): Float64Array {
  let total = 0;
  for (const ctrl of net.signalControllers) total += ctrl.groups.length;
  const delay = new Float64Array(total);
  let gi = 0;
  for (const ctrl of net.signalControllers) {
    const cycle = cycleLengthS(ctrl);
    const greenById = new Map<string, number>();
    for (const phase of ctrl.phases) {
      for (const id of phase.greenGroupIds) {
        greenById.set(id, (greenById.get(id) ?? 0) + phase.greenS + phase.yellowS);
      }
    }
    for (const group of ctrl.groups) {
      const green = Math.min(cycle, greenById.get(group.id) ?? 0);
      delay[gi++] = Math.max(0, 0.5 * (cycle - green));
    }
  }
  return delay;
}
