import { allocateFrameBuffers, defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { straightRoad } from "../../sim-core/test/fixtures/builders.ts";
import { createStubSimulation } from "../src/stub-simulation.ts";

describe("createStubSimulation", () => {
  it("fills a frame with vehicleCount() vehicles and advances simTimeS with step()", () => {
    const sim = createStubSimulation({ network: straightRoad(), config: defaultSimConfig() });
    const frame = allocateFrameBuffers(sim.vehicleCount(), 0, 0);

    sim.writeFrame(frame);
    expect(frame.count).toBe(sim.vehicleCount());
    expect(frame.simTimeS).toBe(0);

    for (let i = 0; i < 10; i++) sim.step();
    sim.writeFrame(frame);
    expect(frame.simTimeS).toBeCloseTo(10 * defaultSimConfig().dtS, 6);
  });

  it("moves vehicles deterministically: same simTimeS -> same positions regardless of path taken", () => {
    const network = straightRoad();
    const config = defaultSimConfig();

    // runUntil steps until simTimeS >= target, so it may overshoot 10 slightly (float dtS
    // accumulation); derive the matching step count from its actual landing time instead of
    // assuming both paths land on exactly the same simTimeS.
    const viaRunUntil = createStubSimulation({ network, config });
    viaRunUntil.runUntil(10);
    const frameB = allocateFrameBuffers(viaRunUntil.vehicleCount(), 0, 0);
    viaRunUntil.writeFrame(frameB);

    const viaSteps = createStubSimulation({ network, config });
    const stepsToMatch = Math.round(frameB.simTimeS / config.dtS);
    for (let i = 0; i < stepsToMatch; i++) viaSteps.step();
    const frameA = allocateFrameBuffers(viaSteps.vehicleCount(), 0, 0);
    viaSteps.writeFrame(frameA);

    expect(frameA.simTimeS).toBeCloseTo(frameB.simTimeS, 9);
    for (const i of [0, 10, 250, 499]) {
      expect(frameA.x[i] ?? Number.NaN).toBeCloseTo(frameB.x[i] ?? Number.NaN, 5);
      expect(frameA.y[i] ?? Number.NaN).toBeCloseTo(frameB.y[i] ?? Number.NaN, 5);
    }
  });

  it("moves each vehicle over time (not frozen)", () => {
    const sim = createStubSimulation({ network: straightRoad(), config: defaultSimConfig() });
    const before = allocateFrameBuffers(sim.vehicleCount(), 0, 0);
    sim.writeFrame(before);

    sim.runUntil(5);
    const after = allocateFrameBuffers(sim.vehicleCount(), 0, 0);
    sim.writeFrame(after);

    expect(before.x[0] ?? Number.NaN).not.toBeCloseTo(after.x[0] ?? Number.NaN, 3);
  });

  it("clamps written vehicles to the buffer's capacity", () => {
    const sim = createStubSimulation({ network: straightRoad(), config: defaultSimConfig() });
    const small = allocateFrameBuffers(10, 0, 0);
    sim.writeFrame(small);
    expect(small.count).toBe(10);
  });

  it("has no signal groups or crosswalks and an empty report", () => {
    const sim = createStubSimulation({ network: straightRoad(), config: defaultSimConfig() });
    expect(sim.segments()).toEqual([]);
    expect(sim.signalGroupIds()).toEqual([]);
    expect(sim.crosswalkIds()).toEqual([]);
    expect(sim.report().items).toEqual([]);
  });
});
