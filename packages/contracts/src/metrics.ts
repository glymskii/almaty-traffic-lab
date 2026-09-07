import { z } from "zod";
import { CAUSE_COUNT, type CauseKey } from "./causes.ts";
import { IdSchema } from "./common.ts";
import { NetworkOverrideSchema } from "./overrides.ts";

/**
 * Lanes are cut into fixed-length segments (config.metrics.segmentLengthM) for aggregation,
 * heat-map colouring and bottleneck detection. Segment order is fixed at init and sent once
 * to the main thread; every MetricsFrame indexes typed arrays by that order.
 */
export const SegmentDescriptorSchema = z.object({
  index: z.number().int().nonnegative(),
  laneId: IdSchema,
  linkId: IdSchema,
  startS: z.number().nonnegative(),
  endS: z.number().positive(),
  /** Free-flow speed used as the denominator of speedRatio, m/s. */
  freeFlowSpeedMps: z.number().positive(),
  /** Node at the end of the link, if the segment is the last one before it (approach segment). */
  approachNodeId: IdSchema.optional(),
});
export type SegmentDescriptor = z.infer<typeof SegmentDescriptorSchema>;

/** Windowed aggregates per segment. Arrays have length segmentCount unless stated otherwise. */
export interface MetricsFrame {
  simTimeS: number;
  timeOfDayMin: number;
  windowS: number;
  segmentCount: number;
  /** mean speed / free-flow speed over the window, 0..1 */
  speedRatio: Float32Array;
  /** vehicles per lane-km, window mean */
  density: Float32Array;
  /** vehicles per hour crossing the segment end, window mean */
  flow: Float32Array;
  /** standing queue length in metres, window mean */
  queueM: Float32Array;
  /** share of window samples in which the segment was congested (persistence) */
  congestedShare: Float32Array;
  /** vehicle-seconds of delay vs free-flow accumulated in the window */
  delayVehS: Float32Array;
  /** person-seconds of delay (vehicle delay * occupancy) */
  delayPersonS: Float32Array;
  /** volume / capacity estimate for the segment's lane */
  vcRatio: Float32Array;
  /** [segmentCount * CAUSE_COUNT] share of delay attributed to each root cause, rows sum to 1 or 0 */
  causeShare: Float32Array;
}

export function allocateMetricsFrame(segmentCount: number, windowS: number): MetricsFrame {
  return {
    simTimeS: 0,
    timeOfDayMin: 0,
    windowS,
    segmentCount,
    speedRatio: new Float32Array(segmentCount),
    density: new Float32Array(segmentCount),
    flow: new Float32Array(segmentCount),
    queueM: new Float32Array(segmentCount),
    congestedShare: new Float32Array(segmentCount),
    delayVehS: new Float32Array(segmentCount),
    delayPersonS: new Float32Array(segmentCount),
    vcRatio: new Float32Array(segmentCount),
    causeShare: new Float32Array(segmentCount * CAUSE_COUNT),
  };
}

export function metricsTransferList(f: MetricsFrame): ArrayBuffer[] {
  return [
    f.speedRatio.buffer as ArrayBuffer,
    f.density.buffer as ArrayBuffer,
    f.flow.buffer as ArrayBuffer,
    f.queueM.buffer as ArrayBuffer,
    f.congestedShare.buffer as ArrayBuffer,
    f.delayVehS.buffer as ArrayBuffer,
    f.delayPersonS.buffer as ArrayBuffer,
    f.vcRatio.buffer as ArrayBuffer,
    f.causeShare.buffer as ArrayBuffer,
  ];
}

export const LosSchema = z.enum(["A", "B", "C", "D", "E", "F"]);
export type Los = z.infer<typeof LosSchema>;

/** Level of service from a V/C ratio (HCM-style thresholds, good enough for a demo). */
export function losFromVc(vc: number): Los {
  if (vc < 0.35) return "A";
  if (vc < 0.55) return "B";
  if (vc < 0.75) return "C";
  if (vc < 0.9) return "D";
  if (vc <= 1.0) return "E";
  return "F";
}

export const RecommendationKindSchema = z.enum([
  "add_left_arrow",
  "extend_left_pocket",
  "add_left_pocket",
  "prohibit_left_turn",
  "rebalance_green",
  "coordinate_offsets",
  "bus_stop_bay",
  "bus_lane_hours",
  "remove_bus_lane",
  "add_bus_lane",
  "add_lane",
  "discipline_enforcement",
  "ramp_metering",
  "none",
]);
export type RecommendationKind = z.infer<typeof RecommendationKindSchema>;

export const RecommendationSchema = z.object({
  kind: RecommendationKindSchema,
  /** Russian, shown in the panel. */
  label: z.string(),
  /** Ready-to-apply scenario overrides implementing the recommendation, if expressible. */
  overrides: z.array(NetworkOverrideSchema).default([]),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const CauseShareSchema = z.object({
  cause: z.custom<CauseKey>((v) => typeof v === "string"),
  share: z.number().min(0).max(1),
});

export const BottleneckItemSchema = z.object({
  rank: z.number().int().positive(),
  /** Stable id across frames: `${linkId}:${approachNodeId ?? "mid"}` */
  id: IdSchema,
  segmentIndices: z.array(z.number().int().nonnegative()).min(1),
  linkId: IdSchema,
  nodeId: IdSchema.optional(),
  /** e.g. "Абая × Байтурсынова, подход с запада" */
  title: z.string(),
  delayVehH: z.number().nonnegative(),
  delayPersonH: z.number().nonnegative(),
  speedRatio: z.number().min(0).max(1),
  queueM: z.number().nonnegative(),
  vcRatio: z.number().nonnegative(),
  los: LosSchema,
  persistence: z.number().min(0).max(1),
  causes: z.array(CauseShareSchema),
  recommendations: z.array(RecommendationSchema).default([]),
  /** Camera target in local metres. */
  focus: z.tuple([z.number(), z.number()]),
});
export type BottleneckItem = z.infer<typeof BottleneckItemSchema>;

export const NetworkTotalsSchema = z.object({
  vehiclesActive: z.number().int().nonnegative(),
  vehiclesCompleted: z.number().int().nonnegative(),
  /** Hours of delay accumulated since the start of the run (after warm-up). */
  delayVehH: z.number().nonnegative(),
  delayPersonH: z.number().nonnegative(),
  meanSpeedKph: z.number().nonnegative(),
  carMeanSpeedKph: z.number().nonnegative(),
  busMeanSpeedKph: z.number().nonnegative(),
  /** Share of vehicles currently stopped. */
  stoppedShare: z.number().min(0).max(1),
  /** Share of network segments in LOS E/F. */
  congestedSegmentShare: z.number().min(0).max(1),
});
export type NetworkTotals = z.infer<typeof NetworkTotalsSchema>;

export const BottleneckReportSchema = z.object({
  simTimeS: z.number().nonnegative(),
  timeOfDayMin: z.number().min(0).max(1440),
  windowS: z.number().positive(),
  totals: NetworkTotalsSchema,
  items: z.array(BottleneckItemSchema),
});
export type BottleneckReport = z.infer<typeof BottleneckReportSchema>;

/** Output of the headless CLI and the regression golden file. */
export const RunSummarySchema = z.object({
  networkId: IdSchema,
  scenarioId: IdSchema,
  seed: z.number().int(),
  simulatedS: z.number().positive(),
  /** Deterministic hash of vehicle trajectories (see sim-core `trajectoryHash`). */
  trajectoryHash: z.string(),
  totals: NetworkTotalsSchema,
  top: z.array(BottleneckItemSchema),
  /** Wall-clock performance, informational only (not compared in regression). */
  perf: z
    .object({ wallMs: z.number(), stepsPerS: z.number(), vehiclesMean: z.number() })
    .optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;
