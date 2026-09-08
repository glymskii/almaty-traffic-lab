/// <reference lib="webworker" />
import type { MainToWorker } from "@atl/contracts";
import { createWorkerMain, type WorkerMainOptions } from "./worker-main.ts";

/**
 * Wires `createWorkerMain` to the real `self` of a DedicatedWorkerGlobalScope. Shared by
 * worker.ts (real kernel) and worker-stub.ts (StubSimulation) so each entry file stays a single
 * static `new Worker(new URL(...))` target for Vite (see create-worker.ts) without duplicating
 * the postMessage/onmessage plumbing.
 */
export function bootstrapWorker(createSimulation?: WorkerMainOptions["createSimulation"]): void {
  const ctx = self as unknown as DedicatedWorkerGlobalScope;
  const post: WorkerMainOptions["post"] = (msg, transfer) => ctx.postMessage(msg, transfer ?? []);
  const main = createWorkerMain(createSimulation ? { post, createSimulation } : { post });
  ctx.onmessage = (ev: MessageEvent<MainToWorker>) => main.onMessage(ev.data);
}
