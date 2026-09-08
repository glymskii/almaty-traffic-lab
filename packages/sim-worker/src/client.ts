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
import { frameTransferList, metricsTransferList } from "@atl/contracts";

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

export function createSimClient(opts: SimClientOptions): SimClient {
  const worker = opts.createWorker();
  const frameBufferCount = opts.frameBufferCount ?? 3;
  const frameRateHz = opts.frameRateHz ?? 30;

  const frameListeners = new Set<(ev: FrameEvent) => void>();
  const metricsListeners = new Set<(frame: MetricsFrame) => void>();
  const reportListeners = new Set<(report: BottleneckReport) => void>();
  const progressListeners = new Set<(simTimeS: number, targetSimTimeS: number) => void>();
  const errorListeners = new Set<(message: string, fatal: boolean) => void>();

  let readyResolve: ((stats: InitStats) => void) | undefined;
  let readyReject: ((err: Error) => void) | undefined;
  let runUntilResolve: (() => void) | undefined;
  let runUntilReject: ((err: Error) => void) | undefined;
  let disposed = false;

  function send(msg: MainToWorker, transfer: ArrayBuffer[] = []): void {
    if (disposed) return;
    worker.postMessage(msg, transfer);
  }

  worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
    if (disposed) return;
    const msg = ev.data;
    switch (msg.type) {
      case "ready": {
        if (readyResolve) {
          const resolve = readyResolve;
          readyResolve = undefined;
          readyReject = undefined;
          resolve(msg.stats);
        }
        break;
      }
      case "frame": {
        const frame = msg.frame;
        for (const cb of frameListeners) {
          cb({
            frame,
            simTimeS: msg.simTimeS,
            timeOfDayMin: msg.timeOfDayMin,
            rtFactor: msg.rtFactor,
            vehicleCount: msg.vehicleCount,
          });
        }
        send({ type: "returnFrame", frame }, frameTransferList(frame));
        break;
      }
      case "metrics": {
        const frame = msg.frame;
        for (const cb of metricsListeners) cb(frame);
        send({ type: "returnMetrics", frame }, metricsTransferList(frame));
        break;
      }
      case "report":
        for (const cb of reportListeners) cb(msg.report);
        break;
      case "progress":
        for (const cb of progressListeners) cb(msg.simTimeS, msg.targetSimTimeS);
        break;
      case "paused": {
        if (runUntilResolve) {
          const resolve = runUntilResolve;
          runUntilResolve = undefined;
          runUntilReject = undefined;
          resolve();
        }
        break;
      }
      case "error": {
        for (const cb of errorListeners) cb(msg.message, msg.fatal);
        if (readyReject) {
          const reject = readyReject;
          readyResolve = undefined;
          readyReject = undefined;
          reject(new Error(msg.message));
        }
        if (runUntilReject) {
          const reject = runUntilReject;
          runUntilResolve = undefined;
          runUntilReject = undefined;
          reject(new Error(msg.message));
        }
        break;
      }
    }
  };

  return {
    init(network, config, scenario) {
      return new Promise<InitStats>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
        send({ type: "init", network, config, scenario, frameBufferCount, frameRateHz });
      });
    },
    play(speedFactor) {
      send({ type: "play", speedFactor });
    },
    pause() {
      send({ type: "pause" });
    },
    runUntil(simTimeS) {
      return new Promise<void>((resolve, reject) => {
        runUntilResolve = resolve;
        runUntilReject = reject;
        send({ type: "runUntil", simTimeS });
      });
    },
    setParams(patch) {
      send({ type: "setParams", patch });
    },
    requestReport() {
      send({ type: "requestReport" });
    },
    onFrame(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    onMetrics(cb) {
      metricsListeners.add(cb);
      return () => metricsListeners.delete(cb);
    },
    onReport(cb) {
      reportListeners.add(cb);
      return () => reportListeners.delete(cb);
    },
    onProgress(cb) {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },
    onError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    dispose() {
      if (disposed) return;
      try {
        worker.postMessage({ type: "dispose" } satisfies MainToWorker, []);
      } catch {
        // worker may already be unusable; termination below is what matters.
      }
      disposed = true;
      worker.onmessage = null;
      worker.terminate();
    },
  };
}

/** Type guards shared by client and tests. */
export function isWorkerMessage(v: unknown): v is WorkerToMain {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}
export type { MainToWorker };
