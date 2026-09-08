import type { Network } from "@atl/contracts";
import type { Rng } from "../rng.ts";
import type { RuntimeNetwork } from "../runtime/network.ts";

/**
 * Origin-destination model (T-12, D9).
 *
 * Origins ("sources") are the gates by `weightIn` and the attractors by `weightOut`; destinations
 * are the gates by `weightOut` and the attractors by `weightIn`. A trip ends at an attractor with
 * probability `demand.internalTripShare` and at a gate otherwise, and a destination equal to the
 * origin is rejected.
 *
 * Destinations are aggregated **by node**, because that is what a routing tree is built for: two
 * attractors on the same node share one tree, and their weights add up. A source keeps its own list
 * of entry lanes (the lanes that start at `s = 0` on the links leaving its node), which is what the
 * spawner places vehicles on.
 */
export class OdModel {
  // ---- origins ----
  readonly sourceCount: number;
  readonly sourceNode: Int32Array;
  /** Share of the network-wide trip rate produced by this source (sums to 1). */
  readonly sourceShare: Float64Array;
  readonly sourceLaneStart: Int32Array;
  readonly sourceLaneCount: Int32Array;
  readonly sourceLanes: Int32Array;

  // ---- destinations (one entry per node) ----
  readonly destCount: number;
  readonly destNodes: Int32Array;
  /** 1 when the trip leaves the network at that node (gate), 0 when it ends inside (attractor). */
  readonly destIsGate: Uint8Array;
  /** Gate destinations in ascending order; the fallback when a route is lost mid-trip. */
  readonly gateDests: Int32Array;

  private readonly gateCum: Float64Array;
  private readonly innerDests: Int32Array;
  private readonly innerCum: Float64Array;

  constructor(net: Network, rt: RuntimeNetwork) {
    const sourceNodes: number[] = [];
    const sourceWeights: number[] = [];
    const sourceLaneLists: number[][] = [];

    for (let g = 0; g < rt.gateCount; g++) {
      const weight = rt.gateWeightIn[g] as number;
      const count = rt.gateLaneCount[g] as number;
      if (weight <= 0 || count <= 0) continue;
      const start = rt.gateLaneStart[g] as number;
      const lanes: number[] = [];
      for (let k = 0; k < count; k++) lanes.push(rt.gateLanes[start + k] as number);
      sourceNodes.push(rt.gateNode[g] as number);
      sourceWeights.push(weight);
      sourceLaneLists.push(lanes);
    }

    // Attractors: aggregate by node, then find the lanes a vehicle can be born on there.
    const attractorOut = new Map<number, number>();
    const attractorIn = new Map<number, number>();
    for (const a of net.attractors) {
      const node = rt.nodeIndex.get(a.nodeId);
      if (node === undefined) continue;
      if (a.weightOut > 0) attractorOut.set(node, (attractorOut.get(node) ?? 0) + a.weightOut);
      if (a.weightIn > 0) attractorIn.set(node, (attractorIn.get(node) ?? 0) + a.weightIn);
    }
    const outNodes = Array.from(attractorOut.keys()).sort((a, b) => a - b);
    for (const node of outNodes) {
      const lanes = entryLanesOfNode(rt, node);
      if (lanes.length === 0) continue;
      sourceNodes.push(node);
      sourceWeights.push(attractorOut.get(node) ?? 0);
      sourceLaneLists.push(lanes);
    }

    this.sourceCount = sourceNodes.length;
    this.sourceNode = Int32Array.from(sourceNodes);
    this.sourceShare = new Float64Array(this.sourceCount);
    this.sourceLaneStart = new Int32Array(this.sourceCount);
    this.sourceLaneCount = new Int32Array(this.sourceCount);
    let laneTotal = 0;
    for (const lanes of sourceLaneLists) laneTotal += lanes.length;
    this.sourceLanes = new Int32Array(laneTotal);
    let cursor = 0;
    let weightTotal = 0;
    for (const w of sourceWeights) weightTotal += w;
    for (let s = 0; s < this.sourceCount; s++) {
      const lanes = sourceLaneLists[s] as number[];
      this.sourceLaneStart[s] = cursor;
      this.sourceLaneCount[s] = lanes.length;
      for (const lane of lanes) this.sourceLanes[cursor++] = lane;
      this.sourceShare[s] = weightTotal > 0 ? (sourceWeights[s] as number) / weightTotal : 0;
    }

    // Destinations: gate nodes with weightOut first (so `destIsGate` wins a shared node), then the
    // attractor nodes that are not gates.
    const destNodes: number[] = [];
    const destIsGate: number[] = [];
    const destWeight: number[] = [];
    const seen = new Map<number, number>();
    for (let g = 0; g < rt.gateCount; g++) {
      const gate = net.gates[g];
      if (!gate || gate.weightOut <= 0) continue;
      const node = rt.gateNode[g] as number;
      const known = seen.get(node);
      if (known !== undefined) {
        destWeight[known] = (destWeight[known] as number) + gate.weightOut;
        continue;
      }
      seen.set(node, destNodes.length);
      destNodes.push(node);
      destIsGate.push(1);
      destWeight.push(gate.weightOut);
    }
    for (const node of Array.from(attractorIn.keys()).sort((a, b) => a - b)) {
      if (seen.has(node)) continue;
      seen.set(node, destNodes.length);
      destNodes.push(node);
      destIsGate.push(0);
      destWeight.push(attractorIn.get(node) ?? 0);
    }

    this.destCount = destNodes.length;
    this.destNodes = Int32Array.from(destNodes);
    this.destIsGate = Uint8Array.from(destIsGate);

    const gateList: number[] = [];
    const innerList: number[] = [];
    for (let d = 0; d < this.destCount; d++) {
      if ((this.destIsGate[d] as number) === 1) gateList.push(d);
      else innerList.push(d);
    }
    this.gateDests = Int32Array.from(gateList);
    this.innerDests = Int32Array.from(innerList);
    this.gateCum = cumulative(gateList, destWeight);
    this.innerCum = cumulative(innerList, destWeight);
  }

  /** Source index for a uniform draw over the source shares, or -1 when there are no sources. */
  sampleSource(u: number): number {
    let acc = 0;
    for (let s = 0; s < this.sourceCount; s++) {
      acc += this.sourceShare[s] as number;
      if (u < acc) return s;
    }
    return this.sourceCount - 1;
  }

  /**
   * Destination for a trip starting at `sourceNode`: an attractor with probability `internalShare`,
   * a gate otherwise, falling back to the other pool when the preferred one is empty. Returns -1
   * when the only candidate is the origin itself (O = D is forbidden).
   */
  sampleDest(rng: Rng, internalShare: number, sourceNode: number): number {
    const preferInner = this.innerDests.length > 0 && rng.chance(internalShare);
    const first = preferInner ? this.innerDests : this.gateDests;
    const firstCum = preferInner ? this.innerCum : this.gateCum;
    const second = preferInner ? this.gateDests : this.innerDests;
    const secondCum = preferInner ? this.gateCum : this.innerCum;
    for (let attempt = 0; attempt < 4; attempt++) {
      const d = pickFrom(first, firstCum, rng);
      if (d >= 0 && (this.destNodes[d] as number) !== sourceNode) return d;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const d = pickFrom(second, secondCum, rng);
      if (d >= 0 && (this.destNodes[d] as number) !== sourceNode) return d;
    }
    return -1;
  }
}

/** Lanes starting at `s = 0` on the links that leave `node`: where a trip born there can be placed. */
function entryLanesOfNode(rt: RuntimeNetwork, node: number): number[] {
  const lanes: number[] = [];
  for (let l = 0; l < rt.linkCount; l++) {
    if ((rt.linkFrom[l] as number) !== node) continue;
    const start = rt.linkLaneStart[l] as number;
    const count = rt.linkLaneCount[l] as number;
    for (let k = 0; k < count; k++) {
      const lane = rt.linkLanes[start + k] as number;
      if ((rt.trackStartS[lane] as number) <= 0) lanes.push(lane);
    }
  }
  return lanes;
}

/** Cumulative weights of `members` (indices into `weights`), normalised to 1; empty stays empty. */
function cumulative(members: readonly number[], weights: readonly number[]): Float64Array {
  const cum = new Float64Array(members.length);
  let total = 0;
  for (const m of members) total += weights[m] as number;
  let acc = 0;
  for (let k = 0; k < members.length; k++) {
    acc += total > 0 ? (weights[members[k] as number] as number) / total : 1 / members.length;
    cum[k] = acc;
  }
  return cum;
}

function pickFrom(members: Int32Array, cum: Float64Array, rng: Rng): number {
  if (members.length === 0) return -1;
  const u = rng.float();
  let lo = 0;
  let hi = members.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (u < (cum[mid] as number)) hi = mid;
    else lo = mid + 1;
  }
  return members[lo] as number;
}
