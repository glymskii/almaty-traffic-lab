import type {
  BottleneckReport,
  FrameBuffers,
  MetricsFrame,
  Network,
  SegmentDescriptor,
  SimConfig,
  SimConfigPatch,
  VehicleClass,
} from "@atl/contracts";

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
  throw new Error("not implemented: see docs/tasks/T-04-sim-kernel.md");
}
