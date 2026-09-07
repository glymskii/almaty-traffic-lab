/// <reference lib="webworker" />
import type { MainToWorker } from "@atl/contracts";
import { createSimulation } from "@atl/sim-core";
import { createStubSimulation } from "./stub-simulation.ts";
import { createWorkerMain } from "./worker-main.ts";

/**
 * Worker entry point for the browser. One instance = one simulation.
 * `?sim=stub` on the worker's own script URL selects StubSimulation instead of the real kernel
 * (apps/web's debug view uses this until T-04/T-13 land); the default is the real @atl/sim-core.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

const useStub = new URLSearchParams(ctx.location.search).get("sim") === "stub";

const main = createWorkerMain({
  post: (msg, transfer) => ctx.postMessage(msg, transfer ?? []),
  createSimulation: useStub ? createStubSimulation : createSimulation,
});

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => main.onMessage(ev.data);
