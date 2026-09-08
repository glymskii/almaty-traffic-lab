import type { FrameBuffers, MetricsFrame, SimConfigPatch, WorkerToMain } from "@atl/contracts";
import { baselineScenario, defaultSimConfig, frameTransferList } from "@atl/contracts";
import type { CreateSimulationOptions, Simulation } from "@atl/sim-core";
import { describe, expect, it } from "vitest";
import { straightRoad } from "../../sim-core/test/fixtures/builders.ts";
import { createSimClient } from "../src/client.ts";
import { createStubSimulation } from "../src/stub-simulation.ts";
import { createFakeWorker, wait, waitUntil } from "./fake-worker.ts";

/**
 * End-to-end protocol tests: a real MessageChannel between client.ts and worker-main.ts
 * (see fake-worker.ts), driven with StubSimulation so they don't depend on T-04.
 */

function testSetup(configPatch?: SimConfigPatch) {
  const network = straightRoad();
  const config = defaultSimConfig(configPatch);
  const scenario = baselineScenario(network.meta.networkId);
  return { network, config, scenario };
}

function messagesOfType<T extends WorkerToMain["type"]>(
  messages: WorkerToMain[],
  type: T,
): Extract<WorkerToMain, { type: T }>[] {
  return messages.filter((m): m is Extract<WorkerToMain, { type: T }> => m.type === type);
}

/**
 * Wraps StubSimulation but makes step() throw after `n` calls, to exercise worker-main's
 * fatal-error handling when the kernel itself misbehaves mid-loop. Delegates everything else
 * (via getters for the live properties, since a plain object spread would freeze simTimeS at
 * construction time instead of tracking the wrapped simulation).
 */
function createStepFailsAfter(n: number): (opts: CreateSimulationOptions) => Simulation {
  return (opts) => {
    const inner = createStubSimulation(opts);
    let stepCount = 0;
    return {
      get network() {
        return inner.network;
      },
      get config() {
        return inner.config;
      },
      get scenarioId() {
        return inner.scenarioId;
      },
      get simTimeS() {
        return inner.simTimeS;
      },
      get timeOfDayMin() {
        return inner.timeOfDayMin;
      },
      step() {
        stepCount++;
        if (stepCount > n) throw new Error("boom: simulated kernel crash");
        inner.step();
      },
      runUntil: (targetSimTimeS: number) => inner.runUntil(targetSimTimeS),
      vehicleCount: () => inner.vehicleCount(),
      writeFrame: (frame: FrameBuffers) => inner.writeFrame(frame),
      segments: () => inner.segments(),
      signalGroupIds: () => inner.signalGroupIds(),
      crosswalkIds: () => inner.crosswalkIds(),
      writeMetrics: (frame?: MetricsFrame) => inner.writeMetrics(frame),
      report: () => inner.report(),
      setParams: (patch: SimConfigPatch) => inner.setParams(patch),
      trajectoryHash: () => inner.trajectoryHash(),
      tripStats: () => inner.tripStats(),
    };
  };
}

describe("sim-worker protocol", () => {
  it("init resolves with ready stats from the simulation", async () => {
    const worker = createFakeWorker(createStubSimulation);
    const client = createSimClient({ createWorker: () => worker });
    const { network, config, scenario } = testSetup();

    const stats = await client.init(network, config, scenario);

    expect(stats.vehicleCapacity).toBe(config.demand.vehicleBudget);
    expect(stats.signalGroupCount).toBe(0);
    expect(stats.crosswalkCount).toBe(0);
    expect(stats.segments).toEqual([]);
    expect(stats.signalGroupIds).toEqual([]);
    expect(stats.crosswalkIds).toEqual([]);

    client.dispose();
  });

  it("play emits multiple frames over wall time", async () => {
    const worker = createFakeWorker(createStubSimulation);
    const client = createSimClient({
      createWorker: () => worker,
      frameBufferCount: 3,
      frameRateHz: 20,
    });
    const { network, config, scenario } = testSetup({ dtS: 0.1 });
    await client.init(network, config, scenario);

    const frames: number[] = [];
    client.onFrame((ev) => frames.push(ev.frame.count));
    client.play(100);
    await wait(250);
    client.pause();

    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames[0]).toBeGreaterThan(0);

    client.dispose();
  });

  it("withholds a frame while no buffer is free", async () => {
    const worker = createFakeWorker(createStubSimulation);
    const received: WorkerToMain[] = [];
    worker.onmessage = (ev: MessageEvent<WorkerToMain>) => received.push(ev.data);
    const { network, config, scenario } = testSetup({ dtS: 0.1 });

    worker.postMessage({
      type: "init",
      network,
      config,
      scenario,
      frameBufferCount: 1,
      frameRateHz: 200,
    });
    await waitUntil(() => messagesOfType(received, "ready").length > 0);

    worker.postMessage({ type: "play", speedFactor: 500 });
    await waitUntil(() => messagesOfType(received, "frame").length > 0);
    await wait(120); // several more 200 Hz frame intervals; the one buffer is never returned

    expect(messagesOfType(received, "frame")).toHaveLength(1);

    worker.postMessage({ type: "dispose" });
  });

  it("returnFrame restores a usable (non-detached) buffer for the next frame", async () => {
    const worker = createFakeWorker(createStubSimulation);
    const received: WorkerToMain[] = [];
    worker.onmessage = (ev: MessageEvent<WorkerToMain>) => received.push(ev.data);
    const { network, config, scenario } = testSetup({ dtS: 0.1 });

    worker.postMessage({
      type: "init",
      network,
      config,
      scenario,
      frameBufferCount: 1,
      frameRateHz: 200,
    });
    await waitUntil(() => messagesOfType(received, "ready").length > 0);

    worker.postMessage({ type: "play", speedFactor: 500 });
    await waitUntil(() => messagesOfType(received, "frame").length > 0);

    const first = messagesOfType(received, "frame")[0];
    if (!first) throw new Error("expected a frame message");
    expect(first.frame.x.buffer.byteLength).toBeGreaterThan(0);
    expect(first.frame.count).toBeGreaterThan(0);
    const firstSimTimeS = first.frame.simTimeS;

    worker.postMessage({ type: "returnFrame", frame: first.frame }, frameTransferList(first.frame));

    await waitUntil(() => messagesOfType(received, "frame").length >= 2);
    const second = messagesOfType(received, "frame")[1];
    if (!second) throw new Error("expected a second frame message");
    expect(second.frame.x.buffer.byteLength).toBeGreaterThan(0);
    expect(second.frame.count).toBeGreaterThan(0);
    expect(second.frame.simTimeS).toBeGreaterThan(firstSimTimeS);

    worker.postMessage({ type: "dispose" });
  });

  it("rejects setParams touching a path outside RUNTIME_SAFE_PARAM_PATHS", async () => {
    const worker = createFakeWorker(createStubSimulation);
    const client = createSimClient({ createWorker: () => worker });
    const { network, config, scenario } = testSetup();
    await client.init(network, config, scenario);

    const errors: Array<{ message: string; fatal: boolean }> = [];
    client.onError((message, fatal) => errors.push({ message, fatal }));

    client.setParams({ demand: { vehicleBudget: 5 } });
    await waitUntil(() => errors.length > 0);
    expect(errors[0]?.fatal).toBe(false);

    client.setParams({ demand: { multiplier: 1.5 } });
    await wait(50);
    expect(errors).toHaveLength(1); // the safe patch did not produce a second error

    client.dispose();
  });

  it("runUntil resolves after reaching the target and reports progress along the way", async () => {
    const worker = createFakeWorker(createStubSimulation);
    const client = createSimClient({ createWorker: () => worker });
    const { network, config, scenario } = testSetup({ dtS: 0.1 });
    await client.init(network, config, scenario);

    const progressed: number[] = [];
    client.onProgress((simTimeS) => progressed.push(simTimeS));

    await client.runUntil(300);

    expect(progressed.length).toBeGreaterThanOrEqual(2);
    expect(progressed[progressed.length - 1]).toBeLessThanOrEqual(300);

    client.dispose();
  });

  it("allows dispose after a fatal error without throwing", async () => {
    // No createSimulation override: falls back to @atl/sim-core's not-yet-implemented factory,
    // which throws synchronously and is caught by worker-main as a fatal error.
    const worker = createFakeWorker();
    const client = createSimClient({ createWorker: () => worker });
    const { network, config, scenario } = testSetup();

    const errors: Array<{ message: string; fatal: boolean }> = [];
    client.onError((message, fatal) => errors.push({ message, fatal }));

    await expect(client.init(network, config, scenario)).rejects.toThrow();
    await waitUntil(() => errors.some((e) => e.fatal));

    expect(() => client.dispose()).not.toThrow();
  });

  it("reports a fatal error when the kernel throws mid-loop, and dispose stays safe", async () => {
    const worker = createFakeWorker(createStepFailsAfter(2));
    const client = createSimClient({ createWorker: () => worker });
    const { network, config, scenario } = testSetup({ dtS: 0.1 });
    await client.init(network, config, scenario);

    const errors: Array<{ message: string; fatal: boolean }> = [];
    client.onError((message, fatal) => errors.push({ message, fatal }));

    client.play(1000);
    await waitUntil(() => errors.some((e) => e.fatal));

    expect(() => client.dispose()).not.toThrow();
  });

  it("a throwing onFrame listener does not stop the frame stream or buffer return", async () => {
    const worker = createFakeWorker(createStubSimulation);
    const client = createSimClient({
      createWorker: () => worker,
      frameBufferCount: 2,
      frameRateHz: 30,
    });
    const { network, config, scenario } = testSetup({ dtS: 0.1 });
    await client.init(network, config, scenario);

    let goodFrames = 0;
    client.onFrame(() => {
      throw new Error("boom in onFrame");
    });
    client.onFrame(() => {
      goodFrames++;
    });

    const errors: Array<{ message: string; fatal: boolean }> = [];
    client.onError((message, fatal) => errors.push({ message, fatal }));

    client.play(100);
    await wait(200);
    client.pause();

    expect(goodFrames).toBeGreaterThanOrEqual(3);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => !e.fatal)).toBe(true);

    client.dispose();
  });
});
