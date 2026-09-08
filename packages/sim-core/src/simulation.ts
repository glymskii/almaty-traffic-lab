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
  type TurnKind,
  VEHICLE_CLASS_BY_CODE,
  VEHICLE_CLASS_CODE,
  type VehicleClass,
  type VehicleClassParams,
  VehicleFlag,
} from "@atl/contracts";
import { OdModel } from "./demand/od.ts";
import { tripRatePerS } from "./demand/profile.ts";
import { ArrivalQueues } from "./demand/spawner.ts";
import { MetricsAccumulators } from "./metrics/accumulators.ts";
import { RootCauseResolver } from "./metrics/rootCause.ts";
import { SegmentIndex } from "./metrics/segments.ts";
import { TotalsTracker } from "./metrics/totals.ts";
import { sampleDriverInto } from "./models/driver.ts";
import { idmAcceleration, idmFreeAcceleration } from "./models/idm.ts";
import { mandatoryBias, mobilIncentive, mobilSafe } from "./models/mobil.ts";
import { PedestrianRuntime } from "./pedestrians/crosswalks.ts";
import { Rng } from "./rng.ts";
import { ROUTE_ARRIVE, ROUTE_UNREACHABLE } from "./routing/dijkstra.ts";
import { RoutingGraph } from "./routing/graph.ts";
import { ROUTE_COPIES, RouteTrees } from "./routing/trees.ts";
import { SimClock } from "./runtime/clock.ts";
import { IntersectionRuntime } from "./runtime/intersections.ts";
import { LaneRuntime } from "./runtime/lanes.ts";
import { yieldCauseByTurn } from "./runtime/merges.ts";
import { CLASS_COUNT, RuntimeNetwork } from "./runtime/network.ts";
import { SignalRuntime } from "./runtime/signals.ts";
import { TrajectoryHash } from "./runtime/trajectory-hash.ts";
import { TURN_COUNT, TurnCode, turnBit } from "./runtime/turns.ts";
import { VehiclePool } from "./runtime/vehicles.ts";
import { BusScheduleRuntime, type TransitRoute } from "./transit/schedule.ts";
import { BusStopRuntime } from "./transit/stops.ts";

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
  /**
   * Per track: 1 when `entryBlockedCause` is a main signal group currently YELLOW, meaning the block
   * is conditional (the dilemma-zone rule in `computeAccelerations` may ignore it for a vehicle that
   * cannot stop comfortably), 0 for every other reason (RED, RED_YELLOW, arrow_off, or unset).
   */
  readonly entryBlockedYellow: Uint8Array;
  /** Precomputed signal-group state machine (T-09); see `runtime/signals.ts`. */
  readonly signals: SignalRuntime;
  /** Lane-level access rights and turn service (T-10); see `runtime/lanes.ts`. */
  readonly lanes: LaneRuntime;
  /** Conflict points, gap acceptance and gridlock (T-11); see `runtime/intersections.ts`. */
  readonly intersections: IntersectionRuntime;
  /** Crosswalk arrivals, walkers and yield gap acceptance (T-15); see `pedestrians/crosswalks.ts`. */
  readonly pedestrians: PedestrianRuntime;
  /** Segment lookup, lengths and capacities behind the metrics window (T-18); see `metrics/segments.ts`. */
  readonly segmentIndex: SegmentIndex;
  /**
   * The sliding window itself (T-18). `MetricsFrame` is a frozen contract with no field for stops,
   * so `metricsWindow.stopsInWindow(segment)` is the only way to read them; `vcRatio(segment)` is
   * the same V/C the frame carries, without folding a whole frame to get one number.
   */
  readonly metricsWindow: MetricsAccumulators;
  /** Per vehicle slot: 1 when the driver refuses to enter a junction whose exit is full (T-11). */
  readonly gridlockDisciplined: Uint8Array;
  /** Link-level routing graph (T-12); see `routing/graph.ts`. */
  readonly routingGraph: RoutingGraph;
  /** Origin-destination model (T-12); see `demand/od.ts`. */
  readonly od: OdModel;
  /** Static "next link" forest with `ROUTE_COPIES` perturbed copies; see `routing/trees.ts`. */
  readonly routeTrees: RouteTrees;
  /** Measured travel time per link, EMA over the vehicles that finished it (navigator costs). */
  readonly liveTravelS: Float64Array;
  /**
   * Trips whose destination became unreachable mid-route (a missed turn lane onto a one-way street,
   * a scenario override) and were retargeted to another gate. Non-zero is not an error, but a large
   * share means the network or the lane logic loses vehicles.
   */
  readonly retargetedTrips: number;
  /** Rebuilds the static forest from the free-flow costs (tests and benchmarks). */
  rebuildRouteTrees(): void;
  /** Rebuilds the navigator forest from the live costs right now (tests and benchmarks). */
  rebuildLiveTrees(): void;
  /**
   * Forces the distribution of the next manoeuvre for vehicles entering `linkId`, replacing the
   * route (and, without a route, the uniform draw over the movements the link offers). Shares are
   * relative weights over the movements that actually exist for the vehicle's class; a movement
   * with weight 0 is never chosen. The way nuance tests dial turning demand up and down.
   */
  setTurnShares(linkId: string, shares: Partial<Record<TurnKind, number>>): void;
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
    entryBlockedYellow: sim.entryBlockedYellow,
    signals: sim.signals,
    lanes: sim.lanes,
    intersections: sim.intersections,
    pedestrians: sim.pedestrians,
    segmentIndex: sim.segmentIndex,
    metricsWindow: sim.metricsWindow,
    gridlockDisciplined: sim.gridlockDisciplined,
    routingGraph: sim.routingGraph,
    od: sim.od,
    routeTrees: sim.routeTrees,
    liveTravelS: sim.liveTravelS,
    get retargetedTrips() {
      return sim.retargetedTrips;
    },
    rebuildRouteTrees: () => {
      sim.rebuildRouteTrees();
    },
    rebuildLiveTrees: () => {
      sim.rebuildLiveTrees();
    },
    setTurnShares: (linkId, shares) => {
      sim.setTurnShares(linkId, shares);
    },
  };
}

// ---------------------------------------------------------------------------
// Kernel constants
// ---------------------------------------------------------------------------

const CAUSE_FREE_FLOW = causeCode("free_flow");
const CAUSE_SPEED_LIMIT = causeCode("speed_limit");
const CAUSE_LEADER = causeCode("leader");
const CAUSE_SIGNAL_RED = causeCode("signal_red");
const CAUSE_ARROW_OFF = causeCode("arrow_off");

/** A vehicle cruising at or above this fraction of its desired speed reports `speed_limit`. */
const CRUISE_SPEED_RATIO = 0.95;
/** The leader is the binding constraint when it costs at least this much acceleration, m/s^2. */
const LEADER_BINDING_MPS2 = 0.1;
/**
 * Yellow dilemma zone (T-09): a vehicle that cannot stop before the stop line at a deceleration at or
 * below `comfortDecel * YELLOW_DILEMMA_FACTOR` proceeds instead of braking hard for a stale green.
 */
const YELLOW_DILEMMA_FACTOR = 1.5;
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
const RNG_FORK_LANES = 2;
const RNG_FORK_JUNCTIONS = 3;
/** Route-cost noise of the tree copies (drawn once at init) and the per-driver route draws (T-12). */
const RNG_FORK_ROUTES = 4;
const RNG_FORK_OD = 5;
/** Bus schedule offsets and dwell durations (T-14). */
const RNG_FORK_TRANSIT = 6;
/** Pedestrian arrivals and crossing draws (T-15). */
const RNG_FORK_PEDESTRIANS = 7;

/** Smoothing of the measured link travel time the navigators route on (T-12, alpha). */
const LIVE_COST_ALPHA = 0.3;
/**
 * A measured link traversal longer than this multiple of the free-flow time is clamped before it
 * enters the EMA: a single vehicle that sat through ten cycles must not make a street look closed.
 */
const LIVE_COST_MAX_FACTOR = 20;
/** Draws of an OD destination before a trip gives up and simply drives out of the network. */
const DEST_DRAW_ATTEMPTS = 6;

const CAUSE_LANE_CHANGE_WAIT = causeCode("lane_change_wait");
const CAUSE_POCKET_SPILLBACK = causeCode("pocket_spillback");
const CAUSE_GRIDLOCK = causeCode("gridlock");
const CAUSE_DOWNSTREAM_SPILLBACK = causeCode("downstream_spillback");
/** T-14: a scheduled bus stop dwell and, for the vehicles queued behind a dwelling bus, its cause. */
const CAUSE_BUS_DWELL = causeCode("bus_dwell");
const CAUSE_BEHIND_STOPPED_BUS = causeCode("behind_stopped_bus");
/** T-15: yielding to a pedestrian on, or about to step onto, a crosswalk. */
const CAUSE_PEDESTRIAN_YIELD = causeCode("pedestrian_yield");

/**
 * A vehicle giving way stops this far short of a conflict point. Slightly more than the occupancy
 * zone of `runtime/intersections.ts`, so that waiting inside the junction never makes a point
 * occupied and never steals right of way from the movement it is waiting for.
 */
const CONFLICT_STOP_MARGIN_M = 2.5;
/** Half-width of the occupancy zone around a conflict point; mirrors `runtime/intersections.ts`. */
const CONFLICT_ZONE_M = 2;
/** Speed a driver counts on while clearing a conflict point from the place it waits, m/s. */
const CONFLICT_CROSSING_MPS = 5;

/** Duration of a lane-change manoeuvre and, with it, the minimum interval between two changes, s. */
const LANE_CHANGE_DURATION_S = 2;
/**
 * A vehicle that decelerates at least this hard while a mandatory lane change is pending but not
 * feasible reports `lane_change_wait` instead of blaming the vehicle in front.
 */
const LANE_CHANGE_WAIT_DECEL_MPS2 = -0.5;
/**
 * A discretionary lane change is re-evaluated every this many steps (staggered by slot index, so the
 * work spreads evenly): drivers do not reconsider their lane ten times a second, and a mandatory
 * change is still evaluated on every step.
 */
const DISCRETIONARY_EVERY = 5;

const CAR_CODE = VEHICLE_CLASS_CODE.car;
const BUS_CODE = VEHICLE_CLASS_CODE.bus;

/** Tolerance when comparing simulation times accumulated in dtS steps (T-18 sampling schedule). */
const TIME_EPS_S = 1e-9;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SimulationImpl implements Simulation {
  readonly network: Network;
  readonly scenarioId: string;
  readonly runtime: RuntimeNetwork;
  readonly pool: VehiclePool;
  readonly signals: SignalRuntime;
  readonly lanes: LaneRuntime;
  readonly intersections: IntersectionRuntime;
  readonly pedestrians: PedestrianRuntime;
  readonly routingGraph: RoutingGraph;
  readonly od: OdModel;
  readonly routeTrees: RouteTrees;
  /** Navigator forest, rebuilt from `liveTravelS` every `rerouteIntervalS`. */
  private readonly liveTrees: RouteTrees;
  /** See SimulationKernel.liveTravelS. */
  readonly liveTravelS: Float64Array;
  /** `ROUTE_COPIES * edgeCount` multipliers in [-routeCostNoise, +routeCostNoise]. */
  private readonly routeNoise: Float64Array;
  private liveTreesBuilt = false;
  private nextRerouteS: number;
  /** See SimulationKernel.retargetedTrips. */
  retargetedTrips = 0;

  private cfg: SimConfig;
  private readonly clock: SimClock;
  private readonly spawnRng: Rng;
  private readonly driverRng: Rng;
  /** Turn intent at link entry and the bus-lane violator draw (T-10). */
  private readonly laneRng: Rng;
  /** Gridlock-discipline draw at spawn (T-11). */
  private readonly junctionRng: Rng;
  /** Route-copy and navigator draws at spawn (T-12). */
  private readonly routeRng: Rng;
  /** Origin-destination draws at spawn (T-12). */
  private readonly odRng: Rng;
  /** Bus schedule offsets and dwell durations (T-14). */
  private readonly transitRng: Rng;
  /** Pedestrian arrivals and crossing draws (T-15). */
  private readonly pedestrianRng: Rng;
  private readonly hash = new TrajectoryHash();

  // ---- transit (T-14) ----
  private readonly transitSchedule: BusScheduleRuntime;
  private readonly transitStops: BusStopRuntime;

  // ---- metrics (T-18) ----
  /** Segment geometry, capacities and the lane/connector -> segment lookup. */
  readonly segmentIndex: SegmentIndex;
  private readonly rootCauses: RootCauseResolver;
  /** Public so `kernelOf` can hand T-19 the stops and V/C the frame has no room for. */
  readonly metricsWindow: MetricsAccumulators;
  private readonly totalsTracker: TotalsTracker;
  /** Persons per vehicle of each class in the current hour; refreshed at every metrics sample. */
  private readonly occupancyByClass = new Float64Array(CLASS_COUNT);
  private nextSampleS: number;
  private lastSampleS = 0;

  // ---- lane changes (T-10) ----
  /** Lane each vehicle decided to move into this step, -1 = stay. Refilled every step. */
  private readonly pendingLane: Int32Array;
  /** New leader in the lane a vehicle decided to move into, as found in pass 1 (hint for pass 2). */
  private readonly pendingLeader: Int32Array;
  /** 1 while a mandatory lane change is pending but was not feasible this step. */
  private readonly laneChangeBlocked: Uint8Array;
  /** See SimulationKernel.gridlockDisciplined; drawn once per vehicle at spawn (T-11). */
  readonly gridlockDisciplined: Uint8Array;
  /** Reason the first blocking conflict point of `conflictStopDistance` is closed; scratch, not state. */
  private conflictCause = 0;
  /** [link * TURN_COUNT + turn] -> relative weight of the movement, see setTurnShares. */
  private readonly turnShares: Float64Array;
  /** 1 for links with explicit shares; the rest draw uniformly over the movements they offer. */
  private readonly turnSharesSet: Uint8Array;
  /** Scratch weights for one draw; a member so that the hot path never allocates. */
  private readonly turnWeights = new Float64Array(TURN_COUNT);

  /** Trips per hour at profile value 1.0 (explicit or auto-estimated at init). */
  readonly baseTripsPerHour: number;
  private readonly warmupEndS: number;

  // ---- spawn state per OD source ----
  private readonly arrivals: ArrivalQueues;
  private scratchTail = -1;

  /** See SimulationKernel.entryBlockedCause. */
  readonly entryBlockedCause: Uint8Array;
  /** See SimulationKernel.entryBlockedYellow. */
  readonly entryBlockedYellow: Uint8Array;
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
    this.signals = new SignalRuntime(
      opts.network.signalControllers,
      opts.config.dtS,
      opts.config.signals,
    );
    // Junctions first: `connProhibited` is what tells the lane runtime which movements are dead.
    this.intersections = new IntersectionRuntime(opts.network, this.runtime);
    this.lanes = new LaneRuntime(
      opts.network,
      this.runtime,
      opts.config.behavior.taxisAllowedInBusLanes,
      this.intersections.connProhibited,
    );
    this.clock = new SimClock(opts.config.dtS, opts.config.startTimeMin);
    const master = new Rng(opts.config.seed);
    this.spawnRng = master.fork(RNG_FORK_SPAWN);
    this.driverRng = master.fork(RNG_FORK_DRIVERS);
    this.laneRng = master.fork(RNG_FORK_LANES);
    this.junctionRng = master.fork(RNG_FORK_JUNCTIONS);
    this.routeRng = master.fork(RNG_FORK_ROUTES);
    this.odRng = master.fork(RNG_FORK_OD);
    this.transitRng = master.fork(RNG_FORK_TRANSIT);
    this.pedestrianRng = master.fork(RNG_FORK_PEDESTRIANS);
    this.pendingLane = new Int32Array(opts.config.demand.vehicleBudget).fill(-1);
    this.pendingLeader = new Int32Array(opts.config.demand.vehicleBudget).fill(-1);
    this.laneChangeBlocked = new Uint8Array(opts.config.demand.vehicleBudget);
    this.gridlockDisciplined = new Uint8Array(opts.config.demand.vehicleBudget);
    this.turnShares = new Float64Array(this.runtime.linkCount * TURN_COUNT);
    this.turnSharesSet = new Uint8Array(this.runtime.linkCount);

    const demand = opts.config.demand;
    this.baseTripsPerHour =
      demand.tripsPerHourPeak > 0
        ? demand.tripsPerHourPeak
        : AUTO_DEMAND_FACTOR *
          this.runtime.entryLaneCount *
          opts.config.signals.saturationFlowVehPerHPerLane;
    this.warmupEndS = demand.warmupMinutes * 60;

    this.entryBlockedCause = new Uint8Array(this.runtime.trackCount);
    this.entryBlockedYellow = new Uint8Array(this.runtime.trackCount);
    // Signals at t=0, so writeFrame()/kernelOf() are correct even before the first step().
    this.updateSignals(0);
    // A movement at a signalized node with no signal group is prohibited, not unsignalized (T-08):
    // no phase ever releases it, and `updateSignals` skips it, so the block is set once and stays.
    for (let t = this.runtime.laneCount; t < this.runtime.trackCount; t++) {
      if (this.intersections.connProhibited[t] === 1) this.entryBlockedCause[t] = CAUSE_SIGNAL_RED;
    }
    this.intersections.update(
      this.pool,
      this.signals.groupState,
      opts.config.metrics.stoppedSpeedMps,
    );

    // Routing (T-12). The graph is topology only, so it is built once; the trees are the costs.
    // `connProhibited` is already filled above, which is what keeps a movement no phase ever
    // releases out of every route (T-08/T-11 notes).
    this.routingGraph = new RoutingGraph(
      opts.network,
      this.runtime,
      this.intersections.connProhibited,
      CAR_CODE,
    );
    this.od = new OdModel(opts.network, this.runtime);
    this.liveTravelS = Float64Array.from(this.routingGraph.freeTravelS);
    this.routeNoise = new Float64Array(ROUTE_COPIES * this.routingGraph.edgeCount);
    const noiseAmplitude = demand.routeCostNoise;
    // Copy 0 stays unperturbed (the plain shortest path); the others spread over parallel streets.
    for (let copy = 1; copy < ROUTE_COPIES; copy++) {
      const base = copy * this.routingGraph.edgeCount;
      for (let e = 0; e < this.routingGraph.edgeCount; e++) {
        this.routeNoise[base + e] = (this.routeRng.float() * 2 - 1) * noiseAmplitude;
      }
    }
    this.routeTrees = new RouteTrees(
      this.routingGraph,
      this.runtime,
      this.od.destNodes,
      ROUTE_COPIES,
    );
    this.routeTrees.rebuild(this.routingGraph, this.routingGraph.freeTravelS, this.routeNoise);
    // Navigators share one live forest: a navigation app gives everybody the same advice, and one
    // copy is what keeps the periodic rebuild inside its budget.
    this.liveTrees = new RouteTrees(this.routingGraph, this.runtime, this.od.destNodes, 1);
    this.nextRerouteS = demand.rerouteIntervalS;

    this.arrivals = new ArrivalQueues(this.od.sourceCount, this.od.sourceShare, this.spawnRng);

    // Transit (T-14): routes are a fixed chain of links, entirely independent of the OD/routing
    // system above. Built last because `BusScheduleRuntime` needs `this.lanes` (bus-lane lookup for
    // the entry lane) and the whole network is otherwise ready by this point.
    this.transitSchedule = new BusScheduleRuntime(
      opts.network,
      this.runtime,
      this.lanes,
      this.transitRng,
      opts.config.startTimeMin,
      opts.config.peakHours,
    );
    this.transitStops = new BusStopRuntime(opts.network, this.runtime);

    // Pedestrians (T-15): independent of transit/routing, just the network and its own config slice.
    this.pedestrians = new PedestrianRuntime(
      opts.network,
      this.runtime,
      opts.config.pedestrians,
      this.pedestrianRng,
    );

    // Metrics (T-18). Purely an observer of the state above: it never influences a single vehicle,
    // so it is built last and sampled at the very end of a step.
    const metricsCfg = opts.config.metrics;
    this.segmentIndex = new SegmentIndex(
      opts.network,
      this.runtime,
      opts.config.signals.saturationFlowVehPerHPerLane,
    );
    this.rootCauses = new RootCauseResolver(this.runtime, opts.config.demand.vehicleBudget);
    this.metricsWindow = new MetricsAccumulators(
      this.runtime,
      this.segmentIndex,
      opts.config.demand.vehicleBudget,
      metricsCfg.windowS,
    );
    this.totalsTracker = new TotalsTracker(metricsCfg.windowS);
    this.nextSampleS = metricsCfg.sampleIntervalS;
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
    const peak = isPeakHour(this.cfg, this.clock.timeOfDayMin);
    this.transitStops.update(this.pool, now, this.cfg.behavior, peak, this.transitRng); // 0a (T-14)
    this.updateSignals(now); // 1
    this.pedestrians.update(
      dt,
      now,
      this.clock.hourOfDay,
      this.signals.groupState,
      this.pedestrianRng,
    ); // 2 (T-15)
    this.updateRoutes(now); // 3
    this.selectLanes(); // 4
    this.changeLanes(now); // 5
    this.intersections.update(this.pool, this.signals.groupState, this.cfg.metrics.stoppedSpeedMps);
    this.computeAccelerations(); // 6
    this.integrate(dt, now); // 7
    this.repairOrder();
    this.spawn(dt, now); // 8
    this.spawnBuses(now, peak); // 9 (T-14)
    this.updatePositions(now);
    this.sampleMetrics(now, peak); // 10 (T-18)
    this.foldHash();
  }

  /**
   * Metrics sample (ARCHITECTURE, step 10). Runs at most once every `metrics.sampleIntervalS` and
   * only reads state: first the root cause of every vehicle (`RootCauseResolver`), then one pass over
   * the vehicles that folds speed, density, flow, queue length, delay and the delay-by-cause matrix
   * into the sliding window (`MetricsAccumulators`). `writeMetrics()` is then a pure read of that
   * window and can be called at any rate, independent of the sampling.
   */
  private sampleMetrics(now: number, peak: boolean): void {
    if (now + TIME_EPS_S < this.nextSampleS) return;
    const elapsed = now - this.lastSampleS;
    this.lastSampleS = now;
    const interval = this.cfg.metrics.sampleIntervalS;
    this.nextSampleS += interval;
    // A sampleIntervalS below dtS (or a long jump) must not make the next sample fire immediately.
    if (this.nextSampleS <= now) this.nextSampleS = now + interval;
    for (let c = 0; c < CLASS_COUNT; c++) {
      const cls = VEHICLE_CLASS_BY_CODE[c];
      if (!cls) continue;
      const params = this.cfg.vehicleClasses[cls];
      this.occupancyByClass[c] = peak ? params.occupancyPeak : params.occupancyOffpeak;
    }
    this.rootCauses.resolve(this.pool, this.cfg.metrics.stoppedSpeedMps);
    this.metricsWindow.sample(this.pool, now, elapsed, this.occupancyByClass, this.cfg.metrics);
  }

  runUntil(targetSimTimeS: number): void {
    while (this.clock.simTimeS < targetSimTimeS - 1e-9) this.step();
  }

  /**
   * Signals (ARCHITECTURE, step 1). Computes every group's state for `now` and turns it into
   * `entryBlockedCause`/`entryBlockedYellow` for every signalized connector, which the stop-line
   * obstacle in `computeAccelerations` reads. GREEN/FLASHING_GREEN clears the block; a main group's
   * YELLOW sets a conditional block (`entryBlockedYellow = 1`, resolved per vehicle); RED, RED_YELLOW
   * and an arrow group anywhere outside its own green set an unconditional block (`signal_red` /
   * `arrow_off`). Unsignalized connectors (`connSignalGroup < 0`) are left untouched for T-11/T-15.
   */
  private updateSignals(now: number): void {
    const signals = this.signals;
    if (signals.groupCount === 0) return;
    const groupState = signals.computeStates(now);
    const rt = this.runtime;
    const groupIsArrow = rt.groupIsArrow;
    const connGroup = rt.connSignalGroup;
    const entryBlocked = this.entryBlockedCause;
    const entryYellow = this.entryBlockedYellow;
    for (let t = rt.laneCount; t < rt.trackCount; t++) {
      const g = connGroup[t] as number;
      if (g < 0) continue;
      const state = groupState[g] as number;
      const isArrow = (groupIsArrow[g] as number) === 1;
      if (state === SignalState.GREEN || state === SignalState.FLASHING_GREEN) {
        entryBlocked[t] = 0;
        entryYellow[t] = 0;
      } else if (!isArrow && state === SignalState.YELLOW) {
        entryBlocked[t] = CAUSE_SIGNAL_RED;
        entryYellow[t] = 1;
      } else {
        entryBlocked[t] = isArrow ? CAUSE_ARROW_OFF : CAUSE_SIGNAL_RED;
        entryYellow[t] = 0;
      }
    }
  }

  /** True when a vehicle at speed `v`, `gap` metres from the stop line, must stop for a yellow light:
   * it can still do so at a deceleration at or below `comfortDecel * YELLOW_DILEMMA_FACTOR`. */
  private mustStopAtYellow(v: number, gap: number, comfortDecel: number): boolean {
    if (v <= 0) return true;
    if (gap <= 0) return true;
    const requiredDecel = (v * v) / (2 * gap);
    return requiredDecel <= comfortDecel * YELLOW_DILEMMA_FACTOR;
  }

  // ---- lane choice and lane changes (T-10) ---------------------------------

  /**
   * Lane selection (ARCHITECTURE, step 4). Every vehicle on a lane records the lane it has to reach
   * on the current link (`pool.targetLane`, -1 = the lane it is on already works): the nearest lane
   * by index that serves its intended movement and admits its class. Three things produce a target:
   * the movement is not available from this lane (turn lane, pocket), the lane does not admit the
   * class any more (bus lane inside its hours), or the lane ends before the link does.
   */
  private selectLanes(): void {
    const pool = this.pool;
    const rt = this.runtime;
    const lanes = this.lanes;
    const tod = this.clock.timeOfDayMin;
    const track = pool.track;
    const n = pool.highWater;
    for (let i = 0; i < n; i++) {
      const t = track[i] as number;
      if (t < 0) continue;
      if (t >= rt.laneCount) {
        pool.targetLane[i] = -1;
        continue;
      }
      // The trip ends at the end of this link (T-12): the lane the vehicle is on already gets it
      // there, so it must not chase a lane that serves some onward movement.
      if (pool.routeArrive[i] === 1 && rt.laneReachesLinkEnd[t] === 1) {
        pool.targetLane[i] = -1;
        continue;
      }
      pool.targetLane[i] = lanes.targetLane(
        t,
        pool.cls[i] as number,
        ((pool.persistentFlags[i] as number) & VehicleFlag.BUS_LANE_VIOLATOR) !== 0,
        pool.intendedTurn[i] as number,
        pool.s[i] as number,
        tod,
      );
    }
  }

  /**
   * Lane changes (ARCHITECTURE, step 5). Two passes so that every decision reads the same state:
   *
   *  1. per lane, walking its ordered list from the tail (increasing `s`) with a monotone cursor
   *     into each neighbour list, so finding the new leader and the new follower is O(1) amortised;
   *  2. in slot order, applying the decisions and re-checking the immediate gaps, because two
   *     vehicles may have picked the same hole in the neighbour lane during pass 1.
   */
  private changeLanes(now: number): void {
    const pool = this.pool;
    const rt = this.runtime;
    const pending = this.pendingLane;
    const s = pool.s;
    const ahead = pool.ahead;
    for (let t = 0; t < rt.laneCount; t++) {
      let i = pool.trackTail[t] as number;
      if (i < 0) continue;
      const left = rt.laneLeft[t] as number;
      const right = rt.laneRight[t] as number;
      let curLeft = left >= 0 ? (pool.trackTail[left] as number) : -1;
      let curRight = right >= 0 ? (pool.trackTail[right] as number) : -1;
      while (i >= 0) {
        const si = s[i] as number;
        while (curLeft >= 0 && (s[curLeft] as number) < si) curLeft = ahead[curLeft] as number;
        while (curRight >= 0 && (s[curRight] as number) < si) curRight = ahead[curRight] as number;
        pending[i] = this.decideLaneChange(i, t, left, curLeft, right, curRight, now);
        i = ahead[i] as number;
      }
    }
    const n = pool.highWater;
    for (let i = 0; i < n; i++) {
      const target = pending[i] as number;
      if (target < 0) continue;
      pending[i] = -1;
      this.applyLaneChange(i, target, now);
    }
  }

  /**
   * MOBIL decision for vehicle `i` on lane `t`. A mandatory change (`targetLane >= 0`) looks only at
   * the neighbour on the way to the target and adds `mandatoryBias`; a discretionary one looks at
   * both neighbours, requires them to keep the intended movement reachable and takes the better of
   * the two. Returns the lane to move into, or -1.
   *
   * The parts that do not depend on the candidate lane (own acceleration, the gain of the follower
   * left behind) are computed once here. A vehicle that is alone on its stretch of lane can neither
   * gain nor do anyone a favour, so it is skipped outright.
   */
  private decideLaneChange(
    i: number,
    t: number,
    left: number,
    curLeft: number,
    right: number,
    curRight: number,
    now: number,
  ): number {
    const pool = this.pool;
    this.laneChangeBlocked[i] = 0;
    if ((pool.laneChangeEndS[i] as number) > now) return -1; // manoeuvre running / rate limit
    const target = pool.targetLane[i] as number;
    const oldLeader = pool.ahead[i] as number;
    const oldFollower = pool.behind[i] as number;
    if (target < 0 && oldLeader < 0 && oldFollower < 0) return -1;

    const aOwnBefore = this.accelBehind(i, t, oldLeader);
    const dOldFollower =
      oldFollower < 0
        ? 0
        : this.accelBehind(oldFollower, t, oldLeader) - this.accelBehind(oldFollower, t, i);

    if (target >= 0) {
      const toRight =
        (this.runtime.lanePos[target] as number) > (this.runtime.lanePos[t] as number);
      const cand = toRight ? right : left;
      const cur = toRight ? curRight : curLeft;
      const distToEnd = (this.runtime.trackEndS[t] as number) - (pool.s[i] as number);
      const bias = mandatoryBias(distToEnd, this.cfg.behavior.laneSelectionLookaheadM);
      const gain = this.laneChangeGain(i, t, cand, cur, bias, false, aOwnBefore, dOldFollower);
      if (gain > 0) {
        this.pendingLeader[i] = cur;
        return cand;
      }
      // Only an urgent change (inside `laneSelectionLookaheadM`, i.e. bias > 0) counts as waiting:
      // further out the vehicle is not trying to merge yet, so its braking is the leader's doing and
      // `lane_change_wait` would poison the cause histogram (T-18).
      if (bias > 0) this.laneChangeBlocked[i] = 1;
      return -1;
    }
    // A discretionary change is re-considered every DISCRETIONARY_EVERY steps, staggered by slot:
    // drivers do not re-evaluate their lane 10 times a second, and this keeps the stage cheap.
    if ((this.clock.stepIndex + i) % DISCRETIONARY_EVERY !== 0) return -1;
    const gainLeft = this.laneChangeGain(i, t, left, curLeft, 0, true, aOwnBefore, dOldFollower);
    const gainRight = this.laneChangeGain(i, t, right, curRight, 0, true, aOwnBefore, dOldFollower);
    if (gainLeft <= 0 && gainRight <= 0) return -1;
    if (gainRight > gainLeft) {
      this.pendingLeader[i] = curRight;
      return right;
    }
    this.pendingLeader[i] = curLeft;
    return left;
  }

  /**
   * Net MOBIL incentive of moving vehicle `i` from lane `t` into `cand`, m/s^2 above its threshold;
   * -Infinity when the change is impossible (no such lane, no overlap at `s`, no access, no room) or
   * unsafe. `newLeader` is the first vehicle of `cand` at or ahead of `i` (-1 when there is none).
   */
  private laneChangeGain(
    i: number,
    t: number,
    cand: number,
    newLeader: number,
    bias: number,
    keepTurn: boolean,
    aOwnBefore: number,
    dOldFollower: number,
  ): number {
    if (cand < 0) return Number.NEGATIVE_INFINITY;
    const pool = this.pool;
    const rt = this.runtime;
    const lanes = this.lanes;
    const si = pool.s[i] as number;
    if (!rt.lanesOverlapAt(t, cand, si)) return Number.NEGATIVE_INFINITY;
    const cls = pool.cls[i] as number;
    const turn = pool.intendedTurn[i] as number;
    const violator = ((pool.persistentFlags[i] as number) & VehicleFlag.BUS_LANE_VIOLATOR) !== 0;
    if (!lanes.admitsAt(cand, cls, violator, turn, si, this.clock.timeOfDayMin))
      return Number.NEGATIVE_INFINITY;
    // A discretionary change must not throw away the movement the vehicle came for.
    if (keepTurn && !lanes.serves(cand, cls, turn)) return Number.NEGATIVE_INFINITY;

    const newFollower =
      newLeader >= 0 ? (pool.behind[newLeader] as number) : (pool.trackHead[cand] as number);
    if (this.gapTo(i, newLeader) <= 0) return Number.NEGATIVE_INFINITY;
    if (this.gapTo(newFollower, i) <= 0) return Number.NEGATIVE_INFINITY;

    const aNewFollowerBefore = this.accelBehind(newFollower, cand, newLeader);
    const aNewFollowerAfter = this.accelBehind(newFollower, cand, i);
    if (!mobilSafe(aNewFollowerAfter)) return Number.NEGATIVE_INFINITY;
    const aOwnAfter = this.accelBehind(i, cand, newLeader);

    // The old follower's gain does not depend on the candidate lane, so it arrives precomputed as
    // a difference: pass it as (after, before) = (dOldFollower, 0).
    const incentive = mobilIncentive(
      aOwnAfter,
      aOwnBefore,
      dOldFollower,
      0,
      aNewFollowerAfter,
      aNewFollowerBefore,
      pool.politeness[i] as number,
    );
    return incentive + bias - (pool.laneChangeThreshold[i] as number);
  }

  /** Bumper-to-bumper gap between follower `f` and leader `l` on the same link, +Infinity if either is -1. */
  private gapTo(f: number, l: number): number {
    if (f < 0 || l < 0) return Number.POSITIVE_INFINITY;
    const pool = this.pool;
    return (pool.s[l] as number) - (pool.length[l] as number) - (pool.s[f] as number);
  }

  /** IDM acceleration of `f` on lane `lane` behind `l` (free road when `l` is -1); 0 when `f` is -1. */
  private accelBehind(f: number, lane: number, l: number): number {
    if (f < 0) return 0;
    const pool = this.pool;
    const v = pool.v[f] as number;
    const v0 = (this.runtime.trackSpeedMps[lane] as number) * (pool.speedFactor[f] as number);
    if (l < 0) return idmFreeAcceleration(v, v0, pool.maxAccel[f] as number);
    return this.accelTowardObstacle(f, v, v0, this.gapTo(f, l), pool.v[l] as number);
  }

  /** Moves vehicle `i` into lane `target`, keeping `s` and the polyline segment cache. */
  private applyLaneChange(i: number, target: number, now: number): void {
    const pool = this.pool;
    const rt = this.runtime;
    const from = pool.track[i] as number;
    if (from < 0 || from >= rt.laneCount) return; // left the network or entered a connector meanwhile
    const si = pool.s[i] as number;
    if (!rt.lanesOverlapAt(from, target, si)) return;
    // Re-check against the vehicles that are in the target lane now: pass 1 read the old state and
    // two vehicles may have aimed at the same hole.
    const leader = this.refineLeader(target, si, this.pendingLeader[i] as number);
    const follower =
      leader >= 0 ? (pool.behind[leader] as number) : (pool.trackHead[target] as number);
    if (this.gapTo(i, leader) <= 0) return;
    if (this.gapTo(follower, i) <= 0) return;
    if (!mobilSafe(this.accelBehind(follower, target, i))) return;

    const v0 = (rt.trackSpeedMps[from] as number) * (pool.speedFactor[i] as number);
    pool.freeFlowTimeS[i] =
      (pool.freeFlowTimeS[i] as number) +
      ((rt.trackEndS[target] as number) - (rt.trackEndS[from] as number)) / v0;
    pool.laneChangeFromOffsetM[i] = rt.trackOffsetM[from] as number;
    pool.laneChangeDir[i] = (rt.lanePos[target] as number) > (rt.lanePos[from] as number) ? 1 : -1;
    pool.laneChangeEndS[i] = now + LANE_CHANGE_DURATION_S;
    pool.remove(i);
    pool.insert(target, i); // `s` and `geomSeg` are shared by every lane of the link
    pool.nextTrack[i] = this.continuationFor(i, target);
    pool.targetLane[i] = this.lanes.targetLane(
      target,
      pool.cls[i] as number,
      ((pool.persistentFlags[i] as number) & VehicleFlag.BUS_LANE_VIOLATOR) !== 0,
      pool.intendedTurn[i] as number,
      si,
      this.clock.timeOfDayMin,
    );
  }

  /**
   * First vehicle of `lane` at or beyond `s` after the changes applied so far, starting from the
   * candidate found in pass 1. Only vehicles inserted since then can shift the answer, so the walk
   * is O(1) in practice.
   */
  private refineLeader(lane: number, s: number, hint: number): number {
    const pool = this.pool;
    let cur = hint;
    if (cur < 0 || (pool.track[cur] as number) !== lane) {
      if (cur >= 0) return this.leaderInLaneAt(lane, s); // the hint changed lanes itself
      cur = pool.trackHead[lane] as number;
    }
    while (cur >= 0 && (pool.s[cur] as number) < s) cur = pool.ahead[cur] as number;
    if (cur < 0) return -1;
    let b = pool.behind[cur] as number;
    while (b >= 0 && (pool.s[b] as number) >= s) {
      cur = b;
      b = pool.behind[cur] as number;
    }
    return cur;
  }

  /** First vehicle of `lane` at or beyond `s` (its leader would be the new one), -1 when there is none. */
  private leaderInLaneAt(lane: number, s: number): number {
    const pool = this.pool;
    let cur = pool.trackTail[lane] as number;
    while (cur >= 0 && (pool.s[cur] as number) < s) cur = pool.ahead[cur] as number;
    return cur;
  }

  /**
   * Draws the movement a vehicle of class `cls` intends to make at the end of the link owning `lane`.
   * Uniform over the movements the link actually offers that class, unless `setTurnShares` gave the
   * link explicit weights. Used when the link is under explicit turn shares or when the vehicle has
   * no route left (see `enterLink`).
   */
  private sampleTurn(lane: number, cls: number): number {
    const rt = this.runtime;
    const link = rt.trackLink[lane] as number;
    if (link < 0) return TurnCode.through;
    const mask = this.lanes.linkTurnMaskByClass[link * CLASS_COUNT + cls] as number;
    if (mask === 0) return TurnCode.through; // the link leaves the network: no manoeuvre to make
    const explicit = this.turnSharesSet[link] === 1;
    const base = link * TURN_COUNT;
    const w = this.turnWeights;
    let total = 0;
    for (let k = 0; k < TURN_COUNT; k++) {
      const available = (mask & turnBit(k)) !== 0;
      const weight = available ? (explicit ? (this.turnShares[base + k] as number) : 1) : 0;
      w[k] = weight;
      total += weight;
    }
    if (total <= 0) {
      // Explicit shares that exclude every movement this class has: fall back to a uniform draw.
      for (let k = 0; k < TURN_COUNT; k++) {
        const weight = (mask & turnBit(k)) !== 0 ? 1 : 0;
        w[k] = weight;
        total += weight;
      }
    }
    let u = this.laneRng.float() * total;
    for (let k = 0; k < TURN_COUNT; k++) {
      u -= w[k] as number;
      if (u < 0) return k;
    }
    return TurnCode.through;
  }

  // ---- routing (T-12) ------------------------------------------------------

  /**
   * Routing (ARCHITECTURE, step 3). Everything a driver needs is precomputed in the "next link"
   * forests, so a step only has to keep the navigator forest current: once every `rerouteIntervalS`
   * it is rebuilt from `liveTravelS`, the EMA of the travel time vehicles actually spent on each
   * link. Ordinary drivers read the static forest, which never changes, so their route is fixed for
   * the whole trip. With no navigators the forest is never built at all.
   */
  private updateRoutes(now: number): void {
    if (this.cfg.demand.navigatorShare <= 0 && this.liveTreesBuilt === false) return;
    if (this.liveTreesBuilt && now < this.nextRerouteS) return;
    this.rebuildLiveTrees();
    const interval = this.cfg.demand.rerouteIntervalS;
    this.nextRerouteS = now + interval;
  }

  rebuildRouteTrees(): void {
    this.routeTrees.rebuild(this.routingGraph, this.routingGraph.freeTravelS, this.routeNoise);
  }

  rebuildLiveTrees(): void {
    this.liveTrees.rebuild(this.routingGraph, this.liveTravelS, null);
    this.liveTreesBuilt = true;
  }

  /**
   * Records how long vehicle `i` took over the link it is leaving into the live cost of that link
   * (exponential moving average, alpha = 0.3). The sample covers the link *and* the junction at its
   * end, which is exactly what a navigator's live travel time means -- and what makes the static
   * cost of an edge (travel + signal delay) comparable with it.
   */
  private recordLinkTravel(i: number, link: number, now: number): void {
    const pool = this.pool;
    const previous = pool.routeLink[i] as number;
    if (previous >= 0 && previous !== link) {
      const free = this.routingGraph.freeTravelS[previous] as number;
      let sample = now - (pool.linkEnterS[i] as number);
      if (sample < 0) sample = 0;
      const cap = free * LIVE_COST_MAX_FACTOR;
      if (cap > 0 && sample > cap) sample = cap;
      this.liveTravelS[previous] =
        (1 - LIVE_COST_ALPHA) * (this.liveTravelS[previous] as number) + LIVE_COST_ALPHA * sample;
    }
    pool.routeLink[i] = link;
    pool.linkEnterS[i] = now;
  }

  /**
   * Connector vehicle `i` takes off `lane`: the one that leads onto the link its route asks for,
   * falling back to any connector of its intended manoeuvre. Used after a lane change, where the
   * route was decided on another lane of the same link -- picking by manoeuvre alone would send the
   * vehicle onto whichever street happens to be first with that turn.
   */
  private continuationFor(i: number, lane: number): number {
    const pool = this.pool;
    if (pool.routeArrive[i] === 1) return -1; // the trip ends at the end of this link
    const cls = pool.cls[i] as number;
    const next = pool.routeNextLink[i] as number;
    if (next >= 0) {
      const conn = this.routeConnector(lane, cls, next);
      if (conn >= 0) return conn;
      const detour = this.detourConnector(i, lane);
      if (detour >= 0) return detour;
    }
    return this.lanes.connectorFor(lane, cls, pool.intendedTurn[i] as number);
  }

  /** The forest a driver reads: the live one for a navigator (once it exists), the static one else. */
  private treesOf(i: number): { trees: RouteTrees; copy: number } {
    const navigator =
      ((this.pool.persistentFlags[i] as number) & VehicleFlag.NAVIGATOR) !== 0 &&
      this.liveTreesBuilt;
    return navigator
      ? { trees: this.liveTrees, copy: 0 }
      : { trees: this.routeTrees, copy: this.pool.routeCopy[i] as number };
  }

  /**
   * Next link of vehicle `i` from `link`, retargeting the trip when the destination has become
   * unreachable. That happens when a driver failed to reach its turn lane in time and was carried
   * onto another street (see the T-10 notes): destination trees repair themselves, because the next
   * `enterLink` simply reads the tree of the new link -- but if the new link cannot reach the
   * destination at all, the trip is re-aimed at the first gate it can still reach, and only when
   * even that fails does the vehicle fall back to driving out by the manoeuvre draw.
   */
  private routeTarget(i: number, link: number): number {
    const pool = this.pool;
    const dest = pool.routeDest[i] as number;
    if (dest < 0) return ROUTE_UNREACHABLE;
    const { trees, copy } = this.treesOf(i);
    const next = trees.nextLink(copy, dest, link);
    if (next !== ROUTE_UNREACHABLE) return next;
    const gates = this.od.gateDests;
    for (let k = 0; k < gates.length; k++) {
      const d = gates[k] as number;
      const candidate = trees.nextLink(copy, d, link);
      if (candidate !== ROUTE_UNREACHABLE) {
        pool.routeDest[i] = d;
        this.retargetedTrips++;
        return candidate;
      }
    }
    pool.routeDest[i] = -1;
    this.retargetedTrips++;
    return ROUTE_UNREACHABLE;
  }

  /**
   * Outgoing connector of `lane` that leads onto `toLink` for class `clsCode`, or -1. Preferred over
   * picking a connector by manoeuvre kind, because two movements of the same kind may leave the same
   * lane onto different streets.
   */
  private routeConnector(lane: number, clsCode: number, toLink: number): number {
    const rt = this.runtime;
    const start = rt.laneConnStart[lane] as number;
    const count = rt.laneConnCount[lane] as number;
    const bit = 1 << clsCode;
    for (let k = 0; k < count; k++) {
      const t = rt.laneConnList[start + k] as number;
      if (((rt.trackAllowedMask[t] as number) & bit) === 0) continue;
      if (this.intersections.connProhibited[t] === 1) continue;
      const toLane = rt.connToLane[t - rt.laneCount] as number;
      if ((rt.trackLink[toLane] as number) === toLink) return t;
    }
    return -1;
  }

  /**
   * Second best from `lane`: the first connector whose target link can still reach the vehicle's
   * destination. It is what a driver takes when the lane holding the ideal movement turns out to be
   * unreachable -- a detour instead of the wrong street. Without it a missed turn lane hands the
   * vehicle whatever movement the lane happens to offer first, which on a small bbox often means
   * driving straight out of it (see the notes of T-10).
   */
  private detourConnector(i: number, lane: number): number {
    const pool = this.pool;
    const dest = pool.routeDest[i] as number;
    if (dest < 0) return -1;
    const rt = this.runtime;
    const { trees, copy } = this.treesOf(i);
    const start = rt.laneConnStart[lane] as number;
    const count = rt.laneConnCount[lane] as number;
    const bit = 1 << (pool.cls[i] as number);
    for (let k = 0; k < count; k++) {
      const t = rt.laneConnList[start + k] as number;
      if (((rt.trackAllowedMask[t] as number) & bit) === 0) continue;
      if (this.intersections.connProhibited[t] === 1) continue;
      const toLink = rt.trackLink[rt.connToLane[t - rt.laneCount] as number] as number;
      if (toLink < 0) continue;
      if (trees.nextLink(copy, dest, toLink) !== ROUTE_UNREACHABLE) return t;
    }
    return -1;
  }

  /**
   * Assigns the intended movement and the matching connector to a vehicle that just entered `lane`.
   * The route decides, unless the link carries explicit `setTurnShares` weights (the tool nuance
   * tests use to dial turning demand) or the vehicle has no usable route left.
   */
  private enterLink(i: number, lane: number, now: number): void {
    const pool = this.pool;
    const rt = this.runtime;
    const cls = pool.cls[i] as number;
    const link = rt.trackLink[lane] as number;
    pool.routeArrive[i] = 0;
    pool.routeNextLink[i] = -1;
    // Buses follow a fixed chain of links (T-14), never the OD/navigator system below: recording
    // their traversal into `liveTravelS` would poison it with dwell time no car ever pays.
    if ((pool.busRoute[i] as number) >= 0) {
      this.enterBusLink(i, lane);
      return;
    }
    if (link >= 0) this.recordLinkTravel(i, link, now);

    if (link >= 0 && this.turnSharesSet[link] !== 1 && (pool.routeDest[i] as number) >= 0) {
      const next = this.routeTarget(i, link);
      if (next === ROUTE_ARRIVE) {
        // End of the trip at the end of this link: a gate lane leaves the network by itself, an
        // attractor node needs `routeArrive` so that `advanceTrack` completes instead of dropping.
        pool.routeArrive[i] = 1;
        pool.intendedTurn[i] = TurnCode.through;
        pool.nextTrack[i] = -1;
        return;
      }
      if (next !== ROUTE_UNREACHABLE) {
        pool.routeNextLink[i] = next;
        const conn = this.routeConnector(lane, cls, next);
        if (conn >= 0) {
          pool.intendedTurn[i] = rt.connTurn[conn] as number;
          pool.nextTrack[i] = conn;
          return;
        }
        // The movement exists on the link but not from this lane: the mandatory lane change of
        // T-10 takes over, driven by `intendedTurn`. Should the vehicle fail to reach that lane,
        // it leaves on the best movement this one still offers towards the destination.
        const turn = this.routingGraph.turnTo(link, next);
        if (turn >= 0) {
          pool.intendedTurn[i] = turn;
          const detour = this.detourConnector(i, lane);
          pool.nextTrack[i] = detour >= 0 ? detour : this.lanes.connectorFor(lane, cls, turn);
          return;
        }
      }
    }
    const turn = this.sampleTurn(lane, cls);
    pool.intendedTurn[i] = turn;
    pool.nextTrack[i] = this.lanes.connectorFor(lane, cls, turn);
  }

  /**
   * Bus/trolleybus continuation (T-14): the vehicle's route is `TransitRoute.linkSeq`, a fixed chain
   * of links resolved once at construction, not the OD graph. Mirrors the shape of the OD branch of
   * `enterLink` (same `routeConnector`/`turnTo` fallbacks), just driven by the route's own next link
   * instead of a shortest-path tree, and always ends in `routeArrive` -- a bus route is a one-way trip
   * from `entryNodeId` to `exitNodeId`, never a loop the vehicle keeps following.
   */
  private enterBusLink(i: number, lane: number): void {
    const pool = this.pool;
    const rt = this.runtime;
    const route = this.transitSchedule.routes[pool.busRoute[i] as number] as TransitRoute;
    const posIdx = (pool.busRouteLinkIdx[i] as number) + 1;
    pool.busRouteLinkIdx[i] = posIdx;
    pool.routeNextLink[i] = -1;
    const cls = pool.cls[i] as number;
    if (posIdx >= route.linkSeq.length - 1) {
      // The current link is the route's last one: the trip ends at its far end (`exitNodeId`).
      pool.routeArrive[i] = 1;
      pool.intendedTurn[i] = TurnCode.through;
      pool.nextTrack[i] = -1;
      return;
    }
    const nextLink = route.linkSeq[posIdx + 1] as number;
    const conn = this.routeConnector(lane, cls, nextLink);
    if (conn >= 0) {
      pool.routeNextLink[i] = nextLink;
      pool.intendedTurn[i] = rt.connTurn[conn] as number;
      pool.nextTrack[i] = conn;
      return;
    }
    // The movement exists on the link but not from this lane: fall back to the mandatory lane change
    // (T-10), same as a car whose route lane is not the one it entered on.
    const turn = this.routingGraph.turnTo(rt.trackLink[lane] as number, nextLink);
    if (turn >= 0) {
      pool.routeNextLink[i] = nextLink;
      pool.intendedTurn[i] = turn;
      pool.nextTrack[i] = this.lanes.connectorFor(lane, cls, turn);
      return;
    }
    // Should not happen on a well-formed route (consecutive links are connected, see
    // contracts/src/integrity.ts): fall back to whatever the lane offers, rather than drop the bus.
    const fallbackTurn = this.sampleTurn(lane, cls);
    pool.intendedTurn[i] = fallbackTurn;
    pool.nextTrack[i] = this.lanes.connectorFor(lane, cls, fallbackTurn);
  }

  setTurnShares(linkId: string, shares: Partial<Record<TurnKind, number>>): void {
    const link = this.runtime.linkIndex.get(linkId);
    if (link === undefined) throw new Error(`setTurnShares: unknown link ${linkId}`);
    const base = link * TURN_COUNT;
    for (let k = 0; k < TURN_COUNT; k++) this.turnShares[base + k] = 0;
    for (const [kind, share] of Object.entries(shares)) {
      if (share === undefined) continue;
      if (!(share >= 0)) throw new Error(`setTurnShares: share of ${kind} must be >= 0`);
      const code = TurnCode[kind as TurnKind];
      if (code === undefined) throw new Error(`setTurnShares: unknown turn ${kind}`);
      this.turnShares[base + code] = share;
    }
    this.turnSharesSet[link] = 1;
  }

  /**
   * Longitudinal model (ARCHITECTURE, step 6). Every vehicle starts from its free-road IDM
   * acceleration and then takes the minimum over its obstacles; the obstacle that wins becomes the
   * binding constraint (`cause`). Obstacles today: the leader (on this track or the first vehicle on
   * the tracks ahead) and a stop line at the end of the track when entering the next track is blocked
   * (`entryBlockedCause`, filled by signals above; later subsystems add more reasons). Later tasks add
   * obstacles to this loop.
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
    const persistent = pool.persistentFlags;
    const tail = pool.trackTail;
    const lanes = this.lanes;
    const trackStart = rt.trackStartS;
    const trackEnd = rt.trackEndS;
    const trackSpeed = rt.trackSpeedMps;
    const trackNext = rt.trackNextByClass;
    const entryBlocked = this.entryBlockedCause;
    const entryYellow = this.entryBlockedYellow;
    const n = pool.highWater;
    for (let i = 0; i < n; i++) {
      const t = track[i] as number;
      if (t < 0) continue;
      // A bus dwelling at a stop (T-14) is held stationary by `BusStopRuntime`, not by the ordinary
      // obstacle scan: it is not "obstructed", it is parked on purpose.
      if (((persistent[i] as number) & VehicleFlag.DWELLING) !== 0) {
        a[i] = 0;
        cause[i] = CAUSE_BUS_DWELL;
        continue;
      }
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
          if (aFree - aLeader >= LEADER_BINDING_MPS2) {
            // N17: queued behind a bus dwelling `in_lane` (T-14) reports its own cause, not `leader`.
            c =
              ((persistent[leader] as number) & VehicleFlag.DWELLING) !== 0
                ? CAUSE_BEHIND_STOPPED_BUS
                : CAUSE_LEADER;
          }
        }
      }

      // Obstacle: a full turn pocket the vehicle must enter (N09). It stops at the pocket's start
      // in its current lane and blocks the through traffic behind it: cause `pocket_spillback`.
      const target = pool.targetLane[i] as number;
      if (target >= 0 && lanes.isPocket[target] === 1) {
        const pocketStart = trackStart[target] as number;
        if (si < pocketStart) {
          const last = tail[target] as number;
          const full =
            last >= 0 &&
            (s[last] as number) - (len[last] as number) < pocketStart + (pool.minGap[i] as number);
          if (full) {
            const aStop = this.accelTowardObstacle(i, vi, v0, pocketStart - si, 0);
            if (aStop < acc) {
              acc = aStop;
              if (aFree - aStop >= LEADER_BINDING_MPS2) c = CAUSE_POCKET_SPILLBACK;
            }
          }
        }
      }

      // Obstacle: the lane ends without a permitted continuation while a mandatory lane change is
      // still pending. Without this the vehicle would run off the end and be dropped; with it, it
      // queues at the end of the lane and keeps trying to merge.
      if (
        (nextTrack[i] as number) < 0 &&
        t < rt.laneCount &&
        rt.trackIsExit[t] === 0 &&
        target >= 0
      ) {
        const aStop = this.accelTowardObstacle(i, vi, v0, (trackEnd[t] as number) - si, 0);
        if (aStop < acc) {
          acc = aStop;
          if (aFree - aStop >= LEADER_BINDING_MPS2) c = CAUSE_LANE_CHANGE_WAIT;
        }
      }

      // Obstacle: stop line at the end of this track while entering the next track is blocked.
      const next = nextTrack[i] as number;
      if (next >= 0) {
        let blocked = entryBlocked[next] as number;
        const gapToLine = (trackEnd[t] as number) - si;
        if (blocked !== 0 && entryYellow[next] === 1) {
          // Yellow dilemma zone: a vehicle that cannot stop comfortably proceeds instead.
          if (!this.mustStopAtYellow(vi, gapToLine, pool.comfortDecel[i] as number)) blocked = 0;
        }
        if (blocked !== 0) {
          const aStop = this.accelTowardObstacle(i, vi, v0, gapToLine, 0);
          if (aStop < acc) {
            acc = aStop;
            if (aFree - aStop >= LEADER_BINDING_MPS2) c = blocked;
          }
        }
      }

      // Obstacle: a conflict point inside the junction the movement may not cross yet (T-11).
      // The vehicle is placed on the connector's own coordinate: negative while it still approaches
      // the stop line, so one walk over the connector's conflict points covers both cases.
      const conn = t >= rt.laneCount ? t : next;
      if (conn >= rt.laneCount) {
        const sHere = t === conn ? si : si - (trackEnd[t] as number);
        const dist = this.conflictStopDistance(i, conn, sHere);
        if (dist < Number.POSITIVE_INFINITY) {
          const aStop = this.accelTowardObstacle(i, vi, v0, dist, 0);
          if (aStop < acc) {
            acc = aStop;
            if (aFree - aStop >= LEADER_BINDING_MPS2) c = this.conflictCause;
          }
        }

        // Obstacle: a pedestrian on, or about to step onto, a crosswalk this movement crosses (T-15).
        if (this.pedestrians.enabled && (rt.connCrosswalkCount[conn] as number) > 0) {
          const distPed = this.pedestrianStopDistance(i, conn, sHere);
          if (distPed < Number.POSITIVE_INFINITY) {
            const aStop = this.accelTowardObstacle(i, vi, v0, distPed, 0);
            if (aStop < acc) {
              acc = aStop;
              if (aFree - aStop >= LEADER_BINDING_MPS2) c = CAUSE_PEDESTRIAN_YIELD;
            }
          }
        }
      }

      // Obstacle: the exit of the movement has no room left and the driver is disciplined enough
      // not to block the junction (N19). An undisciplined one enters and may lock it instead.
      if (t < rt.laneCount && next >= rt.laneCount && this.gridlockDisciplined[i] === 1) {
        const room = this.intersections.exitFreeM[next] as number;
        if (room < (len[i] as number) + (pool.minGap[i] as number)) {
          const aStop = this.accelTowardObstacle(i, vi, v0, (trackEnd[t] as number) - si, 0);
          if (aStop < acc) {
            acc = aStop;
            if (aFree - aStop >= LEADER_BINDING_MPS2) c = CAUSE_DOWNSTREAM_SPILLBACK;
          }
        }
      }

      // A vehicle that has to brake for a mandatory change it could not make blames the change,
      // not the vehicle in front of it (the leader is only the messenger).
      if (
        this.laneChangeBlocked[i] === 1 &&
        acc < LANE_CHANGE_WAIT_DECEL_MPS2 &&
        (c === CAUSE_LEADER || c === CAUSE_FREE_FLOW || c === CAUSE_SPEED_LIMIT)
      ) {
        c = CAUSE_LANE_CHANGE_WAIT;
      }

      a[i] = acc;
      cause[i] = c;
    }
  }

  /**
   * Distance from `sHere` (the vehicle's position in the coordinate of connector `conn`, negative
   * while it is still on the approach lane) to the first conflict point of that movement it may not
   * cross, or +Infinity when the whole movement is clear. The reason lands in `conflictCause`.
   *
   * A point is closed when a car is stuck on it and cannot leave the junction -- that binds every
   * movement, protected ones included, and is what `gridlock` means -- or when this movement gives
   * way there and a vehicle of the priority movement stands on the point or arrives within the
   * driver's critical gap.
   */
  private conflictStopDistance(i: number, conn: number, sHere: number): number {
    const ir = this.intersections;
    const cf = ir.conflicts;
    const start = cf.conflictStart[conn] as number;
    const count = cf.conflictCount[conn] as number;
    if (count === 0) return Number.POSITIVE_INFINITY;
    const pool = this.pool;
    const yieldCause = yieldCauseByTurn(this.runtime.connTurn[conn] as number);
    const lengthI = pool.length[i] as number;
    // Accepted gap = the driver's critical gap plus the time it needs to clear the point from the
    // place it waits: a gap that is only just long enough to start is not long enough to finish.
    const criticalGapS =
      ((this.runtime.connTurn[conn] as number) === TurnCode.left
        ? (pool.gapLeftTurn[i] as number)
        : (pool.gapMerge[i] as number)) +
      (CONFLICT_STOP_MARGIN_M + CONFLICT_ZONE_M + lengthI) / CONFLICT_CROSSING_MPS;
    for (let k = start; k < start + count; k++) {
      const sPoint = cf.conflictSThis[k] as number;
      if (sPoint <= sHere) continue; // already crossed
      const blocked = ir.pointJammed[k] === 1;
      const yielding =
        !blocked &&
        ir.mustYield[k] === 1 &&
        (ir.pointOccupied[k] === 1 || (ir.threatTimeS[k] as number) < criticalGapS);
      if (!blocked && !yielding) continue;
      // Wait clear of every point, not just of this one: a body left standing across a crossing it
      // has already passed would block that movement and hand the waiting driver right of way.
      let stopAt = sPoint - CONFLICT_STOP_MARGIN_M;
      for (let m = k - 1; m >= start; m--) {
        const earlier = cf.conflictSThis[m] as number;
        if (earlier < stopAt - lengthI - CONFLICT_STOP_MARGIN_M) break;
        stopAt = earlier - CONFLICT_STOP_MARGIN_M;
      }
      if (stopAt > sHere) {
        this.conflictCause = blocked ? CAUSE_GRIDLOCK : yieldCause;
        return stopAt - sHere;
      }
      // Past the last safe place to wait. A vehicle already committed into the junction keeps going
      // unless the point itself is taken, in which case stopping short is still better than driving
      // into the occupant.
      if (ir.pointOccupied[k] === 1 || blocked) {
        this.conflictCause = blocked ? CAUSE_GRIDLOCK : yieldCause;
        return 0;
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  /**
   * Distance from `sHere` to the point where connector `conn` enters its crosswalk(s), or +Infinity
   * when no pedestrian threatens it right now (T-15). Same shape as `conflictStopDistance` on purpose:
   * the crosswalk sits right where the connector meets its destination lane (the compiler places it
   * just past the junction box, `CROSSWALK_CLEARANCE_M`), so the stop point is the connector's own
   * end minus the usual margin, rolled back over any of the connector's *vehicle* conflict points
   * within body length -- otherwise a car waiting for pedestrians could straddle an earlier conflict
   * point it already crossed and report that movement falsely jammed/gridlocked (T-11 review note).
   *
   * A vehicle already past the last safe waiting spot keeps going unless a pedestrian is *actually* on
   * the crosswalk (`occupied`): the anticipatory half of `threatTimeS` must never hold a car that is
   * already committed at zero gap for a pedestrian who has not stepped out yet, mirroring how
   * `conflictStopDistance` only forces 0 there for a point that is truly occupied or jammed.
   */
  private pedestrianStopDistance(i: number, conn: number, sHere: number): number {
    const rt = this.runtime;
    const pool = this.pool;
    const start = rt.connCrosswalkStart[conn] as number;
    const count = rt.connCrosswalkCount[conn] as number;
    const lengthI = pool.length[i] as number;
    // Accepted gap = the driver's critical gap plus the time it needs to clear the crossing from the
    // place it waits, exactly like `conflictStopDistance`'s left-turn/merge gap.
    const criticalGapS =
      (pool.gapPedestrian[i] as number) +
      (CONFLICT_STOP_MARGIN_M + CONFLICT_ZONE_M + lengthI) / CONFLICT_CROSSING_MPS;
    let threat = Number.POSITIVE_INFINITY;
    let occupied = false;
    for (let k = start; k < start + count; k++) {
      const cw = rt.connCrosswalkList[k] as number;
      if (this.pedestrians.activeCount(cw) > 0) occupied = true;
      const t = this.pedestrians.threatTimeS(cw);
      if (t < threat) threat = t;
    }
    if (!occupied && threat >= criticalGapS) return Number.POSITIVE_INFINITY;

    let stopAt = (rt.trackEndS[conn] as number) - CONFLICT_STOP_MARGIN_M;
    const cf = this.intersections.conflicts;
    const cStart = cf.conflictStart[conn] as number;
    const cCount = cf.conflictCount[conn] as number;
    for (let m = cStart + cCount - 1; m >= cStart; m--) {
      const earlier = cf.conflictSThis[m] as number;
      if (earlier >= stopAt) continue; // not behind the pedestrian point
      if (earlier < stopAt - lengthI - CONFLICT_STOP_MARGIN_M) break;
      stopAt = earlier - CONFLICT_STOP_MARGIN_M;
    }
    if (stopAt > sHere) return stopAt - sHere;
    return occupied ? 0 : Number.POSITIVE_INFINITY;
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
      // Distance really covered, the numerator of the trip's mean speed (T-18 totals).
      pool.distanceM[i] = (pool.distanceM[i] as number) + vNew * dt;
      const sNew = (s[i] as number) + vNew * dt;
      let fl = 0;
      if (ai < BRAKING_MPS2) fl |= VehicleFlag.BRAKING;
      if (vNew <= stoppedV) fl |= VehicleFlag.STOPPED;
      if ((pool.laneChangeEndS[i] as number) > now) {
        fl |=
          (pool.laneChangeDir[i] as number) < 0
            ? VehicleFlag.BLINKER_LEFT
            : VehicleFlag.BLINKER_RIGHT;
      }
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
        // A gate lane leaves the network; so does a vehicle whose route ends at this node (an
        // attractor inside the polygon). Anything else ran out of lane and is dropped.
        if (rt.trackIsExit[t] === 1 || pool.routeArrive[i] === 1) this.despawn(i, now);
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
      pool.laneChangeEndS[i] = 0;
      pool.laneChangeDir[i] = 0;
      pool.targetLane[i] = -1;
      this.laneChangeBlocked[i] = 0;
      if (t < rt.laneCount) this.enterLink(i, t, now);
      else
        pool.nextTrack[i] = rt.trackNextByClass[
          t * CLASS_COUNT + (pool.cls[i] as number)
        ] as number;
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
      // Occupancy by the hour the trip *ended* (T-14, item 4): a trip that straddles the peak
      // boundary is counted by the crowding its passengers actually rode in on the way out.
      const clsParams = this.cfg.vehicleClasses[VEHICLE_CLASS_BY_CODE[c] as VehicleClass];
      const occupancy = isPeakHour(this.cfg, this.clock.timeOfDayMin)
        ? clsParams.occupancyPeak
        : clsParams.occupancyOffpeak;
      pool.occupancy[i] = occupancy;
      this.completedByClass[c] = (this.completedByClass[c] as number) + 1;
      this.tripTimeByClass[c] = (this.tripTimeByClass[c] as number) + trip;
      this.delayByClass[c] = (this.delayByClass[c] as number) + delay;
      this.stopsByClass[c] = (this.stopsByClass[c] as number) + (pool.stops[i] as number);
      this.personDelayByClass[c] = (this.personDelayByClass[c] as number) + delay * occupancy;
      // Mean speed by class over the metrics window is measured on the trips that finished in it.
      this.totalsTracker.recordTrip(c, pool.distanceM[i] as number, trip, now);
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
   * Poisson arrivals per OD source (gates by `weightIn`, attractors by `weightOut`; intensity from
   * the hourly profile), each with a destination drawn from the OD model, placed when an entry lane
   * has room. Arrivals that cannot enter wait in a per-source counter capped at GATE_QUEUE_HORIZON_S
   * seconds of the current rate, so a lower multiplier takes effect at once even behind a queue.
   */
  private spawn(dt: number, now: number): void {
    const cfg = this.cfg;
    const demand = cfg.demand;
    const od = this.od;
    const pool = this.pool;
    const ratePerS = tripRatePerS(this.baseTripsPerHour, demand, this.clock.hourOfDay);
    const afterWarmup = now >= this.warmupEndS;
    const entryGapM = cfg.driver.minGapM.max;
    for (let s = 0; s < od.sourceCount; s++) {
      const share = od.sourceShare[s] as number;
      if (share <= 0) continue;
      const sourceRate = ratePerS * share;
      this.arrivals.advance(s, sourceRate, dt, GATE_QUEUE_HORIZON_S, this.spawnRng);

      let blockedByLane = false;
      while ((this.arrivals.waiting[s] as number) > 0) {
        if (pool.freeCount === 0) break; // vehicle budget: arrivals keep waiting
        const cls: VehicleClass = this.spawnRng.chance(demand.taxiShare) ? "taxi" : "car";
        const clsParams = cfg.vehicleClasses[cls];
        const lane = this.bestEntryLane(s, VEHICLE_CLASS_CODE[cls], clsParams.lengthM + entryGapM);
        if (lane < 0) {
          blockedByLane = true;
          break;
        }
        this.place(lane, cls, clsParams, now, afterWarmup, this.sampleDestFrom(s, lane));
        this.arrivals.take(s);
      }
      if (blockedByLane && afterWarmup) this.spawnWaits += this.arrivals.claimUncounted(s);
    }
  }

  /**
   * Destination of a trip born on `lane` at source `s`, drawn from the OD model and rejected while
   * the routing graph cannot get there (one-way streets and turn bans make a fair share of the OD
   * pairs impossible on a small bbox). Reachability is a property of the topology, so testing it on
   * the unperturbed copy 0 answers for every copy. -1 when nothing fits: the vehicle then simply
   * drives out of the network.
   */
  private sampleDestFrom(s: number, lane: number): number {
    const link = this.runtime.trackLink[lane] as number;
    const node = this.od.sourceNode[s] as number;
    const internalShare = this.cfg.demand.internalTripShare;
    for (let attempt = 0; attempt < DEST_DRAW_ATTEMPTS; attempt++) {
      const dest = this.od.sampleDest(this.odRng, internalShare, node);
      if (dest < 0) return -1;
      if (link < 0) return dest;
      if (this.routeTrees.nextLink(0, dest, link) !== ROUTE_UNREACHABLE) return dest;
    }
    return -1;
  }

  /**
   * Entry lane of OD source `s` with the largest free space at its start among lanes admitting the
   * class (ties go to the rightmost lane), or -1 when none has at least `needM` metres. Leaves the
   * lane's last vehicle in `scratchTail`.
   */
  private bestEntryLane(s: number, clsCode: number, needM: number): number {
    const rt = this.runtime;
    const pool = this.pool;
    const bit = 1 << clsCode;
    const start = this.od.sourceLaneStart[s] as number;
    const count = this.od.sourceLaneCount[s] as number;
    let best = -1;
    let bestGap = Number.NEGATIVE_INFINITY;
    let bestTail = -1;
    for (let k = 0; k < count; k++) {
      const lane = this.od.sourceLanes[start + k] as number;
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
    now: number,
    afterWarmup: boolean,
    dest: number,
  ): void {
    const rt = this.runtime;
    const pool = this.pool;
    const i = pool.alloc();
    sampleDriverInto(pool, i, this.driverRng, this.cfg.driver, cls, clsParams);
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
    pool.geomSeg[i] = 0;
    // Cars and taxis that ignore bus lanes are drawn once, at spawn (behavior.busLaneViolatorShare).
    let persistent =
      (cls === "car" || cls === "taxi") &&
      this.laneRng.chance(this.cfg.behavior.busLaneViolatorShare)
        ? VehicleFlag.BUS_LANE_VIOLATOR
        : 0;
    // Route (T-12): the tree copy spreads identical trips over parallel streets, the NAVIGATOR
    // draw decides whether the driver follows live travel times or the static costs.
    pool.routeDest[i] = dest;
    pool.routeCopy[i] = this.routeRng.int(ROUTE_COPIES);
    pool.routeArrive[i] = 0;
    pool.routeNextLink[i] = -1;
    pool.routeLink[i] = -1;
    pool.linkEnterS[i] = now;
    if (this.routeRng.chance(this.cfg.demand.navigatorShare)) persistent |= VehicleFlag.NAVIGATOR;
    pool.persistentFlags[i] = persistent;
    // Reset the transit fields (T-14): a reused slot may have last held a bus, and `enterLink` below
    // dispatches on `busRoute` -- a stale value here would misroute a plain car spawn.
    pool.busRoute[i] = -1;
    pool.busRouteLinkIdx[i] = -1;
    pool.busStopIdx[i] = 0;
    pool.dwellEndS[i] = 0;
    pool.targetLane[i] = -1;
    pool.laneChangeEndS[i] = 0;
    pool.laneChangeDir[i] = 0;
    pool.laneChangeFromOffsetM[i] = rt.trackOffsetM[lane] as number;
    this.pendingLane[i] = -1;
    this.laneChangeBlocked[i] = 0;
    // Gridlock discipline is a property of the driver, drawn once (behavior.gridlockDiscipline).
    this.gridlockDisciplined[i] = this.junctionRng.chance(this.cfg.behavior.gridlockDiscipline)
      ? 1
      : 0;
    this.enterLink(i, lane, now);
    pool.flags[i] = vEntry <= this.cfg.metrics.stoppedSpeedMps ? VehicleFlag.STOPPED : 0;
    pool.cause[i] = CAUSE_FREE_FLOW;
    pool.rootCause[i] = CAUSE_FREE_FLOW;
    pool.spawnTimeS[i] = now;
    pool.freeFlowTimeS[i] = ((rt.trackEndS[lane] as number) - sSpawn) / v0;
    pool.distanceM[i] = 0;
    pool.stops[i] = 0;
    pool.countsInStats[i] = afterWarmup ? 1 : 0;
    pool.insert(lane, i);
    const c = pool.cls[i] as number;
    this.activeByClass[c] = (this.activeByClass[c] as number) + 1;
    if (afterWarmup) this.spawnedByClass[c] = (this.spawnedByClass[c] as number) + 1;
  }

  /**
   * Bus/trolleybus arrivals (T-14, item 1): unlike `spawn()`, a route is not a Poisson process over
   * OD sources -- each fires on its own scheduled headway (`BusScheduleRuntime`), with a random offset
   * for the very first departure. A route whose entry lane has no room simply keeps trying every
   * step: `nextSpawnS` is not advanced until a bus actually enters, so a queue at the terminus does
   * not silently push every later departure back by the same amount.
   */
  private spawnBuses(now: number, peak: boolean): void {
    const schedule = this.transitSchedule;
    const afterWarmup = now >= this.warmupEndS;
    for (let r = 0; r < schedule.routeCount; r++) {
      while ((schedule.nextSpawnS[r] as number) <= now) {
        if (!this.placeBus(r, now, afterWarmup)) break;
        schedule.advance(r, now, peak);
      }
    }
  }

  /**
   * Places one bus/trolleybus of route `routeIdx` on its entry lane. Mirrors `place()` for cars, but
   * with a fixed route instead of an OD destination (no taxi/violator/navigator draws), and
   * `enterLink` -- via `enterBusLink` -- walks `TransitRoute.linkSeq` instead of a routing tree.
   * Returns false when the entry lane has no room, so `spawnBuses` retries next step.
   */
  private placeBus(routeIdx: number, now: number, afterWarmup: boolean): boolean {
    const route = this.transitSchedule.routes[routeIdx] as TransitRoute;
    const rt = this.runtime;
    const pool = this.pool;
    const lane = route.entryLane;
    const clsParams = this.cfg.vehicleClasses[route.clsName];
    const needM = clsParams.lengthM + this.cfg.driver.minGapM.max;
    const tail = pool.trackTail[lane] as number;
    const gapAtEntry =
      tail >= 0
        ? (pool.s[tail] as number) -
          (pool.length[tail] as number) -
          (rt.trackStartS[lane] as number)
        : Number.POSITIVE_INFINITY;
    if (gapAtEntry < needM) return false;

    const i = pool.alloc();
    if (i < 0) return false; // vehicle budget exhausted; retried next step
    sampleDriverInto(pool, i, this.driverRng, this.cfg.driver, route.clsName, clsParams);
    const sSpawn = (rt.trackStartS[lane] as number) + (pool.length[i] as number);
    const v0 = (rt.trackSpeedMps[lane] as number) * (pool.speedFactor[i] as number);
    let vEntry = v0;
    if (tail >= 0) {
      const gap = (pool.s[tail] as number) - (pool.length[tail] as number) - sSpawn;
      const vEq = (gap - (pool.minGap[i] as number)) / (pool.timeHeadway[i] as number);
      if (vEq < vEntry) vEntry = vEq > 0 ? vEq : 0;
    }
    pool.s[i] = sSpawn;
    pool.v[i] = vEntry;
    pool.a[i] = 0;
    pool.geomSeg[i] = 0;
    // Scheduled transit never carries BUS_LANE_VIOLATOR or NAVIGATOR: it already runs its own lane.
    pool.persistentFlags[i] = 0;
    pool.routeDest[i] = -1;
    pool.routeCopy[i] = 0;
    pool.routeArrive[i] = 0;
    pool.routeNextLink[i] = -1;
    pool.routeLink[i] = -1;
    pool.linkEnterS[i] = now;
    pool.busRoute[i] = routeIdx;
    pool.busRouteLinkIdx[i] = -1; // enterBusLink (via enterLink below) advances it to 0
    pool.busStopIdx[i] = 0;
    pool.dwellEndS[i] = 0;
    pool.targetLane[i] = -1;
    pool.laneChangeEndS[i] = 0;
    pool.laneChangeDir[i] = 0;
    pool.laneChangeFromOffsetM[i] = rt.trackOffsetM[lane] as number;
    this.pendingLane[i] = -1;
    this.laneChangeBlocked[i] = 0;
    // Gridlock discipline is a property of the driver, drawn once, same as for cars (behavior.gridlockDiscipline).
    this.gridlockDisciplined[i] = this.junctionRng.chance(this.cfg.behavior.gridlockDiscipline)
      ? 1
      : 0;
    this.enterLink(i, lane, now);
    pool.flags[i] = vEntry <= this.cfg.metrics.stoppedSpeedMps ? VehicleFlag.STOPPED : 0;
    pool.cause[i] = CAUSE_FREE_FLOW;
    pool.rootCause[i] = CAUSE_FREE_FLOW;
    pool.spawnTimeS[i] = now;
    pool.freeFlowTimeS[i] = ((rt.trackEndS[lane] as number) - sSpawn) / v0;
    pool.distanceM[i] = 0;
    pool.stops[i] = 0;
    pool.countsInStats[i] = afterWarmup ? 1 : 0;
    pool.insert(lane, i);
    const c = pool.cls[i] as number;
    this.activeByClass[c] = (this.activeByClass[c] as number) + 1;
    if (afterWarmup) this.spawnedByClass[c] = (this.spawnedByClass[c] as number) + 1;
    return true;
  }

  /** World position and heading of every vehicle from its track polyline and lateral offset. */
  private updatePositions(now: number): void {
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
      let off = rt.trackOffsetM[t] as number;
      // Lane change in progress: slide the lateral offset over LANE_CHANGE_DURATION_S so the
      // renderer sees a continuous manoeuvre even though the vehicle switched lists at once.
      const lcEnd = pool.laneChangeEndS[i] as number;
      if (lcEnd > now && t < rt.laneCount) {
        const from = pool.laneChangeFromOffsetM[i] as number;
        const progress = 1 - (lcEnd - now) / LANE_CHANGE_DURATION_S;
        off = from + (off - from) * progress;
      }
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
    frame.signalStates.set(this.signals.groupState);
    this.pedestrians.writeCounts(frame.crosswalkPeds);
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

  /**
   * Windowed segment aggregates (T-18). A pure read of the sliding window the per-step sampler fills:
   * calling it more or less often changes nothing about the numbers, only about how fresh they are.
   */
  writeMetrics(frame?: MetricsFrame): MetricsFrame {
    const segmentCount = this.runtime.segments.length;
    const windowS = this.cfg.metrics.windowS;
    const f = frame ?? allocateMetricsFrame(segmentCount, windowS);
    f.simTimeS = this.clock.simTimeS;
    f.timeOfDayMin = this.clock.timeOfDayMin;
    f.windowS = windowS;
    f.segmentCount = segmentCount;
    this.metricsWindow.write(f);
    return f;
  }

  /** The detector and its ranked items arrive with T-19; the totals are real from T-18 on. */
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
    let completed = 0;
    let delayS = 0;
    let personDelayS = 0;
    for (let c = 0; c < CLASS_COUNT; c++) {
      completed += this.completedByClass[c] as number;
      delayS += this.delayByClass[c] as number;
      personDelayS += this.personDelayByClass[c] as number;
    }
    return this.totalsTracker.build(
      this.pool,
      this.runtime,
      this.metricsWindow,
      this.cfg.metrics.stoppedSpeedMps,
      this.clock.simTimeS,
      { completed, delayS, personDelayS },
      { car: CAR_CODE, bus: BUS_CODE },
    );
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
    // Demand went down: arrivals queued under the old rate must not keep entering.
    if (this.cfg.demand.multiplier < multiplierBefore) this.arrivals.clear();
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
