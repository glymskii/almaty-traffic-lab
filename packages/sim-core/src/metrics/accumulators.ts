import { CAUSE_COUNT, type MetricsConfig, type MetricsFrame } from "@atl/contracts";
import type { RuntimeNetwork } from "../runtime/network.ts";
import type { VehiclePool } from "../runtime/vehicles.ts";
import type { SegmentIndex } from "./segments.ts";

/**
 * Slots the sliding window is cut into. The window is a ring of slots, not of raw samples: on the
 * big network (54 000 segments) one slot of the cause matrix alone is 3.5 MB, so a ring of 300
 * one-second samples would cost gigabytes. Slot granularity only decides how abruptly old data
 * leaves the window -- shares and means keep full resolution, because every slot counts its own
 * samples (see `congestedSamples` / `sampleCount`).
 */
export const WINDOW_SLOTS = 8;

const SECONDS_PER_HOUR = 3600;
const METRES_PER_KM = 1000;

/**
 * Per-sample scratch layout: everything one sample sums for a segment lives in one row of eight
 * doubles, i.e. exactly one 64-byte cache line. With 20 000 vehicles spread over 50 000 segments
 * almost every vehicle lands on a different segment, so the number of cache lines a vehicle touches
 * is what the sample costs; the rows are folded into the ring once per segment afterwards.
 */
const SCRATCH_STRIDE = 8;
const SC_SPEED = 0;
const SC_COUNT = 1;
const SC_FRONT = 2;
const SC_REAR = 3;
const SC_DELAY = 4;
const SC_PERSON = 5;
const SC_STOPS = 6;

/**
 * Windowed per-segment aggregates (T-18, docs/ARCHITECTURE.md "Метрики и детектор").
 *
 * Every `metrics.sampleIntervalS` the simulation calls `sample()`, which walks the vehicles once and
 * adds this sample into the newest slot of the ring **and** into the running window sums. When a slot
 * is older than the window it is subtracted from those sums and reused, so `writeMetrics` is a single
 * pass over the segments and never over the ring.
 *
 * What one sample contributes to the segment a vehicle is on (a connector counts into the last
 * segment of its incoming lane, see `SegmentIndex`):
 *  - `sumSpeed` / `sumCount`: mean speed and, with the sample count, density;
 *  - `crossings`: vehicles that passed the end of the segment since the previous sample -- flow;
 *  - `sumQueueM`: length of the standing part, from the rearmost stopped vehicle to the front of the
 *    segment's content;
 *  - `sumDelayVehS` / `sumDelayPersonS`: `elapsed * max(0, 1 - v/v_free)`, the second one weighted by
 *    the class occupancy of the current hour;
 *  - `causeDelay`: the same vehicle delay, split by ROOT cause (`rootCause.ts`);
 *  - `sumStops`: transitions of a vehicle to standstill (`pool.stops`), which the frame has no field
 *    for but the detector work of T-19 can read through `stopsInWindow`.
 */
export class MetricsAccumulators {
  private readonly rt: RuntimeNetwork;
  private readonly seg: SegmentIndex;
  private readonly segmentCount: number;
  private readonly slotSpanS: number;

  // ---- ring slots ----
  private readonly slotSpeed: Float64Array;
  private readonly slotCount: Float64Array;
  private readonly slotQueueM: Float64Array;
  private readonly slotCrossings: Float64Array;
  private readonly slotDelayVehS: Float64Array;
  private readonly slotDelayPersonS: Float64Array;
  private readonly slotCongested: Float64Array;
  private readonly slotStops: Float64Array;
  private readonly slotCauseDelay: Float64Array;
  /** Samples taken into each slot, and the simulated seconds they cover. */
  private readonly slotSamples: Float64Array;
  private readonly slotSpanTakenS: Float64Array;

  // ---- running window sums (ring totals) ----
  private readonly winSpeed: Float64Array;
  private readonly winCount: Float64Array;
  private readonly winQueueM: Float64Array;
  private readonly winCrossings: Float64Array;
  private readonly winDelayVehS: Float64Array;
  private readonly winDelayPersonS: Float64Array;
  private readonly winCongested: Float64Array;
  private readonly winStops: Float64Array;
  private readonly winCauseDelay: Float64Array;
  private winSamples = 0;
  private winSpanS = 0;

  private slot = 0;
  private slotEndsAtS: number;

  // ---- per-sample scratch (allocated once) ----
  /** One cache-line row per segment, see SCRATCH_STRIDE. */
  private readonly scratch: Float64Array;
  private readonly touched: Int32Array;
  private readonly isTouched: Uint8Array;
  /**
   * Per vehicle slot: the vehicle id, segment and stop counter of the previous sample. The id is
   * what tells a continuing trip from a fresh one that happens to have been handed the same slot.
   */
  private readonly prevId: Float64Array;
  private readonly prevSegment: Int32Array;
  private readonly prevStops: Float64Array;

  constructor(rt: RuntimeNetwork, seg: SegmentIndex, capacity: number, windowS: number) {
    this.rt = rt;
    this.seg = seg;
    const n = seg.segmentCount;
    this.segmentCount = n;
    this.slotSpanS = windowS / WINDOW_SLOTS;
    this.slotEndsAtS = this.slotSpanS;

    const ring = WINDOW_SLOTS * n;
    this.slotSpeed = new Float64Array(ring);
    this.slotCount = new Float64Array(ring);
    this.slotQueueM = new Float64Array(ring);
    this.slotCrossings = new Float64Array(ring);
    this.slotDelayVehS = new Float64Array(ring);
    this.slotDelayPersonS = new Float64Array(ring);
    this.slotCongested = new Float64Array(ring);
    this.slotStops = new Float64Array(ring);
    this.slotCauseDelay = new Float64Array(ring * CAUSE_COUNT);
    this.slotSamples = new Float64Array(WINDOW_SLOTS);
    this.slotSpanTakenS = new Float64Array(WINDOW_SLOTS);

    this.winSpeed = new Float64Array(n);
    this.winCount = new Float64Array(n);
    this.winQueueM = new Float64Array(n);
    this.winCrossings = new Float64Array(n);
    this.winDelayVehS = new Float64Array(n);
    this.winDelayPersonS = new Float64Array(n);
    this.winCongested = new Float64Array(n);
    this.winStops = new Float64Array(n);
    this.winCauseDelay = new Float64Array(n * CAUSE_COUNT);

    this.scratch = new Float64Array(n * SCRATCH_STRIDE);
    this.touched = new Int32Array(n);
    this.isTouched = new Uint8Array(n);
    this.prevId = new Float64Array(capacity);
    this.prevSegment = new Int32Array(capacity).fill(-1);
    this.prevStops = new Float64Array(capacity);
  }

  /**
   * Vehicles that came to a standstill on a segment during the window. `MetricsFrame` has no field
   * for stops (contracts are frozen), so this is how the detector work of T-19 reads them.
   */
  stopsInWindow(segment: number): number {
    return positive(this.winStops[segment] as number);
  }

  /** Volume/capacity of a segment over the window (flow across its end over the lane capacity). */
  vcRatio(segment: number): number {
    const capacity = this.seg.segCapacityVehH[segment] as number;
    if (!(capacity > 0) || !(this.winSpanS > 0)) return 0;
    return (
      ((positive(this.winCrossings[segment] as number) / this.winSpanS) * SECONDS_PER_HOUR) /
      capacity
    );
  }

  /**
   * One sample. `elapsedS` is the simulated time since the previous sample (the weight of this
   * sample in the window), `occupancyByClass` the persons per vehicle of each class in the current
   * hour, and `pool.rootCause` must already be filled for this step (`RootCauseResolver`).
   */
  sample(
    pool: VehiclePool,
    nowS: number,
    elapsedS: number,
    occupancyByClass: Float64Array,
    cfg: MetricsConfig,
  ): void {
    this.rotateTo(nowS);
    const rt = this.rt;
    const seg = this.seg;
    const stoppedV = cfg.stoppedSpeedMps;
    const speedRatioMax = cfg.bottleneck.speedRatioMax;
    const scratch = this.scratch;
    const touched = this.touched;
    const isTouched = this.isTouched;
    const prevSegment = this.prevSegment;
    const prevId = this.prevId;
    const prevStops = this.prevStops;
    const trackSpeedMps = rt.trackSpeedMps;
    const laneCount = rt.laneCount;
    const segEndS = seg.segEndS;
    const segLane = seg.segLane;
    const trackLink = rt.trackLink;
    const poolS = pool.s;
    const poolV = pool.v;
    const poolAhead = pool.ahead;
    const poolId = pool.id;
    const rootCause = pool.rootCause;
    let touchedCount = 0;

    const base = this.slot * this.segmentCount;
    const causeBase = base * CAUSE_COUNT;
    const slotCauseDelay = this.slotCauseDelay;
    const slotCrossings = this.slotCrossings;
    const winCauseDelay = this.winCauseDelay;
    const winCrossings = this.winCrossings;

    // Track by track, each list from its tail forward: consecutive vehicles then land on the same
    // segment or the next one, so every segment-indexed array is walked in order instead of at
    // random. On a 50 000-segment network that is worth more than half the cost of a sample.
    const trackCount = rt.trackCount;
    for (let track = 0; track < trackCount; track++) {
      const onConnector = track >= laneCount;
      const v0Track = trackSpeedMps[track] as number;
      for (let i = pool.trackTail[track] as number; i >= 0; i = poolAhead[i] as number) {
        const s = poolS[i] as number;
        const segment = seg.segmentOf(track, s);
        // One scratch row per segment, so a vehicle touches a single cache line for everything that
        // is summed per sample. Rows are folded into the ring below, once per segment instead of
        // once per vehicle.
        const row = segment * SCRATCH_STRIDE;
        if (isTouched[segment] === 0) {
          isTouched[segment] = 1;
          touched[touchedCount++] = segment;
          scratch[row + SC_SPEED] = 0;
          scratch[row + SC_COUNT] = 0;
          scratch[row + SC_FRONT] = Number.NEGATIVE_INFINITY;
          scratch[row + SC_REAR] = Number.POSITIVE_INFINITY;
          scratch[row + SC_DELAY] = 0;
          scratch[row + SC_PERSON] = 0;
          scratch[row + SC_STOPS] = 0;
        }
        const v = poolV[i] as number;
        scratch[row + SC_SPEED] = (scratch[row + SC_SPEED] as number) + v;
        scratch[row + SC_COUNT] = (scratch[row + SC_COUNT] as number) + 1;
        // On a connector the vehicle's own `s` is not on the lane scale: place it at the very end of
        // the approach segment it is credited to, which is exactly where it left the lane.
        const sOnSegment = onConnector ? (segEndS[segment] as number) : s;
        if (sOnSegment > (scratch[row + SC_FRONT] as number)) scratch[row + SC_FRONT] = sOnSegment;
        if (v <= stoppedV) {
          const rear = sOnSegment - (pool.length[i] as number);
          if (rear < (scratch[row + SC_REAR] as number)) scratch[row + SC_REAR] = rear;
        }

        // Delay against the driver's own free-flow speed on this track.
        const v0 = v0Track * (pool.speedFactor[i] as number);
        let ratio = v0 > 0 ? 1 - v / v0 : 0;
        if (ratio < 0) ratio = 0;
        const delay = elapsedS * ratio;
        if (delay > 0) {
          const occupancy = occupancyByClass[pool.cls[i] as number] as number;
          scratch[row + SC_DELAY] = (scratch[row + SC_DELAY] as number) + delay;
          scratch[row + SC_PERSON] = (scratch[row + SC_PERSON] as number) + delay * occupancy;
          const cell = segment * CAUSE_COUNT + (rootCause[i] as number);
          slotCauseDelay[causeBase + cell] = (slotCauseDelay[causeBase + cell] as number) + delay;
          winCauseDelay[cell] = (winCauseDelay[cell] as number) + delay;
        }

        // Stops since the previous sample. A slot reused by a new vehicle starts over: its id, not
        // its slot index, is what identifies the trip these two counters belong to.
        const id = poolId[i] as number;
        const known = (prevId[i] as number) === id;
        prevId[i] = id;
        const stops = pool.stops[i] as number;
        if (known) {
          const newStops = stops - (prevStops[i] as number);
          if (newStops > 0)
            scratch[row + SC_STOPS] = (scratch[row + SC_STOPS] as number) + newStops;
        }
        prevStops[i] = stops;

        // Flow: every segment end the vehicle passed since the previous sample.
        const before = prevSegment[i] as number;
        prevSegment[i] = segment;
        if (!known || before === segment) continue;
        const laneBefore = segLane[before] as number;
        const laneNow = segLane[segment] as number;
        if (laneBefore === laneNow) {
          for (let k = before; k < segment; k++) {
            slotCrossings[base + k] = (slotCrossings[base + k] as number) + 1;
            winCrossings[k] = (winCrossings[k] as number) + 1;
          }
          continue;
        }
        // A lane change moves the vehicle sideways inside the same link: no end was crossed.
        if ((trackLink[laneBefore] as number) === (trackLink[laneNow] as number)) continue;
        const lastBefore = seg.lastSegmentOfLane(laneBefore);
        for (let k = before; k <= lastBefore; k++) {
          slotCrossings[base + k] = (slotCrossings[base + k] as number) + 1;
          winCrossings[k] = (winCrossings[k] as number) + 1;
        }
        const firstNow = seg.firstSegmentOfLane(laneNow);
        for (let k = firstNow; k < segment; k++) {
          slotCrossings[base + k] = (slotCrossings[base + k] as number) + 1;
          winCrossings[k] = (winCrossings[k] as number) + 1;
        }
      }
    }

    // Fold the scratch rows of the segments that had vehicles into the slot and the window.
    const slotSpeed = this.slotSpeed;
    const slotCount = this.slotCount;
    const slotQueueM = this.slotQueueM;
    const slotCongested = this.slotCongested;
    const slotStops = this.slotStops;
    const slotDelayVehS = this.slotDelayVehS;
    const slotDelayPersonS = this.slotDelayPersonS;
    const winSpeed = this.winSpeed;
    const winCount = this.winCount;
    const winQueueM = this.winQueueM;
    const winCongested = this.winCongested;
    const winStops = this.winStops;
    const winDelayVehS = this.winDelayVehS;
    const winDelayPersonS = this.winDelayPersonS;
    const segLengthM = seg.segLengthM;
    const segFreeSpeedMps = seg.segFreeSpeedMps;
    for (let k = 0; k < touchedCount; k++) {
      const segment = touched[k] as number;
      const row = segment * SCRATCH_STRIDE;
      const cell = base + segment;
      isTouched[segment] = 0;
      const count = scratch[row + SC_COUNT] as number;
      const speedSum = scratch[row + SC_SPEED] as number;
      slotSpeed[cell] = (slotSpeed[cell] as number) + speedSum;
      winSpeed[segment] = (winSpeed[segment] as number) + speedSum;
      slotCount[cell] = (slotCount[cell] as number) + count;
      winCount[segment] = (winCount[segment] as number) + count;

      const delay = scratch[row + SC_DELAY] as number;
      if (delay > 0) {
        const person = scratch[row + SC_PERSON] as number;
        slotDelayVehS[cell] = (slotDelayVehS[cell] as number) + delay;
        winDelayVehS[segment] = (winDelayVehS[segment] as number) + delay;
        slotDelayPersonS[cell] = (slotDelayPersonS[cell] as number) + person;
        winDelayPersonS[segment] = (winDelayPersonS[segment] as number) + person;
      }
      const stops = scratch[row + SC_STOPS] as number;
      if (stops > 0) {
        slotStops[cell] = (slotStops[cell] as number) + stops;
        winStops[segment] = (winStops[segment] as number) + stops;
      }

      const rear = scratch[row + SC_REAR] as number;
      if (rear < Number.POSITIVE_INFINITY) {
        let queue = (scratch[row + SC_FRONT] as number) - rear;
        const length = segLengthM[segment] as number;
        if (queue < 0) queue = 0;
        else if (queue > length) queue = length;
        slotQueueM[cell] = (slotQueueM[cell] as number) + queue;
        winQueueM[segment] = (winQueueM[segment] as number) + queue;
      }

      const free = segFreeSpeedMps[segment] as number;
      if (free > 0 && speedSum / count / free < speedRatioMax) {
        slotCongested[cell] = (slotCongested[cell] as number) + 1;
        winCongested[segment] = (winCongested[segment] as number) + 1;
      }
    }

    this.slotSamples[this.slot] = (this.slotSamples[this.slot] as number) + 1;
    this.slotSpanTakenS[this.slot] = (this.slotSpanTakenS[this.slot] as number) + elapsedS;
    this.winSamples += 1;
    this.winSpanS += elapsedS;
  }

  /** Advances the ring until `nowS` falls into the newest slot, evicting the slots it passes. */
  private rotateTo(nowS: number): void {
    let rotations = 0;
    while (nowS >= this.slotEndsAtS) {
      if (rotations >= WINDOW_SLOTS) {
        // A gap longer than the whole window (a very large sampleIntervalS): every slot has just
        // been evicted, so restart the ring at `nowS` instead of spinning through it again.
        this.slotEndsAtS = nowS + this.slotSpanS;
        return;
      }
      this.slot = (this.slot + 1) % WINDOW_SLOTS;
      this.evict(this.slot);
      this.slotEndsAtS += this.slotSpanS;
      rotations++;
    }
  }

  /** Subtracts a slot from the running window sums and clears it for reuse. */
  private evict(slot: number): void {
    const n = this.segmentCount;
    const base = slot * n;
    for (let i = 0; i < n; i++) {
      this.winSpeed[i] = (this.winSpeed[i] as number) - (this.slotSpeed[base + i] as number);
      this.winCount[i] = (this.winCount[i] as number) - (this.slotCount[base + i] as number);
      this.winQueueM[i] = (this.winQueueM[i] as number) - (this.slotQueueM[base + i] as number);
      this.winCrossings[i] =
        (this.winCrossings[i] as number) - (this.slotCrossings[base + i] as number);
      this.winDelayVehS[i] =
        (this.winDelayVehS[i] as number) - (this.slotDelayVehS[base + i] as number);
      this.winDelayPersonS[i] =
        (this.winDelayPersonS[i] as number) - (this.slotDelayPersonS[base + i] as number);
      this.winCongested[i] =
        (this.winCongested[i] as number) - (this.slotCongested[base + i] as number);
      this.winStops[i] = (this.winStops[i] as number) - (this.slotStops[base + i] as number);
    }
    const causeBase = base * CAUSE_COUNT;
    const causeLen = n * CAUSE_COUNT;
    for (let i = 0; i < causeLen; i++) {
      this.winCauseDelay[i] =
        (this.winCauseDelay[i] as number) - (this.slotCauseDelay[causeBase + i] as number);
    }
    this.slotSpeed.fill(0, base, base + n);
    this.slotCount.fill(0, base, base + n);
    this.slotQueueM.fill(0, base, base + n);
    this.slotCrossings.fill(0, base, base + n);
    this.slotDelayVehS.fill(0, base, base + n);
    this.slotDelayPersonS.fill(0, base, base + n);
    this.slotCongested.fill(0, base, base + n);
    this.slotStops.fill(0, base, base + n);
    this.slotCauseDelay.fill(0, causeBase, causeBase + causeLen);
    this.winSamples -= this.slotSamples[slot] as number;
    this.winSpanS -= this.slotSpanTakenS[slot] as number;
    this.slotSamples[slot] = 0;
    this.slotSpanTakenS[slot] = 0;
  }

  /** Folds the window into a caller-owned frame. */
  write(frame: MetricsFrame): void {
    const n = this.segmentCount;
    const samples = this.winSamples;
    const spanS = this.winSpanS;
    const winSpeed = this.winSpeed;
    const winCount = this.winCount;
    const winQueueM = this.winQueueM;
    const winCrossings = this.winCrossings;
    const winDelayVehS = this.winDelayVehS;
    const winDelayPersonS = this.winDelayPersonS;
    const winCongested = this.winCongested;
    const winCauseDelay = this.winCauseDelay;
    const segFreeSpeedMps = this.seg.segFreeSpeedMps;
    const segLengthM = this.seg.segLengthM;
    const segCapacityVehH = this.seg.segCapacityVehH;
    const speedRatio = frame.speedRatio;
    const density = frame.density;
    const flowOut = frame.flow;
    const queueOut = frame.queueM;
    const congestedOut = frame.congestedShare;
    const delayVehOut = frame.delayVehS;
    const delayPersonOut = frame.delayPersonS;
    const vcOut = frame.vcRatio;
    const causeOut = frame.causeShare;
    for (let i = 0; i < n; i++) {
      const count = positive(winCount[i] as number);
      const free = segFreeSpeedMps[i] as number;
      speedRatio[i] = count > 0 && free > 0 ? positive(winSpeed[i] as number) / count / free : 0;
      const lengthKm = (segLengthM[i] as number) / METRES_PER_KM;
      density[i] = samples > 0 && lengthKm > 0 ? count / samples / lengthKm : 0;
      const flow = spanS > 0 ? (positive(winCrossings[i] as number) / spanS) * SECONDS_PER_HOUR : 0;
      flowOut[i] = flow;
      queueOut[i] = samples > 0 ? positive(winQueueM[i] as number) / samples : 0;
      congestedOut[i] = samples > 0 ? positive(winCongested[i] as number) / samples : 0;
      const delay = positive(winDelayVehS[i] as number);
      delayVehOut[i] = delay;
      delayPersonOut[i] = positive(winDelayPersonS[i] as number);
      const capacity = segCapacityVehH[i] as number;
      vcOut[i] = capacity > 0 ? flow / capacity : 0;

      const cellBase = i * CAUSE_COUNT;
      if (delay <= 0) {
        causeOut.fill(0, cellBase, cellBase + CAUSE_COUNT);
        continue;
      }
      let total = 0;
      for (let c = 0; c < CAUSE_COUNT; c++)
        total += positive(winCauseDelay[cellBase + c] as number);
      for (let c = 0; c < CAUSE_COUNT; c++) {
        causeOut[cellBase + c] =
          total > 0 ? positive(winCauseDelay[cellBase + c] as number) / total : 0;
      }
    }
  }
}

/**
 * Running sums are built by adding and evicting slots, so an emptied one is left holding float dust
 * rather than a clean zero. Anything under this is nothing: without the floor an emptied segment
 * would still report a full cause share, normalised out of 1e-15 seconds of delay.
 */
const SUM_EPS = 1e-9;

function positive(value: number): number {
  return value > SUM_EPS ? value : 0;
}
