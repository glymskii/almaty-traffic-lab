import { losFromVc, type NetworkTotals } from "@atl/contracts";
import { CLASS_COUNT, type RuntimeNetwork } from "../runtime/network.ts";
import type { VehiclePool } from "../runtime/vehicles.ts";
import { type MetricsAccumulators, WINDOW_SLOTS } from "./accumulators.ts";

const SECONDS_PER_HOUR = 3600;
const MPS_TO_KPH = 3.6;

/**
 * Network-wide totals (T-18, item 5 of the card).
 *
 * Two different horizons meet here, on purpose:
 *  - **since the start of the run**: delay hours of the trips completed after warm-up, the number the
 *    A/B panel compares between scenarios (the counters live in `SimulationImpl`, they are the same
 *    ones `tripStats()` reports);
 *  - **over the metrics window**: mean speeds per class, from the trips that *finished* inside the
 *    window (distance over time, so a trip that spent the window standing still drags the mean down
 *    exactly as much as it should), and the share of segments in LOS E/F, from the windowed V/C.
 *
 * A class with no completed trip in the window (buses on a short run, any class right after warm-up)
 * falls back to the instantaneous mean speed of its active vehicles, so the panel never shows a
 * misleading zero for a class that is visibly moving.
 */
export class TotalsTracker {
  private readonly slotDistanceM: Float64Array;
  private readonly slotTripS: Float64Array;
  private readonly slotSpanS: number;
  private slot = 0;
  private slotEndsAtS: number;
  private readonly winDistanceM = new Float64Array(CLASS_COUNT);
  private readonly winTripS = new Float64Array(CLASS_COUNT);
  /** Scratch for `build`, so a report never allocates. */
  private readonly liveSpeedSum = new Float64Array(CLASS_COUNT);
  private readonly liveCount = new Float64Array(CLASS_COUNT);

  constructor(windowS: number) {
    this.slotDistanceM = new Float64Array(WINDOW_SLOTS * CLASS_COUNT);
    this.slotTripS = new Float64Array(WINDOW_SLOTS * CLASS_COUNT);
    this.slotSpanS = windowS / WINDOW_SLOTS;
    this.slotEndsAtS = this.slotSpanS;
  }

  /** Records a completed trip. Called from `despawn`, so only trips that really finished count. */
  recordTrip(clsCode: number, distanceM: number, tripTimeS: number, nowS: number): void {
    this.rotateTo(nowS);
    const cell = this.slot * CLASS_COUNT + clsCode;
    this.slotDistanceM[cell] = (this.slotDistanceM[cell] as number) + distanceM;
    this.slotTripS[cell] = (this.slotTripS[cell] as number) + tripTimeS;
    this.winDistanceM[clsCode] = (this.winDistanceM[clsCode] as number) + distanceM;
    this.winTripS[clsCode] = (this.winTripS[clsCode] as number) + tripTimeS;
  }

  private rotateTo(nowS: number): void {
    let rotations = 0;
    while (nowS >= this.slotEndsAtS) {
      if (rotations >= WINDOW_SLOTS) {
        this.slotEndsAtS = nowS + this.slotSpanS;
        return;
      }
      this.slot = (this.slot + 1) % WINDOW_SLOTS;
      const base = this.slot * CLASS_COUNT;
      for (let c = 0; c < CLASS_COUNT; c++) {
        this.winDistanceM[c] =
          (this.winDistanceM[c] as number) - (this.slotDistanceM[base + c] as number);
        this.winTripS[c] = (this.winTripS[c] as number) - (this.slotTripS[base + c] as number);
        this.slotDistanceM[base + c] = 0;
        this.slotTripS[base + c] = 0;
      }
      this.slotEndsAtS += this.slotSpanS;
      rotations++;
    }
  }

  /**
   * Assembles `NetworkTotals`. `delayS`/`personDelayS`/`completed` are the run-long trip counters,
   * `classes` the vehicle-class codes whose mean speed the frame reports separately.
   */
  build(
    pool: VehiclePool,
    rt: RuntimeNetwork,
    acc: MetricsAccumulators,
    stoppedSpeedMps: number,
    nowS: number,
    run: { completed: number; delayS: number; personDelayS: number },
    classes: { car: number; bus: number },
  ): NetworkTotals {
    this.rotateTo(nowS);
    const liveSpeedSum = this.liveSpeedSum;
    const liveCount = this.liveCount;
    liveSpeedSum.fill(0);
    liveCount.fill(0);
    let active = 0;
    let stopped = 0;
    let speedSum = 0;
    const n = pool.highWater;
    for (let i = 0; i < n; i++) {
      if ((pool.track[i] as number) < 0) continue;
      const v = pool.v[i] as number;
      active++;
      speedSum += v;
      if (v <= stoppedSpeedMps) stopped++;
      const c = pool.cls[i] as number;
      liveSpeedSum[c] = (liveSpeedSum[c] as number) + v;
      liveCount[c] = (liveCount[c] as number) + 1;
    }

    const meanOf = (cls: number): number => {
      const tripS = this.winTripS[cls] as number;
      if (tripS > 0) return ((this.winDistanceM[cls] as number) / tripS) * MPS_TO_KPH;
      const count = liveCount[cls] as number;
      return count > 0 ? ((liveSpeedSum[cls] as number) / count) * MPS_TO_KPH : 0;
    };
    let allDistanceM = 0;
    let allTripS = 0;
    for (let c = 0; c < CLASS_COUNT; c++) {
      allDistanceM += this.winDistanceM[c] as number;
      allTripS += this.winTripS[c] as number;
    }
    const meanSpeedKph =
      allTripS > 0
        ? (allDistanceM / allTripS) * MPS_TO_KPH
        : active > 0
          ? (speedSum / active) * MPS_TO_KPH
          : 0;

    let congestedSegments = 0;
    const segmentCount = rt.segments.length;
    for (let s = 0; s < segmentCount; s++) {
      const los = losFromVc(acc.vcRatio(s));
      if (los === "E" || los === "F") congestedSegments++;
    }

    return {
      vehiclesActive: active,
      vehiclesCompleted: run.completed,
      delayVehH: run.delayS / SECONDS_PER_HOUR,
      delayPersonH: run.personDelayS / SECONDS_PER_HOUR,
      meanSpeedKph,
      carMeanSpeedKph: meanOf(classes.car),
      busMeanSpeedKph: meanOf(classes.bus),
      stoppedShare: active > 0 ? stopped / active : 0,
      congestedSegmentShare: segmentCount > 0 ? congestedSegments / segmentCount : 0,
    };
  }
}
