import type { MainToWorker, WorkerToMain } from "@atl/contracts";
import { createWorkerMain, type WorkerMainOptions } from "../src/worker-main.ts";

type SimFactory = WorkerMainOptions["createSimulation"];

/**
 * Worker-shaped double wired to a real `worker-main` over a real MessageChannel, so protocol
 * tests exercise actual structured-clone transfer (buffer detachment) instead of direct calls.
 * Only the subset of `Worker` that client.ts uses is implemented; `createFakeWorker` casts it.
 */
class FakeWorker {
  onmessage: ((ev: MessageEvent<WorkerToMain>) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private readonly mainPort: MessagePort;
  private readonly workerPort: MessagePort;
  private terminated = false;

  constructor(createSimulation?: SimFactory) {
    const channel = new MessageChannel();
    this.mainPort = channel.port1;
    this.workerPort = channel.port2;

    const main = createWorkerMain(
      createSimulation
        ? { post: (msg, transfer) => this.postFromWorker(msg, transfer), createSimulation }
        : { post: (msg, transfer) => this.postFromWorker(msg, transfer) },
    );

    this.workerPort.onmessage = (ev: MessageEvent<MainToWorker>) => main.onMessage(ev.data);
    this.mainPort.onmessage = (ev: MessageEvent<WorkerToMain>) => {
      if (this.terminated) return;
      this.onmessage?.(ev);
    };
  }

  private postFromWorker(msg: WorkerToMain, transfer: ArrayBuffer[] = []): void {
    if (this.terminated) return;
    this.workerPort.postMessage(msg, transfer);
  }

  postMessage(msg: MainToWorker, transfer: ArrayBuffer[] = []): void {
    if (this.terminated) return;
    this.mainPort.postMessage(msg, transfer);
  }

  terminate(): void {
    this.terminated = true;
    this.mainPort.close();
    this.workerPort.close();
  }
}

/** Returns a Worker-compatible double; only the members client.ts uses are implemented. */
export function createFakeWorker(createSimulation?: SimFactory): Worker {
  return new FakeWorker(createSimulation) as unknown as Worker;
}

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await wait(5);
  }
}
