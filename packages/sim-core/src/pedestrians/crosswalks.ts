import { type Network, type PedestrianConfig, SignalState } from "@atl/contracts";
import { ArrivalQueues } from "../demand/spawner.ts";
import type { Rng } from "../rng.ts";
import type { RuntimeNetwork } from "../runtime/network.ts";

/**
 * Concurrent walkers a single crosswalk can hold before the rest simply keep waiting one more step.
 * Generous relative to any realistic pedestrian count on one zebra (`crosswalkPeds` itself saturates
 * at 255 in the wire format), so this is a memory bound, never an observed behaviour.
 */
const MAX_WALKERS_PER_CROSSWALK = 64;
/**
 * Waiting pedestrians beyond this many seconds of the current arrival rate are dropped, mirroring
 * `GATE_QUEUE_HORIZON_S` for vehicle arrivals (`simulation.ts`): a busy signal cycle must not grow the
 * queue without bound, and a lower demand multiplier must take effect at once even behind one.
 */
const PEDESTRIAN_QUEUE_HORIZON_S = 120;
/** Rate multiplier for a crosswalk at a node with an attractor nearby (card item 1). */
const ATTRACTOR_RATE_FACTOR = 1.5;
const DEFAULT_RATE_FACTOR = 1;

function isWalkState(state: number): boolean {
  return state === SignalState.GREEN || state === SignalState.FLASHING_GREEN;
}

/**
 * Pedestrian flow on crosswalks (docs/tasks/T-15). One instance covers every crosswalk of the
 * network; a crosswalk is addressed by its index in `RuntimeNetwork.crosswalkIds` (== `net.crosswalks`
 * order) throughout.
 *
 * Arrivals are a Poisson process per crosswalk, same construction as vehicle arrivals
 * (`demand/spawner.ts`): `hourlyRatePerCrosswalk[hour] * rateFactor` events per hour, rate factor 1.5
 * at a node with an attractor nearby (item 1), else 1. A crosswalk admits pedestrians to start
 * crossing only while it may: an unsignalized zebra always, a signalized one only while its
 * pedestrian group is GREEN or FLASHING_GREEN (read from `SignalRuntime.groupState`, computed once
 * per step by `updateSignals` -- this class never runs its own signal state machine, per the T-09
 * review note). Once walking, a pedestrian always finishes crossing at `walkSpeedMps`, even into red.
 *
 * A crosswalk's individual walkers are not modelled beyond a start time: `walkSpeedMps` and a
 * crosswalk's `lengthM` are both fixed, so every walker on the same crosswalk takes the same
 * `lengthM / walkSpeedMps` seconds and they finish in the order they started -- a plain FIFO ring
 * buffer per crosswalk is enough to know how many are on it at any time, with no per-walker position
 * needed anywhere downstream (`crosswalkPeds` only ever reports a count; T-15 explicitly excludes
 * rendering individual pedestrians).
 */
export class PedestrianRuntime {
  readonly crosswalkCount: number;
  readonly enabled: boolean;

  private readonly durationS: Float64Array;
  /** Global signal group index (RuntimeNetwork order), -1 = unsignalized. */
  private readonly signalGroup: Int32Array;
  private readonly rateFactor: Float64Array;
  private readonly hourlyRate: readonly number[];

  private readonly arrivals: ArrivalQueues;
  /** 1 while a crosswalk may currently admit a new walker (refreshed by `update`). */
  private readonly canStartNow: Uint8Array;
  /** Arrival rate last used for this crosswalk, events/s (refreshed by `update`), for `threatTimeS`. */
  private readonly currentRatePerS: Float64Array;

  // Ring buffer of active walkers, flat [crosswalk * MAX_WALKERS_PER_CROSSWALK + slot].
  private readonly startS: Float64Array;
  /** Logical (monotonic, not wrapped) head/tail per crosswalk; active count = tail - head. */
  private readonly head: Int32Array;
  private readonly tail: Int32Array;

  constructor(net: Network, rt: RuntimeNetwork, cfg: PedestrianConfig, rng: Rng) {
    this.enabled = cfg.enabled;
    this.hourlyRate = cfg.hourlyRatePerCrosswalk;
    const walkSpeedMps = cfg.walkSpeedMps;

    const count = net.crosswalks.length;
    this.crosswalkCount = count;
    this.durationS = new Float64Array(count);
    this.signalGroup = new Int32Array(count).fill(-1);
    this.rateFactor = new Float64Array(count).fill(DEFAULT_RATE_FACTOR);
    this.canStartNow = new Uint8Array(count);
    this.currentRatePerS = new Float64Array(count);
    this.startS = new Float64Array(count * MAX_WALKERS_PER_CROSSWALK);
    this.head = new Int32Array(count);
    this.tail = new Int32Array(count);

    const attractorNodes = new Set<number>();
    for (const a of net.attractors) {
      const idx = rt.nodeIndex.get(a.nodeId);
      if (idx !== undefined) attractorNodes.add(idx);
    }
    for (let i = 0; i < count; i++) {
      const cw = net.crosswalks[i];
      if (!cw) continue;
      this.durationS[i] = cw.lengthM / walkSpeedMps;
      if (cw.signalGroupId !== undefined) {
        this.signalGroup[i] = rt.signalGroupIndex.get(cw.signalGroupId) ?? -1;
      }
      const nodeIdx = rt.nodeIndex.get(cw.nodeId);
      if (nodeIdx !== undefined && attractorNodes.has(nodeIdx)) {
        this.rateFactor[i] = ATTRACTOR_RATE_FACTOR;
      }
    }

    const shares = new Float64Array(count).fill(this.enabled ? 1 : 0);
    this.arrivals = new ArrivalQueues(count, shares, rng);
  }

  /**
   * Pedestrians (ARCHITECTURE step 2): advances every crosswalk's arrival process by `dt`, lets
   * whichever ones may start right now promote waiting pedestrians into walkers, and drops walkers
   * that have finished crossing. `groupState` is `SignalRuntime.groupState` as computed by
   * `updateSignals` earlier in the same step, indexed by the same global group index used above --
   * this class never recomputes it (T-09 review note).
   */
  update(dt: number, now: number, hourOfDay: number, groupState: Uint8Array, rng: Rng): void {
    if (!this.enabled) return;
    const rate = this.hourlyRate[hourOfDay] ?? 0;
    for (let cw = 0; cw < this.crosswalkCount; cw++) {
      const ratePerS = (rate * (this.rateFactor[cw] as number)) / 3600;
      this.currentRatePerS[cw] = ratePerS;
      this.arrivals.advance(cw, ratePerS, dt, PEDESTRIAN_QUEUE_HORIZON_S, rng);

      const group = this.signalGroup[cw] as number;
      const canStart = group < 0 || isWalkState(groupState[group] as number);
      this.canStartNow[cw] = canStart ? 1 : 0;
      if (canStart) this.promote(cw, now);
      this.expire(cw, now);
    }
  }

  /** Moves waiting pedestrians into the walking ring buffer, up to `MAX_WALKERS_PER_CROSSWALK`. */
  private promote(cw: number, now: number): void {
    const base = cw * MAX_WALKERS_PER_CROSSWALK;
    while ((this.arrivals.waiting[cw] as number) > 0) {
      if ((this.tail[cw] as number) - (this.head[cw] as number) >= MAX_WALKERS_PER_CROSSWALK) break;
      const slot = (this.tail[cw] as number) % MAX_WALKERS_PER_CROSSWALK;
      this.startS[base + slot] = now;
      this.tail[cw] = (this.tail[cw] as number) + 1;
      this.arrivals.take(cw);
    }
  }

  /** Drops walkers whose `lengthM / walkSpeedMps` has elapsed; they finish even on red (card item 1). */
  private expire(cw: number, now: number): void {
    const base = cw * MAX_WALKERS_PER_CROSSWALK;
    const duration = this.durationS[cw] as number;
    while ((this.tail[cw] as number) > (this.head[cw] as number)) {
      const slot = (this.head[cw] as number) % MAX_WALKERS_PER_CROSSWALK;
      if (now < (this.startS[base + slot] as number) + duration) break;
      this.head[cw] = (this.head[cw] as number) + 1;
    }
  }

  /** Pedestrians currently on crosswalk `cw`. */
  activeCount(cw: number): number {
    return (this.tail[cw] as number) - (this.head[cw] as number);
  }

  /** Pedestrians waiting at crosswalk `cw` (mostly transient: `update` promotes them the same step). */
  waitingCount(cw: number): number {
    return this.arrivals.waiting[cw] as number;
  }

  /**
   * Seconds until crosswalk `cw` next threatens a vehicle crossing it, the same shape as
   * `IntersectionRuntime.threatTimeS` (T-11): 0 when a pedestrian is on it or one is already waiting
   * to step on (an imminent threat, occupied or not), +Infinity while it cannot admit a new one at all
   * (a signalized zebra outside its own green), and otherwise the arrival process's own estimate of
   * its next event (`budget` is remaining Exp(1) intensity; dividing by the current rate turns it into
   * an expected number of seconds), so a driver with a larger `criticalGapPedestrianS` starts yielding
   * to a busy zebra earlier, before anyone has actually stepped out.
   */
  threatTimeS(cw: number): number {
    if (this.activeCount(cw) > 0) return 0;
    if (this.canStartNow[cw] === 0) return Number.POSITIVE_INFINITY;
    if ((this.arrivals.waiting[cw] as number) > 0) return 0;
    const rate = this.currentRatePerS[cw] as number;
    if (!(rate > 0)) return Number.POSITIVE_INFINITY;
    return (this.arrivals.budget[cw] as number) / rate;
  }

  /** Fills `out[cw]` with the walker count on every crosswalk, clamped to the Uint8 wire format. */
  writeCounts(out: Uint8Array): void {
    const n = Math.min(out.length, this.crosswalkCount);
    for (let cw = 0; cw < n; cw++) {
      const active = this.activeCount(cw);
      out[cw] = active > 255 ? 255 : active;
    }
    for (let cw = n; cw < out.length; cw++) out[cw] = 0;
  }
}
