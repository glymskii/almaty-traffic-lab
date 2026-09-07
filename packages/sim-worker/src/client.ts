import type {
  BottleneckReport,
  FrameBuffers,
  InitStats,
  MainToWorker,
  MetricsFrame,
  Network,
  Scenario,
  SimConfig,
  SimConfigPatch,
  WorkerToMain,
} from "@atl/contracts";

export interface FrameEvent {
  frame: FrameBuffers;
  simTimeS: number;
  timeOfDayMin: number;
  rtFactor: number;
  vehicleCount: number;
}

export interface SimClientOptions {
  /** Factory so the app controls the Worker URL/bundling: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) */
  createWorker: () => Worker;
  frameBufferCount?: number;
  frameRateHz?: number;
}

/**
 * Main-thread facade over one worker. Owns the ping-pong: after `onFrame` returns, the buffer is
 * sent back automatically. Two clients with the same seed = A/B comparison. Implemented in T-06.
 */
export interface SimClient {
  init(network: Network, config: SimConfig, scenario: Scenario): Promise<InitStats>;
  play(speedFactor: number): void;
  pause(): void;
  /** Resolves when the worker reaches the target sim time; `onProgress` fires along the way. */
  runUntil(simTimeS: number): Promise<void>;
  setParams(patch: SimConfigPatch): void;
  requestReport(): void;
  onFrame(cb: (ev: FrameEvent) => void): () => void;
  onMetrics(cb: (frame: MetricsFrame) => void): () => void;
  onReport(cb: (report: BottleneckReport) => void): () => void;
  onProgress(cb: (simTimeS: number, targetSimTimeS: number) => void): () => void;
  onError(cb: (message: string, fatal: boolean) => void): () => void;
  dispose(): void;
}

export function createSimClient(_opts: SimClientOptions): SimClient {
  throw new Error("not implemented: see docs/tasks/T-06-worker-protocol.md");
}

/** Type guards shared by client and tests. */
export function isWorkerMessage(v: unknown): v is WorkerToMain {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}
export type { MainToWorker };
