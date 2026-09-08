import type { Network } from "@atl/contracts";
import type { RuntimeNetwork } from "../runtime/network.ts";

/**
 * Floor on the green share of an approach: a movement no phase ever releases (T-08's prohibited
 * connectors, the practically-always-red stub of the `blockedExit` fixture) would otherwise get a
 * capacity of zero and an infinite V/C. Anything below this is "closed", not "congested".
 */
const MIN_GREEN_SHARE = 0.02;

/**
 * Segment index for the metrics pipeline (T-18).
 *
 * `RuntimeNetwork` already cuts every lane into equal pieces of about `metrics.segmentLengthM`
 * (`laneSegStart/laneSegCount/laneSegLengthM`, descriptors in `segments`). This class adds what the
 * accumulators need on top of that geometry:
 *
 *  - `segmentOfLane(lane, s)`: the segment a vehicle coordinate falls into, O(1) (the pieces of one
 *    lane are equal, so the cumulative boundary search collapses into a division);
 *  - `segmentOfConnector(track)`: connectors have no segments of their own, so everything that
 *    happens inside the junction box is attributed to the **last segment of the incoming lane**
 *    (T-04/T-11 notes: otherwise gap-acceptance and gridlock delay would simply vanish);
 *  - per-segment lane, length, free-flow speed and lane capacity, the denominator of V/C.
 *
 * Built once next to the runtime network and never mutated.
 */
export class SegmentIndex {
  readonly segmentCount: number;
  /** Lane (track index) each segment belongs to. */
  readonly segLane: Int32Array;
  readonly segLengthM: Float64Array;
  /** Coordinate of the segment's end on its lane's link scale (`SegmentDescriptor.endS`). */
  readonly segEndS: Float64Array;
  /** Denominator of `speedRatio`, m/s. */
  readonly segFreeSpeedMps: Float64Array;
  /** Denominator of V/C, veh/h: saturation flow, scaled by the green share on approach segments. */
  readonly segCapacityVehH: Float64Array;
  /** 1 for the last segment of a lane that reaches the end of its link (an approach segment). */
  readonly segIsApproach: Uint8Array;
  /** Per track: segment of a connector (last segment of its incoming lane), -1 for lanes. */
  readonly connSegment: Int32Array;
  private readonly rt: RuntimeNetwork;

  constructor(net: Network, rt: RuntimeNetwork, saturationFlowVehPerHPerLane: number) {
    this.rt = rt;
    const segmentCount = rt.segments.length;
    this.segmentCount = segmentCount;
    this.segLane = new Int32Array(segmentCount);
    this.segLengthM = new Float64Array(segmentCount);
    this.segEndS = new Float64Array(segmentCount);
    this.segFreeSpeedMps = new Float64Array(segmentCount);
    this.segCapacityVehH = new Float64Array(segmentCount);
    this.segIsApproach = new Uint8Array(segmentCount);

    const groupGreenShare = greenShareByGroup(net);
    for (let lane = 0; lane < rt.laneCount; lane++) {
      const start = rt.laneSegStart[lane] as number;
      const count = rt.laneSegCount[lane] as number;
      const piece = rt.laneSegLengthM[lane] as number;
      const freeSpeed = rt.trackSpeedMps[lane] as number;
      // The green share of the lane is the best its own movements get: a lane whose connectors are
      // an arrow and a main group discharges for as long as the main group is green.
      let greenShare = 1;
      const connStart = rt.laneConnStart[lane] as number;
      const connCount = rt.laneConnCount[lane] as number;
      let sawSignal = false;
      let best = 0;
      for (let k = connStart; k < connStart + connCount; k++) {
        const conn = rt.laneConnList[k] as number;
        const g = rt.connSignalGroup[conn] as number;
        if (g < 0) continue;
        sawSignal = true;
        const share = groupGreenShare[g] as number;
        if (share > best) best = share;
      }
      if (sawSignal) greenShare = best;
      for (let k = 0; k < count; k++) {
        const seg = start + k;
        const isApproach = k === count - 1 && rt.laneReachesLinkEnd[lane] === 1;
        this.segLane[seg] = lane;
        this.segLengthM[seg] = piece;
        this.segEndS[seg] =
          k === count - 1
            ? (rt.trackEndS[lane] as number)
            : (rt.trackStartS[lane] as number) + (k + 1) * piece;
        this.segFreeSpeedMps[seg] = freeSpeed;
        this.segIsApproach[seg] = isApproach ? 1 : 0;
        const share = isApproach ? Math.max(greenShare, MIN_GREEN_SHARE) : 1;
        this.segCapacityVehH[seg] = saturationFlowVehPerHPerLane * share;
      }
    }

    this.connSegment = new Int32Array(rt.trackCount).fill(-1);
    for (let c = 0; c < rt.connectorCount; c++) {
      const track = rt.laneCount + c;
      const from = rt.connFromLane[c] as number;
      this.connSegment[track] =
        (rt.laneSegStart[from] as number) + (rt.laneSegCount[from] as number) - 1;
    }
  }

  /** Segment containing coordinate `s` on `lane`; `s` outside the lane is clamped to its ends. */
  segmentOfLane(lane: number, s: number): number {
    const rt = this.rt;
    const start = rt.laneSegStart[lane] as number;
    const count = rt.laneSegCount[lane] as number;
    const piece = rt.laneSegLengthM[lane] as number;
    if (count <= 1 || !(piece > 0)) return start;
    let k = Math.floor((s - (rt.trackStartS[lane] as number)) / piece);
    if (k < 0) k = 0;
    else if (k >= count) k = count - 1;
    return start + k;
  }

  /** Segment a vehicle on `track` at coordinate `s` is counted in (lanes and connectors alike). */
  segmentOf(track: number, s: number): number {
    if (track >= this.rt.laneCount) return this.connSegment[track] as number;
    return this.segmentOfLane(track, s);
  }

  /** First segment of a lane. */
  firstSegmentOfLane(lane: number): number {
    return this.rt.laneSegStart[lane] as number;
  }

  /** Last segment of a lane. */
  lastSegmentOfLane(lane: number): number {
    return (this.rt.laneSegStart[lane] as number) + (this.rt.laneSegCount[lane] as number) - 1;
  }
}

/**
 * Share of the cycle each signal group is available to traffic, in the global group order of
 * `RuntimeNetwork.signalGroupIds` (controllers in network order, groups in controller order -- the
 * same walk `RuntimeNetwork` does, so the indices coincide by construction).
 *
 * Effective green = `greenS + yellowS` of every phase that releases the group, over the cycle. This
 * is the classic capacity approximation and the one `test/fixtures/builders.ts:saturationMultiplier`
 * already uses, so demand estimates and V/C denominators agree.
 */
function greenShareByGroup(net: Network): Float64Array {
  let groupCount = 0;
  for (const ctrl of net.signalControllers) groupCount += ctrl.groups.length;
  const shares = new Float64Array(groupCount);
  let base = 0;
  for (const ctrl of net.signalControllers) {
    let cycleS = 0;
    for (const p of ctrl.phases) cycleS += p.greenS + p.yellowS + p.allRedS;
    for (let g = 0; g < ctrl.groups.length; g++) {
      const group = ctrl.groups[g];
      if (!group) continue;
      let greenS = 0;
      for (const p of ctrl.phases) {
        if (p.greenGroupIds.includes(group.id)) greenS += p.greenS + p.yellowS;
      }
      shares[base + g] = cycleS > 0 ? greenS / cycleS : 1;
    }
    base += ctrl.groups.length;
  }
  return shares;
}
