import type { BottleneckReport, MetricsFrame, SegmentDescriptor } from "./metrics.ts";
import type { Network } from "./network.ts";
import type { Scenario } from "./overrides.ts";
import type { SimConfig, SimConfigPatch } from "./sim-config.ts";
import type { FrameBuffers } from "./state.ts";

/**
 * Main thread <-> sim worker protocol. One worker = one simulation instance.
 * A/B comparison runs two workers with the same seed.
 * Frame buffers are transferred (not copied) in both directions.
 */

export interface InitStats {
  vehicleCapacity: number;
  signalGroupCount: number;
  crosswalkCount: number;
  segments: SegmentDescriptor[];
  /** Global signal group order used by FrameBuffers.signalStates. */
  signalGroupIds: string[];
  crosswalkIds: string[];
}

export type MainToWorker =
  | {
      type: "init";
      /** Already compiled with scenario overrides applied. */
      network: Network;
      config: SimConfig;
      scenario: Scenario;
      /** How many FrameBuffers to pre-allocate for ping-pong (2-3). */
      frameBufferCount: number;
      /** Target frames per second sent to the main thread. */
      frameRateHz: number;
    }
  | { type: "play"; speedFactor: number }
  | { type: "pause" }
  /** Run as fast as possible until this sim time (warm-up, fast-forward). Emits `progress`. */
  | { type: "runUntil"; simTimeS: number }
  /** Only RUNTIME_SAFE_PARAM_PATHS; anything else is rejected with an `error`. */
  | { type: "setParams"; patch: SimConfigPatch }
  | { type: "returnFrame"; frame: FrameBuffers }
  | { type: "returnMetrics"; frame: MetricsFrame }
  | { type: "requestReport" }
  | { type: "dispose" };

export type WorkerToMain =
  | { type: "ready"; stats: InitStats }
  | {
      type: "frame";
      frame: FrameBuffers;
      simTimeS: number;
      timeOfDayMin: number;
      /** Achieved sim-seconds per wall-second divided by requested speedFactor. 1 = keeping up. */
      rtFactor: number;
      vehicleCount: number;
    }
  | { type: "metrics"; frame: MetricsFrame }
  | { type: "report"; report: BottleneckReport }
  | { type: "progress"; simTimeS: number; targetSimTimeS: number }
  | { type: "paused"; simTimeS: number }
  | { type: "error"; message: string; fatal: boolean };
