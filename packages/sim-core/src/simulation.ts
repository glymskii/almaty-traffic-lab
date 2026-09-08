import {
  allocateMetricsFrame,
  applyConfigPatch,
  type BottleneckReport,
  causeCode,
  type FrameBuffers,
  isPeakHour,
  type MetricsFrame,
  type Network,
  type NetworkTotals,
  RUNTIME_SAFE_PARAM_PATHS,
  type SegmentDescriptor,
  SignalState,
  type SimConfig,
  type SimConfigPatch,
  VEHICLE_CLASS_BY_CODE,
  VEHICLE_CLASS_CODE,
  type VehicleClass,
  type VehicleClassParams,
  VehicleFlag,
} from "@atl/contracts";
import { sampleDriverInto } from "./models/driver.ts";
import { idmAcceleration, idmFreeAcceleration } from "./models/idm.ts";
import { Rng } from "./rng.ts";
import { SimClock } from "./runtime/clock.ts";
import { CLASS_COUNT, RuntimeNetwork } from "./runtime/network.ts";
import { TrajectoryHash } from "./runtime/trajectory-hash.ts";
import { VehiclePool } from "./runtime/vehicles.ts";

/**
 * The single public surface of sim-core. Everything else (IDM, MOBIL, signals, routing, buses,
 * pedestrians, metrics, detector) lives behind it. The worker, the CLI and the tests use only this.
 *
 * Invariants:
 *  - `step()` advances exactly `config.dtS` seconds and is deterministic for (network, config, scenarioId).
 *  - No DOM, no timers, no wall clock, no Math.random inside (see scripts/check-determinism.mjs).
 *  - Hot loops operate on structure-of-arrays typed arrays; no per-step allocations.
 */
export interface Simulation {
  readonly network: Network;
  readonly config: SimConfig;
  readonly scenarioId: string;
  readonly simTimeS: number;
  readonly timeOfDayMin: number;

  step(): void;
  /** Steps until simTimeS >= target. */
  runUntil(targetSimTimeS: number): void;

  vehicleCount(): number;
  /** Fills a caller-owned buffer (ping-pong with the worker). Returns the same object. */
  writeFrame(frame: FrameBuffers): FrameBuffers;

  segments(): SegmentDescriptor[];
  signalGroupIds(): string[];
  crosswalkIds(): string[];
  /** Windowed aggregates; the returned frame is caller-owned (fills the given one if provided). */
  writeMetrics(frame?: MetricsFrame): MetricsFrame;
  report(): BottleneckReport;

  /** Only RUNTIME_SAFE_PARAM_PATHS; throws on anything else. */
  setParams(patch: SimConfigPatch): void;

  /** Order-independent hash of (id, x, y, speed) of every vehicle, folded over all steps since creation. */
  trajectoryHash(): string;

  /** Trip counters since the end of warm-up; the cheap measurement tool for tests before metrics (T-18) exist. */
  tripStats(): TripStats;
}

export interface TripClassStats {
  spawned: number;
  completed: number;
  active: number;
  /** Mean over completed trips. */
  meanTripTimeS: number;
  /** Mean over completed trips: trip time minus free-flow time of the route. */
  meanTripDelayS: number;
  /** Mean stops per completed trip (speed crossing 0.5 m/s downward). */
  meanStops: number;
  /** Person-weighted delay over completed trips, person-seconds. */
  personDelayS: number;
}

export interface TripStats {
  simTimeS: number;
  /** Vehicles that could not spawn because the entry lane was occupied (cause spawn_wait). */
  spawnWaits: number;
  total: TripClassStats;
  byClass: Record<VehicleClass, TripClassStats>;
}

export interface CreateSimulationOptions {
  network: Network;
  config: SimConfig;
  scenarioId?: string;
}

/** Implemented in T-04 (kernel) and extended by later tasks; this signature is frozen. */
export function createSimulation(_opts: CreateSimulationOptions): Simulation {
  return new SimulationImpl(_opts);
}

/** Internal state of a simulation for kernel tests and debug tooling (not part of the frozen surface). */
export interface SimulationKernel {
  readonly runtime: RuntimeNetwork;
  readonly pool: VehiclePool;
  /** Trips per hour at profile value 1.0: `demand.tripsPerHourPeak` or the auto estimate. */
  readonly baseTripsPerHour: number;
  /**
   * Vehicles removed because their lane ended without a permitted continuation away from a gate or
   * dead end (lane ending mid-link, junction without a connector for the class). Not trips: they are
   * neither completed nor active. Non-zero means the network or the lane logic has a gap (T-10/T-12).
   */
  readonly droppedVehicles: number;
  /**
   * Per track: 0 = entry free, otherwise the cause code a vehicle reports while it waits at the end of
   * its current track because entering this track is not permitted. Filled by signals (T-09),
   * conflicts (T-11) and pedestrians (T-15); the kernel only reads it.
   */
  readonly entryBlockedCause: Uint8Array;
}

export function kernelOf(sim: Simulation): SimulationKernel {
  if (!(sim instanceof SimulationImpl)) throw new Error("kernelOf: not a sim-core simulation");
  return {
    runtime: sim.runtime,
    pool: sim.pool,
    baseTripsPerHour: sim.baseTripsPerHour,
    get droppedVehicles() {
      return sim.droppedVehicles;
    },
    entryBlockedCause: sim.entryBlockedCause,
  };
}

// ---------------------------------------------------------------------------
// Kernel constants
// ---------------------------------------------------------------------------

const CAUSE_FREE_FLOW = causeCode("free_flow");
const CAUSE_SPEED_LIMIT = causeCode("speed_limit");
const CAUSE_LEADER = causeCode("leader");

/** A vehicle cruising at or above this fraction of its desired speed reports `speed_limit`. */
const CRUISE_SPEED_RATIO = 0.95;
/** The leader is the binding constraint when it costs at least this much acceleration, m/s^2. */
const LEADER_BINDING_MPS2 = 0.1;
/** A vehicle without a leader on its track looks this far (metres) into the following tracks. */
const LOOKAHEAD_HORIZON_M = 250;
/** Arrivals wait at a gate for at most this much demand (seconds of the current rate) before they are discarded. */
const GATE_QUEUE_HORIZON_S = 120;
const LOOKAHEAD_MAX_TRACKS = 3;
/** Track transitions allowed in one step (chains of very short connectors). */
const MAX_HOPS_PER_STEP = 4;
/** Brake lights below this acceleration, m/s^2. */
const BRAKING_MPS2 = -0.3;
/** Auto demand when `tripsPerHourPeak = 0`: share of the summed capacity of the entry lanes. */
const AUTO_DEMAND_FACTOR = 0.7;
/** Fork labels of the master RNG, one per subsystem; fixed so later subsystems never shift earlier streams. */
const RNG_FORK_SPAWN = 0;
const RNG_FORK_DRIVERS = 1;

const CAR_CODE = VEHICLE_CLASS_CODE.car;
const BUS_CODE = VEHICLE_CLASS_CODE.bus;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SimulationImpl implements Simulation {
  readonly network: Network;
  readonly scenarioId: string;
  readonly runtime: RuntimeNetwork;
  readonly pool: VehiclePool;

  private cfg: SimConfig;
  private readonly clock: SimClock;
  private readonly spawnRng: Rng;
  private readonly driverRng: Rng;
  private readonly hash = new TrajectoryHash();

  /** Trips per hour at profile value 1.0 (explicit or auto-estimated at init). */
  readonly baseTripsPerHour: number;
  private readonly warmupEndS: number;

  // ---- spawn state per gate ----
  /** Remaining integrated intensity until the next arrival (Exp(1) in event units). */
  private readonly gateBudget: Float64Array;
  /** Arrivals that have not entered the network yet. */
  private readonly gateWaiting: Int32Array;
  /** How many of the waiting arrivals were already counted as spawn waits. */
  private readonly gateWaitCounted: Int32Array;
  private scratchTail = -1;

  /** See SimulationKernel.entryBlockedCause. */
  readonly entryBlockedCause: Uint8Array;
  /** See SimulationKernel.droppedVehicles. */
  droppedVehicles = 0;

  // ---- trip counters (after warm-up), indexed by class code ----
  private readonly activeByClass = new Int32Array(CLASS_COUNT);
  private readonly spawnedByClass = new Float64Array(CLASS_COUNT);
  private readonly completedByClass = new Float64Array(CLASS_COUNT);
  private readonly tripTimeByClass = new Float64Array(CLASS_COUNT);
  private readonly delayByClass = new Float64Array(CLASS_COUNT);
  private readonly stopsByClass = new Float64Array(CLASS_COUNT);
  private readonly personDelayByClass = new Float64Array(CLASS_COUNT);
  private spawnWaits = 0;

  constructor(opts: CreateSimulationOptions) {
    this.network = opts.network;
    this.cfg = opts.config;
    this.scenarioId = opts.scenarioId ?? "baseline";
    this.runtime = new RuntimeNetwork(opts.network, opts.config.metrics.segmentLengthM);
    this.pool = new VehiclePool(opts.config.demand.vehicleBudget, this.runtime.trackCount);
    this.clock = new SimClock(opts.config.dtS, opts.config.startTimeMin);
    const master = new Rng(opts.config.seed);
    this.spawnRng = master.fork(RNG_FORK_SPAWN);
    this.driverRng = master.fork(RNG_FORK_DRIVERS);

    const demand = opts.config.demand;
    this.baseTripsPerHour =
      demand.tripsPerHourPeak > 0
        ? demand.tripsPerHourPeak
        : AUTO_DEMAND_FACTOR *
          this.runtime.entryLaneCount *
          opts.config.signals.saturationFlowVehPerHPerLane;
    this.warmupEndS = demand.warmupMinutes * 60;

    this.entryBlockedCause = new Uint8Array(this.runtime.trackCount);

    const gateCount = this.runtime.gateCount;
    this.gateBudget = new Float64Array(gateCount);
    this.gateWaiting = new Int32Array(gateCount);
    this.gateWaitCounted = new Int32Array(gateCount);
    for (let g = 0; g < gateCount; g++) {
      if ((this.runtime.gateShare[g] as number) > 0)
        this.gateBudget[g] = this.spawnRng.exponential(1);
    }
  }

  get config(): SimConfig {
    return this.cfg;
  }

  get simTimeS(): number {
    return this.clock.simTimeS;
  }

  get timeOfDayMin(): number {
    return this.clock.timeOfDayMin;
  }

  // ---- stepping ----------------------------------------------------------

  step(): void {
    // The state produced by this step belongs to t + dt: advance the clock first so that every
    // time-dependent stage (profiles, peak hours, trip times) reads the same time.
    this.clock.advance();
    const dt = this.clock.dtS;
    const now = this.clock.simTimeS;
    // 1-5 (signals, pedestrians, routing, lane selection, lane changes): later tasks.
    this.computeAccelerations(); // 6
    this.integrate(dt, now); // 7
    this.repairOrder();
    this.spawn(dt, now); // 8
    this.updatePositions();
    this.foldHash();
  }

  runUntil(targetSimTimeS: number): void {
    while (this.clock.simTimeS < targetSimTimeS - 1e-9) this.step();
  }

  /**
   * Longitudinal model (ARCHITECTURE, step 6). Every vehicle starts from its free-road IDM
   * acceleration and then takes the minimum over its obstacles; the obstacle that wins becomes the
   * binding constraint (`cause`). Obstacles today: the leader (on this track or the first vehicle on
   * the tracks ahead) and a stop line at the end of the track when entering the next track is blocked
   * (`entryBlockedCause`, filled by later subsystems). Later tasks add obstacles to this loop.
   */
  private computeAccelerations(): void {
    const pool = this.pool;
    const rt = this.runtime;
    const track = pool.track;
    const s = pool.s;
    const v = pool.v;
    const a = pool.a;
    const ahead = pool.ahead;
    const len = pool.length;
    const cls = pool.cls;
    const nextTrack = pool.nextTrack;
    const cause = pool.cause;
    const tail = pool.trackTail;
    const trackStart = rt.trackStartS;
    const trackEnd = rt.trackEndS;
    const trackSpeed = rt.trackSpeedMps;
    const trackNext = rt.trackNextByClass;
    const entryBlocked = this.entryBlockedCause;
    const n = pool.highWater;
    for (let i = 0; i < n; i++) {
      const t = track[i] as number;
      if (t < 0) continue;
      const vi = v[i] as number;
      const si = s[i] as number;
      const v0 = (trackSpeed[t] as number) * (pool.speedFactor[i] as number);
      const aFree = idmFreeAcceleration(vi, v0, pool.maxAccel[i] as number);
      let acc = aFree;
      let c: number = vi >= CRUISE_SPEED_RATIO * v0 ? CAUSE_SPEED_LIMIT : CAUSE_FREE_FLOW;

      // Obstacle: the leader on this track, or the first vehicle on the tracks ahead.
      let leader = ahead[i] as number;
      let gap = Number.POSITIVE_INFINITY;
      if (leader >= 0) {
        gap = (s[leader] as number) - (len[leader] as number) - si;
      } else {
        let dist = (trackEnd[t] as number) - si;
        let nt = nextTrack[i] as number;
        for (
          let hop = 0;
          hop < LOOKAHEAD_MAX_TRACKS && nt >= 0 && dist < LOOKAHEAD_HORIZON_M;
          hop++
        ) {
          const candidate = tail[nt] as number;
          if (candidate >= 0) {
            leader = candidate;
            gap =
              dist +
              (s[candidate] as number) -
              (trackStart[nt] as number) -
              (len[candidate] as number);
            break;
          }
          dist += (trackEnd[nt] as number) - (trackStart[nt] as number);
          nt = trackNext[nt * CLASS_COUNT + (cls[i] as number)] as number;
        }
      }
      if (leader >= 0) {
        const aLeader = this.accelTowardObstacle(i, vi, v0, gap, v[leader] as number);
        if (aLeader < acc) {
          acc = aLeader;
          if (aFree - aLeader >= LEADER_BINDING_MPS2) c = CAUSE_LEADER;
        }
      }

      // Obstacle: stop line at the end of this track while entering the next track is blocked.
      const next = nextTrack[i] as number;
      if (next >= 0) {
        const blocked = entryBlocked[next] as number;
        if (blocked !== 0) {
          const aStop = this.accelTowardObstacle(i, vi, v0, (trackEnd[t] as number) - si, 0);
          if (aStop < acc) {
            acc = aStop;
            if (aFree - aStop >= LEADER_BINDING_MPS2) c = blocked;
          }
        }
      }

      a[i] = acc;
      cause[i] = c;
    }
  }

  /** IDM acceleration of vehicle `i` (speed `v`, desired `v0`) towards an obstacle `gap` metres ahead. */
  private accelTowardObstacle(
    i: number,
    v: number,
    v0: number,
    gap: number,
    vObstacle: number,
  ): number {
    const pool = this.pool;
    return idmAcceleration(
      v,
      v0,
      v - vObstacle,
      gap,
      pool.timeHeadway[i] as number,
      pool.minGap[i] as number,
      pool.maxAccel[i] as number,
      pool.comfortDecel[i] as number,
    );
  }

  /** Semi-implicit Euler: v += a dt, s += v dt; track transitions and exits at track ends. */
  private integrate(dt: number, now: number): void {
    const pool = this.pool;
    const rt = this.runtime;
    const track = pool.track;
    const s = pool.s;
    const v = pool.v;
    const a = pool.a;
    const flags = pool.flags;
    const persistent = pool.persistentFlags;
    const stops = pool.stops;
    const trackEnd = rt.trackEndS;
    const laneCount = rt.laneCount;
    const stoppedV = this.cfg.metrics.stoppedSpeedMps;
    const n = pool.highWater;
    for (let i = 0; i < n; i++) {
      const t = track[i] as number;
      if (t < 0) continue;
      const ai = a[i] as number;
      const vOld = v[i] as number;
      let vNew = vOld + ai * dt;
      if (vNew < 0) vNew = 0;
      if (vOld > stoppedV && vNew <= stoppedV) stops[i] = (stops[i] as number) + 1;
      v[i] = vNew;
      const sNew = (s[i] as number) + vNew * dt;
      let fl = 0;
      if (ai < BRAKING_MPS2) fl |= VehicleFlag.BRAKING;
      if (vNew <= stoppedV) fl |= VehicleFlag.STOPPED;
      if (sNew >= (trackEnd[t] as number)) {
        if (!this.advanceTrack(i, sNew, now)) continue; // left the network
      } else {
        s[i] = sNew;
      }
      if ((track[i] as number) >= laneCount) fl |= VehicleFlag.IN_INTERSECTION;
      flags[i] = (persistent[i] as number) | fl;
    }
  }

  /** Moves vehicle `i`, whose new coordinate `sBeyond` passed the end of its track. False when it left. */
  private advanceTrack(i: number, sBeyond: number, now: number): boolean {
    const pool = this.pool;
    const rt = this.runtime;
    let t = pool.track[i] as number;
    let sPos = sBeyond;
    for (let hop = 0; hop < MAX_HOPS_PER_STEP; hop++) {
      const next = pool.nextTrack[i] as number;
      if (next < 0) {
        if (rt.trackIsExit[t] === 1) this.despawn(i, now);
        else this.drop(i);
        return false;
      }
      const overshoot = sPos - (rt.trackEndS[t] as number);
      pool.remove(i);
      t = next;
      const end = rt.trackEndS[t] as number;
      sPos = (rt.trackStartS[t] as number) + overshoot;
      const last = hop === MAX_HOPS_PER_STEP - 1;
      if (last && sPos >= end) sPos = end - 0.001; // pathological chain of tiny tracks: finish next step
      pool.s[i] = sPos;
      pool.geomSeg[i] = 0;
      pool.nextTrack[i] = rt.trackNextByClass[t * CLASS_COUNT + (pool.cls[i] as number)] as number;
      pool.freeFlowTimeS[i] =
        (pool.freeFlowTimeS[i] as number) +
        (end - (rt.trackStartS[t] as number)) /
          ((rt.trackSpeedMps[t] as number) * (pool.speedFactor[i] as number));
      pool.insert(t, i);
      if (sPos < end) return true;
    }
    return true;
  }

  private despawn(i: number, now: number): void {
    const pool = this.pool;
    const c = pool.cls[i] as number;
    this.activeByClass[c] = (this.activeByClass[c] as number) - 1;
    if (pool.countsInStats[i] === 1) {
      const trip = now - (pool.spawnTimeS[i] as number);
      let delay = trip - (pool.freeFlowTimeS[i] as number);
      if (delay < 0) delay = 0;
      this.completedByClass[c] = (this.completedByClass[c] as number) + 1;
      this.tripTimeByClass[c] = (this.tripTimeByClass[c] as number) + trip;
      this.delayByClass[c] = (this.delayByClass[c] as number) + delay;
      this.stopsByClass[c] = (this.stopsByClass[c] as number) + (pool.stops[i] as number);
      this.personDelayByClass[c] =
        (this.personDelayByClass[c] as number) + delay * (pool.occupancy[i] as number);
    }
    pool.remove(i);
    pool.release(i);
  }

  /** Removes a vehicle that ran out of lane away from any exit; not a trip (see droppedVehicles). */
  private drop(i: number): void {
    const pool = this.pool;
    const c = pool.cls[i] as number;
    this.activeByClass[c] = (this.activeByClass[c] as number) - 1;
    this.droppedVehicles++;
    pool.remove(i);
    pool.release(i);
  }

  /** Keeps every track list sorted by `s` (a no-op walk unless a follower overtook its leader). */
  private repairOrder(): void {
    const pool = this.pool;
    const tail = pool.trackTail;
    const n = this.runtime.trackCount;
    for (let t = 0; t < n; t++) {
      if ((tail[t] as number) >= 0) pool.sortTrack(t);
    }
  }

  /**
   * Poisson arrivals per gate (intensity from the hourly profile), placed when an entry lane has room.
   * Arrivals that cannot enter wait in a per-gate counter capped at GATE_QUEUE_HORIZON_S seconds of
   * the current rate, so a lower multiplier takes effect at once even behind a queue.
   */
  private spawn(dt: number, now: number): void {
    const cfg = this.cfg;
    const demand = cfg.demand;
    const rt = this.runtime;
    const pool = this.pool;
    const profile = demand.hourlyProfile[this.clock.hourOfDay] ?? 0;
    const ratePerS = (this.baseTripsPerHour * profile * demand.multiplier) / 3600;
    const afterWarmup = now >= this.warmupEndS;
    const peak = isPeakHour(cfg, this.clock.timeOfDayMin);
    const entryGapM = cfg.driver.minGapM.max;
    for (let g = 0; g < rt.gateCount; g++) {
      const share = rt.gateShare[g] as number;
      if (share <= 0) continue;
      const gateRate = ratePerS * share;
      let budget = (this.gateBudget[g] as number) - gateRate * dt;
      let waiting = this.gateWaiting[g] as number;
      while (budget <= 0) {
        waiting++;
        budget += this.spawnRng.exponential(1);
      }
      this.gateBudget[g] = budget;
      const cap = Math.ceil(gateRate * GATE_QUEUE_HORIZON_S);
      if (waiting > cap) waiting = cap;
      this.gateWaiting[g] = waiting;
      if ((this.gateWaitCounted[g] as number) > waiting) this.gateWaitCounted[g] = waiting;

      let blockedByLane = false;
      while ((this.gateWaiting[g] as number) > 0) {
        if (pool.freeCount === 0) break; // vehicle budget: arrivals keep waiting
        const cls: VehicleClass = this.spawnRng.chance(demand.taxiShare) ? "taxi" : "car";
        const clsParams = cfg.vehicleClasses[cls];
        const lane = this.bestEntryLane(g, VEHICLE_CLASS_CODE[cls], clsParams.lengthM + entryGapM);
        if (lane < 0) {
          blockedByLane = true;
          break;
        }
        this.place(lane, cls, clsParams, peak, now, afterWarmup);
        this.gateWaiting[g] = (this.gateWaiting[g] as number) - 1;
        if ((this.gateWaitCounted[g] as number) > 0)
          this.gateWaitCounted[g] = (this.gateWaitCounted[g] as number) - 1;
      }
      if (blockedByLane && afterWarmup) {
        const uncounted = (this.gateWaiting[g] as number) - (this.gateWaitCounted[g] as number);
        if (uncounted > 0) {
          this.spawnWaits += uncounted;
          this.gateWaitCounted[g] = this.gateWaiting[g] as number;
        }
      }
    }
  }

  /**
   * Entry lane of gate `g` with the largest free space at its start among lanes admitting the class
   * (ties go to the rightmost lane), or -1 when none has at least `needM` metres. Leaves the lane's
   * last vehicle in `scratchTail`.
   */
  private bestEntryLane(g: number, clsCode: number, needM: number): number {
    const rt = this.runtime;
    const pool = this.pool;
    const bit = 1 << clsCode;
    const start = rt.gateLaneStart[g] as number;
    const count = rt.gateLaneCount[g] as number;
    let best = -1;
    let bestGap = Number.NEGATIVE_INFINITY;
    let bestTail = -1;
    for (let k = 0; k < count; k++) {
      const lane = rt.gateLanes[start + k] as number;
      if (((rt.trackAllowedMask[lane] as number) & bit) === 0) continue;
      const tail = pool.trackTail[lane] as number;
      const gap =
        tail >= 0
          ? (pool.s[tail] as number) -
            (pool.length[tail] as number) -
            (rt.trackStartS[lane] as number)
          : Number.POSITIVE_INFINITY;
      if (gap >= bestGap) {
        bestGap = gap;
        best = lane;
        bestTail = tail;
      }
    }
    if (best < 0 || bestGap < needM) return -1;
    this.scratchTail = bestTail;
    return best;
  }

  private place(
    lane: number,
    cls: VehicleClass,
    clsParams: VehicleClassParams,
    peak: boolean,
    now: number,
    afterWarmup: boolean,
  ): void {
    const rt = this.runtime;
    const pool = this.pool;
    const i = pool.alloc();
    sampleDriverInto(
      pool,
      i,
      this.driverRng,
      this.cfg.driver,
      cls,
      clsParams,
      peak ? clsParams.occupancyPeak : clsParams.occupancyOffpeak,
    );
    const sSpawn = (rt.trackStartS[lane] as number) + (pool.length[i] as number);
    const v0 = (rt.trackSpeedMps[lane] as number) * (pool.speedFactor[i] as number);
    let vEntry = v0;
    const tail = this.scratchTail;
    if (tail >= 0) {
      // Enter at the speed whose IDM equilibrium gap (s0 + v T) matches the available gap.
      const gap = (pool.s[tail] as number) - (pool.length[tail] as number) - sSpawn;
      const vEq = (gap - (pool.minGap[i] as number)) / (pool.timeHeadway[i] as number);
      if (vEq < vEntry) vEntry = vEq > 0 ? vEq : 0;
    }
    pool.s[i] = sSpawn;
    pool.v[i] = vEntry;
    pool.a[i] = 0;
    pool.nextTrack[i] = rt.trackNextByClass[lane * CLASS_COUNT + (pool.cls[i] as number)] as number;
    pool.geomSeg[i] = 0;
    pool.persistentFlags[i] = 0;
    pool.flags[i] = vEntry <= this.cfg.metrics.stoppedSpeedMps ? VehicleFlag.STOPPED : 0;
    pool.cause[i] = CAUSE_FREE_FLOW;
    pool.rootCause[i] = CAUSE_FREE_FLOW;
    pool.spawnTimeS[i] = now;
    pool.freeFlowTimeS[i] = ((rt.trackEndS[lane] as number) - sSpawn) / v0;
    pool.stops[i] = 0;
    pool.countsInStats[i] = afterWarmup ? 1 : 0;
    pool.insert(lane, i);
    const c = pool.cls[i] as number;
    this.activeByClass[c] = (this.activeByClass[c] as number) + 1;
    if (afterWarmup) this.spawnedByClass[c] = (this.spawnedByClass[c] as number) + 1;
  }

  /** World position and heading of every vehicle from its track polyline and lateral offset. */
  private updatePositions(): void {
    const pool = this.pool;
    const rt = this.runtime;
    const track = pool.track;
    const s = pool.s;
    const geomSeg = pool.geomSeg;
    const n = pool.highWater;
    for (let i = 0; i < n; i++) {
      const t = track[i] as number;
      if (t < 0) continue;
      const p = rt.trackPoly[t] as number;
      const d = (s[i] as number) * (rt.polyScale[p] as number);
      const seg = rt.locate(p, d, geomSeg[i] as number);
      geomSeg[i] = seg;
      const k = (rt.polyStart[p] as number) + seg;
      const along = d - (rt.pcum[k] as number);
      const ux = rt.segUx[k] as number;
      const uy = rt.segUy[k] as number;
      const off = rt.trackOffsetM[t] as number;
      pool.x[i] = (rt.px[k] as number) + ux * along + uy * off;
      pool.y[i] = (rt.py[k] as number) + uy * along - ux * off;
      pool.heading[i] = rt.segAngle[k] as number;
    }
  }

  private foldHash(): void {
    const pool = this.pool;
    const track = pool.track;
    const n = pool.highWater;
    this.hash.beginStep();
    for (let i = 0; i < n; i++) {
      if ((track[i] as number) < 0) continue;
      this.hash.add(
        pool.id[i] as number,
        pool.x[i] as number,
        pool.y[i] as number,
        pool.v[i] as number,
      );
    }
    this.hash.endStep();
  }

  // ---- outputs -----------------------------------------------------------

  vehicleCount(): number {
    return this.pool.activeCount;
  }

  writeFrame(frame: FrameBuffers): FrameBuffers {
    const pool = this.pool;
    const track = pool.track;
    const cap = frame.capacity;
    const n = pool.highWater;
    let out = 0;
    for (let i = 0; i < n && out < cap; i++) {
      if ((track[i] as number) < 0) continue;
      frame.id[out] = pool.id[i] as number;
      frame.x[out] = pool.x[i] as number;
      frame.y[out] = pool.y[i] as number;
      frame.heading[out] = pool.heading[i] as number;
      frame.speed[out] = pool.v[i] as number;
      frame.cls[out] = pool.cls[i] as number;
      frame.flags[out] = pool.flags[i] as number;
      frame.cause[out] = pool.cause[i] as number;
      out++;
    }
    frame.count = out;
    frame.simTimeS = this.clock.simTimeS;
    // Signals are not simulated yet (T-09): report every group as OFF rather than pretending a colour.
    frame.signalStates.fill(SignalState.OFF);
    frame.crosswalkPeds.fill(0);
    return frame;
  }

  /** Fresh array of frozen descriptors: callers may reorder the array but not edit a segment. */
  segments(): SegmentDescriptor[] {
    return this.runtime.segments.slice();
  }

  signalGroupIds(): string[] {
    return this.runtime.signalGroupIds.slice();
  }

  crosswalkIds(): string[] {
    return this.runtime.crosswalkIds.slice();
  }

  /** Metrics arrive with T-18; until then every aggregate is zero. */
  writeMetrics(frame?: MetricsFrame): MetricsFrame {
    const segmentCount = this.runtime.segments.length;
    const windowS = this.cfg.metrics.windowS;
    const f = frame ?? allocateMetricsFrame(segmentCount, windowS);
    f.simTimeS = this.clock.simTimeS;
    f.timeOfDayMin = this.clock.timeOfDayMin;
    f.windowS = windowS;
    f.segmentCount = segmentCount;
    f.speedRatio.fill(0);
    f.density.fill(0);
    f.flow.fill(0);
    f.queueM.fill(0);
    f.congestedShare.fill(0);
    f.delayVehS.fill(0);
    f.delayPersonS.fill(0);
    f.vcRatio.fill(0);
    f.causeShare.fill(0);
    return f;
  }

  /** The detector arrives with T-19; until then the report carries live totals and no items. */
  report(): BottleneckReport {
    return {
      simTimeS: this.clock.simTimeS,
      timeOfDayMin: this.clock.timeOfDayMin,
      windowS: this.cfg.metrics.windowS,
      totals: this.totals(),
      items: [],
    };
  }

  private totals(): NetworkTotals {
    const pool = this.pool;
    const track = pool.track;
    const stoppedV = this.cfg.metrics.stoppedSpeedMps;
    let active = 0;
    let stopped = 0;
    let speedSum = 0;
    let carCount = 0;
    let carSpeed = 0;
    let busCount = 0;
    let busSpeed = 0;
    for (let i = 0; i < pool.highWater; i++) {
      if ((track[i] as number) < 0) continue;
      const vi = pool.v[i] as number;
      active++;
      speedSum += vi;
      if (vi <= stoppedV) stopped++;
      const c = pool.cls[i] as number;
      if (c === CAR_CODE) {
        carCount++;
        carSpeed += vi;
      } else if (c === BUS_CODE) {
        busCount++;
        busSpeed += vi;
      }
    }
    let completed = 0;
    let delayS = 0;
    let personDelayS = 0;
    for (let c = 0; c < CLASS_COUNT; c++) {
      completed += this.completedByClass[c] as number;
      delayS += this.delayByClass[c] as number;
      personDelayS += this.personDelayByClass[c] as number;
    }
    return {
      vehiclesActive: active,
      vehiclesCompleted: completed,
      delayVehH: delayS / 3600,
      delayPersonH: personDelayS / 3600,
      meanSpeedKph: active > 0 ? (speedSum / active) * 3.6 : 0,
      carMeanSpeedKph: carCount > 0 ? (carSpeed / carCount) * 3.6 : 0,
      busMeanSpeedKph: busCount > 0 ? (busSpeed / busCount) * 3.6 : 0,
      stoppedShare: active > 0 ? stopped / active : 0,
      congestedSegmentShare: 0,
    };
  }

  setParams(patch: SimConfigPatch): void {
    const paths: string[] = [];
    collectLeafPaths(patch, "", paths);
    for (const p of paths) {
      if (!RUNTIME_SAFE_PARAM_PATHS.includes(p)) {
        throw new Error(
          `setParams: "${p}" is not runtime-safe (allowed: ${RUNTIME_SAFE_PARAM_PATHS.join(", ")})`,
        );
      }
    }
    if (paths.length === 0) return;
    const multiplierBefore = this.cfg.demand.multiplier;
    this.cfg = applyConfigPatch(this.cfg, patch);
    if (this.cfg.demand.multiplier < multiplierBefore) {
      // Demand went down: arrivals queued under the old rate must not keep entering.
      this.gateWaiting.fill(0);
      this.gateWaitCounted.fill(0);
    }
  }

  trajectoryHash(): string {
    return this.hash.hex();
  }

  tripStats(): TripStats {
    const byClass = {} as Record<VehicleClass, TripClassStats>;
    const total: TripClassStats = {
      spawned: 0,
      completed: 0,
      active: 0,
      meanTripTimeS: 0,
      meanTripDelayS: 0,
      meanStops: 0,
      personDelayS: 0,
    };
    let tripSum = 0;
    let delaySum = 0;
    let stopSum = 0;
    for (let c = 0; c < CLASS_COUNT; c++) {
      const cls = VEHICLE_CLASS_BY_CODE[c];
      if (!cls) continue;
      const completed = this.completedByClass[c] as number;
      const trip = this.tripTimeByClass[c] as number;
      const delay = this.delayByClass[c] as number;
      const stops = this.stopsByClass[c] as number;
      byClass[cls] = {
        spawned: this.spawnedByClass[c] as number,
        completed,
        active: this.activeByClass[c] as number,
        meanTripTimeS: completed > 0 ? trip / completed : 0,
        meanTripDelayS: completed > 0 ? delay / completed : 0,
        meanStops: completed > 0 ? stops / completed : 0,
        personDelayS: this.personDelayByClass[c] as number,
      };
      total.spawned += this.spawnedByClass[c] as number;
      total.completed += completed;
      total.active += this.activeByClass[c] as number;
      total.personDelayS += this.personDelayByClass[c] as number;
      tripSum += trip;
      delaySum += delay;
      stopSum += stops;
    }
    if (total.completed > 0) {
      total.meanTripTimeS = tripSum / total.completed;
      total.meanTripDelayS = delaySum / total.completed;
      total.meanStops = stopSum / total.completed;
    }
    return { simTimeS: this.clock.simTimeS, spawnWaits: this.spawnWaits, total, byClass };
  }
}

function collectLeafPaths(value: unknown, prefix: string, out: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (prefix !== "") out.push(prefix);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    collectLeafPaths(child, prefix === "" ? key : `${prefix}.${key}`, out);
  }
}
