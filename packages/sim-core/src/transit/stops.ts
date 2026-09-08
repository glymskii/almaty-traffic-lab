import type { BehaviorConfig, Network } from "@atl/contracts";
import { VehicleFlag } from "@atl/contracts";
import type { Rng } from "../rng.ts";
import type { RuntimeNetwork } from "../runtime/network.ts";
import type { VehiclePool } from "../runtime/vehicles.ts";
import { dwellDurationS } from "./rules.ts";

const DWELLING = VehicleFlag.DWELLING;
const CLEAR_DWELLING = ~DWELLING & 0xff;

/** One `BusStop`, resolved to `RuntimeNetwork` indices and placed in its route's stop order. */
interface TransitStop {
  readonly linkIdx: number;
  readonly laneIdx: number;
  /** Lane immediately to the right of `laneIdx`, or -1; the trigger tolerates either (T-14 card). */
  readonly rightLaneIdx: number;
  readonly s: number;
  /** true = `bay` (leaves the lane's ordered list while dwelling), false = `in_lane`. */
  readonly bay: boolean;
}

/**
 * Bus-stop dwelling (T-14, item 2): for every scheduled transit vehicle, advances an in-progress
 * dwell and triggers a new one when the bus reaches its next stop. Runs once per step, before
 * `computeAccelerations`, so a freshly dwelling bus is already stationary (and, for a `bay` stop,
 * already off the lane's ordered list) by the time the longitudinal model looks at it.
 *
 * A dwelling vehicle is a special case throughout the rest of the step: `computeAccelerations` holds
 * it at `a = 0` under cause `bus_dwell` instead of running the ordinary obstacle scan, and
 * `IntersectionRuntime.freeRoomOn` (T-11 note) ignores it when judging whether an exit lane is full.
 */
export class BusStopRuntime {
  /**
   * [route][order in `route.stopIds`] -> resolved stop. Indexed the same way as
   * `BusScheduleRuntime.routes` (both are built by walking `net.busRoutes` in order), so a vehicle's
   * `pool.busRoute` value indexes this array directly without a separate id lookup.
   */
  private readonly stopsByRoute: readonly (readonly TransitStop[])[];

  constructor(net: Network, rt: RuntimeNetwork) {
    const stopById = new Map(net.busStops.map((s) => [s.id, s]));
    this.stopsByRoute = net.busRoutes.map((route) =>
      route.stopIds.map((stopId) => {
        const stop = stopById.get(stopId);
        if (!stop) throw new Error(`bus route ${route.id}: unknown stop ${stopId}`);
        const laneIdx = rt.laneIndex.get(stop.laneId);
        if (laneIdx === undefined)
          throw new Error(`bus route ${route.id}: unknown lane ${stop.laneId}`);
        return {
          linkIdx: rt.linkIndex.get(stop.linkId) as number,
          laneIdx,
          rightLaneIdx: rt.laneRight[laneIdx] as number,
          s: stop.s,
          bay: stop.kind === "bay",
        };
      }),
    );
  }

  /** Advances every in-progress dwell and triggers new ones. See the class doc for placement in `step()`. */
  update(pool: VehiclePool, now: number, behavior: BehaviorConfig, peak: boolean, rng: Rng): void {
    const n = pool.highWater;
    for (let i = 0; i < n; i++) {
      const route = pool.busRoute[i] as number;
      if (route < 0) continue;
      if ((pool.dwellEndS[i] as number) > 0) {
        if (now >= (pool.dwellEndS[i] as number)) this.tryEndDwell(pool, i, route);
        continue;
      }
      const stops = this.stopsByRoute[route] as readonly TransitStop[];
      const stopIdx = pool.busStopIdx[i] as number;
      if (stopIdx >= stops.length) continue;
      const stop = stops[stopIdx] as TransitStop;
      const track = pool.track[i] as number;
      if (track !== stop.laneIdx && track !== stop.rightLaneIdx) continue;
      if ((pool.s[i] as number) < stop.s) continue;
      this.beginDwell(pool, i, stop, now, behavior, peak, rng);
      pool.busStopIdx[i] = stopIdx + 1;
    }
  }

  private beginDwell(
    pool: VehiclePool,
    i: number,
    stop: TransitStop,
    now: number,
    behavior: BehaviorConfig,
    peak: boolean,
    rng: Rng,
  ): void {
    pool.v[i] = 0;
    pool.a[i] = 0;
    pool.dwellEndS[i] = now + dwellDurationS(rng, behavior, peak);
    pool.persistentFlags[i] = (pool.persistentFlags[i] as number) | DWELLING;
    // `in_lane`: the bus stays the leader of its lane, so followers queue behind it normally.
    // `bay`: it leaves the ordered list (kept as `track[i]`, just unlinked), so nobody queues at all.
    if (stop.bay) pool.remove(i);
  }

  /**
   * `in_lane` always resumes at once (it never left the list). `bay` checks the gap around the
   * parked position first (docs/tasks/T-14: "ждёт, если места нет") and keeps waiting, retried every
   * step, until both neighbours leave enough room.
   */
  private tryEndDwell(pool: VehiclePool, i: number, route: number): void {
    const stopIdx = (pool.busStopIdx[i] as number) - 1;
    const stop = (this.stopsByRoute[route] as readonly TransitStop[])[stopIdx] as TransitStop;
    if (!stop.bay) {
      this.finishDwell(pool, i);
      return;
    }
    const lane = pool.track[i] as number;
    const si = pool.s[i] as number;
    const needM = pool.minGap[i] as number;
    // Same tail-to-head walk as `VehiclePool.insert`: the first vehicle at or beyond `si`.
    let leader = pool.trackTail[lane] as number;
    while (leader >= 0 && (pool.s[leader] as number) < si) leader = pool.ahead[leader] as number;
    const leaderGap =
      leader >= 0
        ? (pool.s[leader] as number) - (pool.length[leader] as number) - si
        : Number.POSITIVE_INFINITY;
    if (leaderGap < needM) return; // no room yet; retried next step
    const follower =
      leader >= 0 ? (pool.behind[leader] as number) : (pool.trackHead[lane] as number);
    const followerGap =
      follower >= 0
        ? si - (pool.length[i] as number) - (pool.s[follower] as number)
        : Number.POSITIVE_INFINITY;
    if (followerGap < needM) return;
    pool.insert(lane, i);
    this.finishDwell(pool, i);
  }

  private finishDwell(pool: VehiclePool, i: number): void {
    pool.dwellEndS[i] = 0;
    pool.persistentFlags[i] = (pool.persistentFlags[i] as number) & CLEAR_DWELLING;
  }
}
