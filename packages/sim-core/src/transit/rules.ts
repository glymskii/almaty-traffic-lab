import type { BehaviorConfig, BusRoute } from "@atl/contracts";
import type { Rng } from "../rng.ts";
import type { LaneRuntime } from "../runtime/lanes.ts";
import type { RuntimeNetwork } from "../runtime/network.ts";

/**
 * Pure helper functions shared by `schedule.ts` and `stops.ts` (T-14). Kept separate from both so the
 * timing/headway and dwell-duration rules read as one place, independent of the per-vehicle state
 * machines that use them.
 */

/** Headway in force for a route right now: `headwayPeakS` during a peak hour, `headwayOffpeakS` else. */
export function headwayS(
  route: Pick<BusRoute, "headwayPeakS" | "headwayOffpeakS">,
  peak: boolean,
): number {
  return peak ? route.headwayPeakS : route.headwayOffpeakS;
}

/**
 * One dwell duration: `behavior.busDwellS` sampled from its distribution, scaled by
 * `busDwellPeakFactor` during a peak hour. Consumes exactly one sample from `rng`.
 */
export function dwellDurationS(rng: Rng, behavior: BehaviorConfig, peak: boolean): number {
  const base = rng.sample(behavior.busDwellS);
  return peak ? base * behavior.busDwellPeakFactor : base;
}

/**
 * Lane a bus should aim for on `link`: its dedicated bus lane when the link has one, else the
 * rightmost lane (docs/tasks/T-14, item 1). Falls back to the rightmost lane if none of the link's
 * lanes admits the class (malformed data), so callers always get a usable index.
 */
export function preferredLaneOfLink(rt: RuntimeNetwork, lanes: LaneRuntime, link: number): number {
  const start = rt.linkLaneStart[link] as number;
  const count = rt.linkLaneCount[link] as number;
  for (let k = 0; k < count; k++) {
    const lane = rt.linkLanes[start + k] as number;
    if (lanes.isBusLane[lane] === 1) return lane;
  }
  return rt.linkLanes[start + count - 1] as number;
}
