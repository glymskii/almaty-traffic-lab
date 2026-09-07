import { z } from "zod";
import { VehicleClassSchema } from "./common.ts";

/** Truncated normal distribution parameters. Sampled once per driver with the seeded RNG. */
export const DistributionSchema = z.object({
  mean: z.number(),
  sd: z.number().nonnegative(),
  min: z.number(),
  max: z.number(),
});
export type Distribution = z.infer<typeof DistributionSchema>;

const dist = (mean: number, sd: number, min: number, max: number) =>
  DistributionSchema.default({ mean, sd, min, max });

/** Per-driver heterogeneity. Multipliers are applied to the vehicle-class base values. */
export const DriverParamsSchema = z.object({
  /** Desired speed = speedLimit * factor. */
  desiredSpeedFactor: dist(1.0, 0.1, 0.7, 1.3),
  /** IDM safe time headway T. */
  timeHeadwayS: dist(1.2, 0.3, 0.6, 2.5),
  /** IDM jam distance s0. */
  minGapM: dist(2.0, 0.5, 1.0, 4.0),
  /** MOBIL politeness p. */
  politeness: dist(0.3, 0.2, 0.0, 1.0),
  /** MOBIL switching threshold a_thr (m/s^2). */
  laneChangeThresholdMps2: dist(0.2, 0.1, 0.05, 0.5),
  /** Accepted gap for a permissive left turn against opposing traffic. */
  criticalGapLeftTurnS: dist(5.0, 1.0, 3.5, 7.5),
  /** Accepted gap when merging or yielding at an unsignalized conflict. */
  criticalGapMergeS: dist(3.5, 0.8, 2.5, 5.0),
  /** Accepted gap in front of a pedestrian on a crosswalk. */
  criticalGapPedestrianS: dist(4.0, 0.8, 2.5, 6.0),
});
export type DriverParams = z.infer<typeof DriverParamsSchema>;

export const VehicleClassParamsSchema = z.object({
  lengthM: z.number().positive(),
  widthM: z.number().positive(),
  maxAccelMps2: z.number().positive(),
  comfortDecelMps2: z.number().positive(),
  /** Multiplier on the driver's desired speed (buses are slower). */
  desiredSpeedFactor: z.number().positive(),
  occupancyPeak: z.number().positive(),
  occupancyOffpeak: z.number().positive(),
});
export type VehicleClassParams = z.infer<typeof VehicleClassParamsSchema>;

export const VehicleClassesSchema = z.object({
  car: VehicleClassParamsSchema.default({
    lengthM: 4.5,
    widthM: 1.8,
    maxAccelMps2: 1.5,
    comfortDecelMps2: 2.0,
    desiredSpeedFactor: 1.0,
    occupancyPeak: 1.5,
    occupancyOffpeak: 1.5,
  }),
  taxi: VehicleClassParamsSchema.default({
    lengthM: 4.5,
    widthM: 1.8,
    maxAccelMps2: 1.7,
    comfortDecelMps2: 2.2,
    desiredSpeedFactor: 1.05,
    occupancyPeak: 1.8,
    occupancyOffpeak: 1.5,
  }),
  bus: VehicleClassParamsSchema.default({
    lengthM: 12.0,
    widthM: 2.55,
    maxAccelMps2: 1.0,
    comfortDecelMps2: 1.5,
    desiredSpeedFactor: 0.9,
    occupancyPeak: 40,
    occupancyOffpeak: 20,
  }),
  trolleybus: VehicleClassParamsSchema.default({
    lengthM: 12.0,
    widthM: 2.55,
    maxAccelMps2: 0.9,
    comfortDecelMps2: 1.5,
    desiredSpeedFactor: 0.85,
    occupancyPeak: 40,
    occupancyOffpeak: 20,
  }),
});

/** Kazakhstan signal sequence: green -> flashing green -> yellow -> red -> red+yellow -> green. */
export const SignalTimingSchema = z.object({
  flashingGreenS: z.number().nonnegative().default(3),
  redYellowS: z.number().nonnegative().default(2),
  /** Used by the plan generator; individual phases carry their own yellow/allRed. */
  defaultYellowS: z.number().nonnegative().default(3),
  defaultAllRedS: z.number().nonnegative().default(2),
  minGreenS: z.number().positive().default(7),
  maxCycleS: z.number().positive().default(120),
  /** Saturation flow per lane, veh/h, for Webster's method. */
  saturationFlowVehPerHPerLane: z.number().positive().default(1800),
});
export type SignalTiming = z.infer<typeof SignalTimingSchema>;

const HOURLY = z.array(z.number().nonnegative()).length(24);

/** Multipliers by hour 0..23 relative to the network's base demand (1.0 = peak). */
export const DEFAULT_DEMAND_PROFILE = [
  0.05, 0.03, 0.02, 0.02, 0.04, 0.12, 0.35, 0.75, 1.0, 0.85, 0.6, 0.55, 0.6, 0.62, 0.6, 0.65, 0.8,
  0.95, 1.0, 0.8, 0.55, 0.35, 0.2, 0.1,
];
/** Pedestrians per hour per crosswalk (base, before per-node scaling). */
export const DEFAULT_PEDESTRIAN_PROFILE = [
  5, 3, 2, 2, 5, 20, 60, 150, 220, 180, 150, 160, 200, 180, 160, 170, 200, 240, 230, 180, 120, 70,
  35, 15,
];

export const DemandSchema = z.object({
  hourlyProfile: HOURLY.default(DEFAULT_DEMAND_PROFILE),
  /**
   * Total trips per hour at profile value 1.0 (peak). 0 = auto: 0.7 x summed capacity of gate inbound lanes,
   * computed by the simulation at init. Synthetic tests set it explicitly.
   */
  tripsPerHourPeak: z.number().nonnegative().default(0),
  /** Global multiplier on top of the profile. Runtime-safe. */
  multiplier: z.number().nonnegative().default(1),
  /** Hard cap on simultaneously simulated vehicles; spawns are throttled beyond it. */
  vehicleBudget: z.number().int().positive().default(20000),
  /** Share of car trips that are taxis (taxis behave like cars unless bus lanes admit them). */
  taxiShare: z.number().min(0).max(1).default(0.08),
  warmupMinutes: z.number().nonnegative().default(10),
  /** Per-driver multiplicative noise on link costs when choosing a route (spreads flow over parallel streets). */
  routeCostNoise: z.number().min(0).max(1).default(0.15),
  /** Share of drivers who re-route on live travel times ("навигаторные"). Runtime-safe. */
  navigatorShare: z.number().min(0).max(1).default(0.3),
  rerouteIntervalS: z.number().positive().default(60),
  /** Trips ending inside the polygon (attractors) vs passing through to another gate. */
  internalTripShare: z.number().min(0).max(1).default(0.45),
});
export type DemandConfig = z.infer<typeof DemandSchema>;

export const PedestrianConfigSchema = z.object({
  hourlyRatePerCrosswalk: HOURLY.default(DEFAULT_PEDESTRIAN_PROFILE),
  walkSpeedMps: z.number().positive().default(1.3),
  /** Pedestrians only start crossing while their group is green (signalized) or at any time (zebra). */
  enabled: z.boolean().default(true),
});
export type PedestrianConfig = z.infer<typeof PedestrianConfigSchema>;

export const BehaviorSchema = z.object({
  /** Probability that a driver refuses to enter an intersection whose exit is blocked. 1 = perfect discipline. Runtime-safe. */
  gridlockDiscipline: z.number().min(0).max(1).default(0.7),
  /** Share of car drivers who use bus lanes illegally. Runtime-safe. */
  busLaneViolatorShare: z.number().min(0).max(1).default(0.05),
  /** Whether taxis may use bus lanes (scenario toggle). */
  taxisAllowedInBusLanes: z.boolean().default(false),
  busDwellS: dist(25, 8, 10, 60),
  busDwellPeakFactor: z.number().positive().default(1.3),
  /** Distance before the stop line where a vehicle commits to its turn lane. */
  laneSelectionLookaheadM: z.number().positive().default(250),
});
export type BehaviorConfig = z.infer<typeof BehaviorSchema>;

export const BottleneckThresholdsSchema = z.object({
  /** Segment counts as congested when windowed mean speed / free-flow speed is below this. */
  speedRatioMax: z.number().min(0).max(1).default(0.3),
  /** Minimum standing queue length. */
  minQueueM: z.number().nonnegative().default(40),
  /** Share of window samples that must be congested (queue "держится, а не мигает"). */
  minPersistence: z.number().min(0).max(1).default(0.6),
  /** Downstream must be freer than this ratio for the segment to be a bottleneck (not just inside a queue). */
  downstreamSpeedRatioMin: z.number().min(0).max(1).default(0.5),
});

export const MetricsConfigSchema = z.object({
  segmentLengthM: z.number().positive().default(25),
  windowS: z.number().positive().default(300),
  sampleIntervalS: z.number().positive().default(1),
  topN: z.number().int().positive().default(10),
  bottleneck: BottleneckThresholdsSchema.prefault({}),
  /** Vehicle is "stopped" below this speed, m/s. */
  stoppedSpeedMps: z.number().nonnegative().default(0.5),
});
export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;

export const SimConfigSchema = z.object({
  seed: z.number().int().nonnegative().default(1),
  dtS: z.number().positive().default(0.1),
  /** Simulation clock at start, minutes since midnight. 480 = 08:00. */
  startTimeMin: z.number().min(0).max(1440).default(480),
  /** Hours considered "peak" for occupancy and headways. */
  peakHours: z.array(z.number().int().min(0).max(23)).default([7, 8, 9, 17, 18, 19]),
  driver: DriverParamsSchema.prefault({}),
  vehicleClasses: VehicleClassesSchema.prefault({}),
  signals: SignalTimingSchema.prefault({}),
  pedestrians: PedestrianConfigSchema.prefault({}),
  demand: DemandSchema.prefault({}),
  behavior: BehaviorSchema.prefault({}),
  metrics: MetricsConfigSchema.prefault({}),
  /** Debug invariants (no overlaps, no NaN). On in tests, off in production. */
  debugInvariants: z.boolean().default(false),
});
export type SimConfig = z.infer<typeof SimConfigSchema>;

export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
export type SimConfigPatch = DeepPartial<SimConfig>;

/** Parameters that may change while the simulation is running without a restart. */
export const RUNTIME_SAFE_PARAM_PATHS: readonly string[] = [
  "demand.multiplier",
  "demand.navigatorShare",
  "behavior.gridlockDiscipline",
  "behavior.busLaneViolatorShare",
];

export function defaultSimConfig(patch?: SimConfigPatch): SimConfig {
  return SimConfigSchema.parse(deepMerge({}, patch ?? {}));
}

export function applyConfigPatch(base: SimConfig, patch: SimConfigPatch): SimConfig {
  return SimConfigSchema.parse(deepMerge(JSON.parse(JSON.stringify(base)), patch));
}

export function isPeakHour(cfg: Pick<SimConfig, "peakHours">, timeOfDayMin: number): boolean {
  return cfg.peakHours.includes(Math.floor(timeOfDayMin / 60) % 24);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge of plain objects; arrays and primitives are replaced. */
export function deepMerge(
  target: Record<string, unknown>,
  patch: unknown,
): Record<string, unknown> {
  if (!isPlainObject(patch)) return target;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = target[k];
    if (isPlainObject(v) && isPlainObject(cur)) target[k] = deepMerge({ ...cur }, v);
    else if (isPlainObject(v)) target[k] = deepMerge({}, v);
    else target[k] = v;
  }
  return target;
}

export { VehicleClassSchema as SimVehicleClassSchema };
