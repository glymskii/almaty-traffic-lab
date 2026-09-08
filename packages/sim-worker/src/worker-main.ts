import type {
  FrameBuffers,
  InitStats,
  MainToWorker,
  MetricsFrame,
  SimConfigPatch,
  WorkerToMain,
} from "@atl/contracts";
import {
  allocateFrameBuffers,
  allocateMetricsFrame,
  frameTransferList,
  metricsTransferList,
  RUNTIME_SAFE_PARAM_PATHS,
} from "@atl/contracts";
import type { CreateSimulationOptions, Simulation } from "@atl/sim-core";
import { createSimulation as createSimulationDefault } from "@atl/sim-core";

/**
 * Worker-side state machine and step loop, decoupled from `self` so it can run in node (tests)
 * or in a real DedicatedWorkerGlobalScope (worker.ts). See README.md for the state diagram.
 */

const MAX_STEPS_PER_ITERATION = 50;
/** "progress каждые 2 симуляционные минуты" (docs/tasks/T-06). */
const PROGRESS_INTERVAL_SIM_S = 120;
const RT_FACTOR_EMA_ALPHA = 0.2;
/**
 * Caps how much wall-clock time a single tick may bank into the step accumulator. Without this,
 * a throttled hidden tab (browsers slow setTimeout there) would report a huge elapsedS on the
 * next tick and spend many iterations at MAX_STEPS_PER_ITERATION trying to "catch up" instead of
 * honestly falling behind (rtFactor).
 */
const MAX_ELAPSED_S = 0.5;

type WorkerState = "idle" | "ready" | "playing" | "runningUntil" | "paused" | "disposed";

export interface WorkerMainOptions {
  post: (msg: WorkerToMain, transfer?: ArrayBuffer[]) => void;
  /** Defaults to @atl/sim-core's createSimulation; tests inject createStubSimulation instead. */
  createSimulation?: (opts: CreateSimulationOptions) => Simulation;
}

export interface WorkerMain {
  onMessage(msg: MainToWorker): void;
}

export function createWorkerMain(opts: WorkerMainOptions): WorkerMain {
  const post = opts.post;
  const createSim = opts.createSimulation ?? createSimulationDefault;

  let state: WorkerState = "idle";
  let sim: Simulation | undefined;
  let frameRateHz = 30;
  let speedFactor = 1;
  let freeFrames: FrameBuffers[] = [];
  let freeMetrics: MetricsFrame[] = [];

  // `play` loop: accumulator pattern so time left over from a capped tick (see
  // MAX_STEPS_PER_ITERATION) is not lost, just carried to the next tick.
  let accumulatorS = 0;
  let lastTickMs = 0;
  let lastFrameSentMs = 0;
  let rtFactor = 1;

  let lastMetricsSimTimeS = 0;
  let lastReportSimTimeS = 0;
  let lastProgressSimTimeS = 0;
  let runUntilTargetS = 0;

  function fail(message: string, fatal: boolean): void {
    post({ type: "error", message, fatal });
    if (fatal) state = "disposed";
  }

  function handleInit(msg: Extract<MainToWorker, { type: "init" }>): void {
    if (state !== "idle") {
      fail(`unexpected init in state ${state}`, false);
      return;
    }
    let created: Simulation;
    try {
      created = createSim({
        network: msg.network,
        config: msg.config,
        scenarioId: msg.scenario.id,
      });
    } catch (err) {
      fail(`failed to create simulation: ${errorMessage(err)}`, true);
      return;
    }

    const signalGroupIds = created.signalGroupIds();
    const crosswalkIds = created.crosswalkIds();
    const segments = created.segments();
    const capacity = msg.config.demand.vehicleBudget;

    sim = created;
    frameRateHz = msg.frameRateHz;
    speedFactor = 1;
    freeFrames = [];
    for (let i = 0; i < msg.frameBufferCount; i++) {
      freeFrames.push(allocateFrameBuffers(capacity, signalGroupIds.length, crosswalkIds.length));
    }
    freeMetrics = [
      allocateMetricsFrame(segments.length, msg.config.metrics.windowS),
      allocateMetricsFrame(segments.length, msg.config.metrics.windowS),
    ];
    accumulatorS = 0;
    lastTickMs = 0;
    lastFrameSentMs = 0;
    lastMetricsSimTimeS = created.simTimeS;
    lastReportSimTimeS = created.simTimeS;
    lastProgressSimTimeS = created.simTimeS;
    rtFactor = 1;
    state = "ready";

    const stats: InitStats = {
      vehicleCapacity: capacity,
      signalGroupCount: signalGroupIds.length,
      crosswalkCount: crosswalkIds.length,
      segments,
      signalGroupIds,
      crosswalkIds,
    };
    post({ type: "ready", stats });
  }

  function handlePlay(msg: Extract<MainToWorker, { type: "play" }>): void {
    if (!sim || (state !== "ready" && state !== "paused" && state !== "playing")) {
      fail(`unexpected play in state ${state}`, false);
      return;
    }
    const alreadyPlaying = state === "playing";
    speedFactor = msg.speedFactor;
    state = "playing";
    if (!alreadyPlaying) {
      // Avoid a catch-up burst: don't treat time spent paused as elapsed sim time.
      lastTickMs = 0;
      accumulatorS = 0;
      scheduleIteration();
    }
  }

  function handlePause(): void {
    if (!sim || state !== "playing") {
      fail(`unexpected pause in state ${state}`, false);
      return;
    }
    state = "paused";
    post({ type: "paused", simTimeS: sim.simTimeS });
  }

  function handleRunUntil(msg: Extract<MainToWorker, { type: "runUntil" }>): void {
    if (!sim || (state !== "ready" && state !== "paused")) {
      fail(`unexpected runUntil in state ${state}`, false);
      return;
    }
    runUntilTargetS = msg.simTimeS;
    lastProgressSimTimeS = sim.simTimeS;
    state = "runningUntil";
    scheduleIteration();
  }

  function handleSetParams(msg: Extract<MainToWorker, { type: "setParams" }>): void {
    if (!sim) {
      fail("setParams before init", false);
      return;
    }
    if (!isRuntimeSafePatch(msg.patch)) {
      fail("setParams: patch touches a path outside RUNTIME_SAFE_PARAM_PATHS", false);
      return;
    }
    try {
      sim.setParams(msg.patch);
    } catch (err) {
      fail(`setParams failed: ${errorMessage(err)}`, false);
    }
  }

  function handleRequestReport(): void {
    if (!sim) {
      fail("requestReport before init", false);
      return;
    }
    try {
      post({ type: "report", report: sim.report() });
      lastReportSimTimeS = sim.simTimeS;
    } catch (err) {
      fail(`report failed: ${errorMessage(err)}`, true);
    }
  }

  function handleDispose(): void {
    state = "disposed";
    sim = undefined;
    freeFrames = [];
    freeMetrics = [];
  }

  function scheduleIteration(): void {
    setTimeout(tick, 0);
  }

  function tick(): void {
    if (state !== "playing" && state !== "runningUntil") return;
    const activeSim = sim;
    if (!activeSim) {
      state = "paused";
      return;
    }
    const nowMs = Date.now();
    const elapsedS = lastTickMs === 0 ? 0 : clamp((nowMs - lastTickMs) / 1000, 0, MAX_ELAPSED_S);
    lastTickMs = nowMs;

    if (state === "playing") tickPlaying(activeSim, elapsedS, nowMs);
    else tickRunUntil(activeSim);
  }

  function tickPlaying(s: Simulation, elapsedS: number, nowMs: number): void {
    try {
      accumulatorS += elapsedS * speedFactor;
      let steps = 0;
      while (accumulatorS >= s.config.dtS && steps < MAX_STEPS_PER_ITERATION) {
        s.step();
        accumulatorS -= s.config.dtS;
        steps++;
      }
      if (elapsedS > 0 && speedFactor > 0) {
        const achieved = (steps * s.config.dtS) / elapsedS / speedFactor;
        rtFactor = rtFactor + RT_FACTOR_EMA_ALPHA * (clamp(achieved, 0, 2) - rtFactor);
      }
      maybeSendFrame(s, nowMs);
      maybeSendMetrics(s);
      maybeSendReport(s);
    } catch (err) {
      // A throw from the kernel mid-loop would otherwise escape the setTimeout callback and
      // hang the worker silently (no error message, no more frames, no reschedule).
      fail(`simulation step failed: ${errorMessage(err)}`, true);
      return;
    }
    scheduleIteration();
  }

  function tickRunUntil(s: Simulation): void {
    try {
      let steps = 0;
      while (s.simTimeS < runUntilTargetS && steps < MAX_STEPS_PER_ITERATION) {
        s.step();
        steps++;
        if (s.simTimeS - lastProgressSimTimeS >= PROGRESS_INTERVAL_SIM_S) {
          lastProgressSimTimeS = s.simTimeS;
          post({ type: "progress", simTimeS: s.simTimeS, targetSimTimeS: runUntilTargetS });
        }
      }
      maybeSendMetrics(s);
      maybeSendReport(s);
      if (s.simTimeS >= runUntilTargetS) {
        state = "paused";
        post({ type: "paused", simTimeS: s.simTimeS });
        return;
      }
    } catch (err) {
      fail(`simulation step failed: ${errorMessage(err)}`, true);
      return;
    }
    scheduleIteration();
  }

  function maybeSendFrame(s: Simulation, nowMs: number): void {
    const frameIntervalMs = 1000 / frameRateHz;
    if (nowMs - lastFrameSentMs < frameIntervalMs) return;
    const buf = freeFrames.pop();
    if (!buf) return; // no free buffer: skip this tick, retry once one is returned
    s.writeFrame(buf);
    lastFrameSentMs = nowMs;
    post(
      {
        type: "frame",
        frame: buf,
        simTimeS: s.simTimeS,
        timeOfDayMin: s.timeOfDayMin,
        rtFactor,
        vehicleCount: s.vehicleCount(),
      },
      frameTransferList(buf),
    );
  }

  function maybeSendMetrics(s: Simulation): void {
    const interval = s.config.metrics.sampleIntervalS;
    if (s.simTimeS - lastMetricsSimTimeS < interval) return;
    const buf = freeMetrics.pop();
    if (!buf) return;
    s.writeMetrics(buf);
    lastMetricsSimTimeS = s.simTimeS;
    post({ type: "metrics", frame: buf }, metricsTransferList(buf));
  }

  function maybeSendReport(s: Simulation): void {
    const windowS = s.config.metrics.windowS;
    if (s.simTimeS - lastReportSimTimeS < windowS) return;
    post({ type: "report", report: s.report() });
    lastReportSimTimeS = s.simTimeS;
  }

  function onMessage(msg: MainToWorker): void {
    if (state === "disposed") return;
    switch (msg.type) {
      case "init":
        handleInit(msg);
        return;
      case "play":
        handlePlay(msg);
        return;
      case "pause":
        handlePause();
        return;
      case "runUntil":
        handleRunUntil(msg);
        return;
      case "setParams":
        handleSetParams(msg);
        return;
      case "returnFrame":
        freeFrames.push(msg.frame);
        return;
      case "returnMetrics":
        freeMetrics.push(msg.frame);
        return;
      case "requestReport":
        handleRequestReport();
        return;
      case "dispose":
        handleDispose();
        return;
    }
  }

  return { onMessage };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

const RUNTIME_SAFE_PARAM_PATH_SET = new Set(RUNTIME_SAFE_PARAM_PATHS);

function collectPatchPaths(patch: unknown, prefix: string): string[] {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return [prefix];
  }
  const paths: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    paths.push(...collectPatchPaths(value, prefix ? `${prefix}.${key}` : key));
  }
  return paths;
}

/** True if every leaf the patch touches is listed in RUNTIME_SAFE_PARAM_PATHS. */
export function isRuntimeSafePatch(patch: SimConfigPatch): boolean {
  return collectPatchPaths(patch, "").every((path) => RUNTIME_SAFE_PARAM_PATH_SET.has(path));
}
