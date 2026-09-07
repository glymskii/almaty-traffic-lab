/// <reference lib="webworker" />
import type { MainToWorker, WorkerToMain } from "@atl/contracts";

/**
 * Worker entry point. One instance = one simulation. Implemented in T-06:
 *  - init: createSimulation, allocate frameBufferCount FrameBuffers, reply `ready`
 *  - play/pause/runUntil: drive sim.step() in a self-scheduled loop respecting speedFactor and frameRateHz
 *  - frames are sent only when a free buffer is available (ping-pong via returnFrame)
 *  - metrics every config.metrics.sampleIntervalS, report on requestReport and every windowS
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerToMain, transfer: ArrayBuffer[] = []): void {
  ctx.postMessage(msg, transfer);
}

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      post({
        type: "error",
        message: "sim-worker not implemented: see docs/tasks/T-06-worker-protocol.md",
        fatal: true,
      });
      break;
    default:
      post({ type: "error", message: `unexpected message before init: ${msg.type}`, fatal: false });
  }
};
