/**
 * Nuance tests N01-N04: longitudinal movement and determinism. Fixture: straightRoad. Closed by T-04.
 * Full specification of each test: docs/NUANCES.md
 */
import { allocateFrameBuffers, defaultSimConfig, type SimConfigPatch } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation } from "../../src/simulation.ts";
import { straightRoad } from "../fixtures/builders.ts";

const WARMUP_MIN = 3;
const RUN_MIN = 10;

function run(network: ReturnType<typeof straightRoad>, patch: SimConfigPatch) {
  const config = defaultSimConfig({
    seed: 1,
    ...patch,
    demand: { warmupMinutes: WARMUP_MIN, ...patch.demand },
  });
  const sim = createSimulation({ network, config });
  sim.runUntil((WARMUP_MIN + RUN_MIN) * 60);
  return sim;
}

/** Mean trip speed of completed trips, m/s (spawn is one car length into the link). */
function meanTripSpeed(sim: ReturnType<typeof createSimulation>, lengthM: number): number {
  const st = sim.tripStats();
  expect(st.total.completed).toBeGreaterThan(20);
  return (lengthM - sim.config.vehicleClasses.car.lengthM) / st.total.meanTripTimeS;
}

/** Instantaneous speeds sampled from frames every 10 s after warm-up, away from the entry. */
function sampledSpeeds(network: ReturnType<typeof straightRoad>, patch: SimConfigPatch): number[] {
  const config = defaultSimConfig({
    seed: 1,
    ...patch,
    demand: { warmupMinutes: WARMUP_MIN, ...patch.demand },
  });
  const sim = createSimulation({ network, config });
  sim.runUntil(WARMUP_MIN * 60);
  const frame = allocateFrameBuffers(config.demand.vehicleBudget, 0, 0);
  const speeds: number[] = [];
  const end = (WARMUP_MIN + RUN_MIN) * 60;
  while (sim.simTimeS < end) {
    sim.runUntil(sim.simTimeS + 10);
    sim.writeFrame(frame);
    for (let k = 0; k < frame.count; k++) {
      const x = frame.x[k] as number;
      if (x > 100 && x < 900) speeds.push(frame.speed[k] as number);
    }
  }
  expect(speeds.length).toBeGreaterThan(50);
  return speeds.sort((a, b) => a - b);
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

describe("N01 speed limit", () => {
  it("free-flow mean speed tracks the limit: 60 km/h road ~ 60 * mean(desiredSpeedFactor), 40 km/h road ~ 40 (±5%)", () => {
    for (const limitKph of [60, 40]) {
      const sim = run(straightRoad({ speedLimitKph: limitKph }), {
        demand: { tripsPerHourPeak: 300 },
      });
      const expected = (limitKph / 3.6) * sim.config.driver.desiredSpeedFactor.mean;
      const speed = meanTripSpeed(sim, 1000);
      expect(speed / expected).toBeGreaterThan(0.95);
      expect(speed / expected).toBeLessThan(1.05);
    }
  });
});

describe("N02 lane count", () => {
  it.todo("at saturation demand a 3-lane road passes ~1.5x the flow of a 2-lane road (±15%)");
});

describe("N03 driver heterogeneity", () => {
  it("with sd > 0 free-flow speeds spread (p90/p10 > 1.15); with sd = 0 all vehicles drive the same speed", () => {
    // Low demand so that most vehicles drive freely; no taxis (their class factor would add spread).
    const demand = { tripsPerHourPeak: 120, taxiShare: 0 };
    const spread = sampledSpeeds(straightRoad(), {
      demand,
      driver: { desiredSpeedFactor: { mean: 1, sd: 0.1, min: 0.7, max: 1.3 } },
    });
    expect(quantile(spread, 0.9) / quantile(spread, 0.1)).toBeGreaterThan(1.15);

    const uniform = sampledSpeeds(straightRoad(), {
      demand,
      driver: { desiredSpeedFactor: { mean: 1, sd: 0, min: 0.7, max: 1.3 } },
    });
    expect(quantile(uniform, 0.9) / quantile(uniform, 0.1)).toBeLessThan(1.01);
  });
});

describe("N04 determinism", () => {
  const demand = { tripsPerHourPeak: 1200 };

  it("same seed + network + config => identical trajectoryHash after 10 sim-minutes", () => {
    const a = run(straightRoad(), { seed: 7, demand });
    const b = run(straightRoad(), { seed: 7, demand });
    expect(a.trajectoryHash()).toBe(b.trajectoryHash());
    expect(a.tripStats()).toEqual(b.tripStats());
  });

  it("different seed => different trajectoryHash", () => {
    const a = run(straightRoad(), { seed: 7, demand });
    const b = run(straightRoad(), { seed: 8, demand });
    expect(a.trajectoryHash()).not.toBe(b.trajectoryHash());
  });
});
