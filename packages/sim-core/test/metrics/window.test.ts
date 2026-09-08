/**
 * T-18: the sliding window itself -- time averages on a run with a known speed, cause shares that
 * add up, and the per-sample cost at 20 000 vehicles.
 */
import { CAUSE_COUNT, defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { MetricsAccumulators } from "../../src/metrics/accumulators.ts";
import { RootCauseResolver } from "../../src/metrics/rootCause.ts";
import { SegmentIndex } from "../../src/metrics/segments.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier, straightRoad } from "../fixtures/builders.ts";

const SPEED_LIMIT_KPH = 60;
const FREE_SPEED_MPS = SPEED_LIMIT_KPH / 3.6;
const TRIPS_PER_HOUR = 600;
/** Identical drivers: the free-flow speed of the run is then exactly the speed limit. */
const IDENTICAL_DRIVERS = { desiredSpeedFactor: { mean: 1, sd: 0, min: 1, max: 1 } };

describe("metrics window", () => {
  it("averages a known free-flow speed over the window and keeps flow = density x speed", () => {
    const sim = createSimulation({
      network: straightRoad({ lengthM: 2000, lanes: 1, speedLimitKph: SPEED_LIMIT_KPH }),
      config: defaultSimConfig({
        driver: IDENTICAL_DRIVERS,
        demand: { tripsPerHourPeak: TRIPS_PER_HOUR, warmupMinutes: 0 },
      }),
    });
    sim.runUntil(900); // 300 s window, filled three times over
    const m = sim.writeMetrics();

    // Past the entry stretch, where vehicles are still accelerating up to the limit, every segment
    // ran at the speed limit over the whole window.
    for (let i = 10; i <= 70; i++) {
      expect(m.density[i] as number).toBeGreaterThan(0);
      expect(m.speedRatio[i] as number).toBeGreaterThan(0.93);
    }

    // Flow is the injected demand (Poisson arrivals: ~50 per window, so the count is noisy), and
    // the three windowed aggregates obey q = k * v.
    const middle = 40; // a segment in the middle of the 80-segment road
    const flow = m.flow[middle] as number;
    const density = m.density[middle] as number;
    const speedKph = (m.speedRatio[middle] as number) * FREE_SPEED_MPS * 3.6;
    expect(flow).toBeGreaterThan(TRIPS_PER_HOUR * 0.75);
    expect(flow).toBeLessThan(TRIPS_PER_HOUR * 1.25);
    expect(density * speedKph).toBeGreaterThan(flow * 0.8);
    expect(density * speedKph).toBeLessThan(flow * 1.2);
    // Well under a lane's capacity, and nothing standing anywhere.
    expect(m.vcRatio[middle] as number).toBeCloseTo(flow / 1800, 6);
    expect(m.queueM.every((v) => v === 0)).toBe(true);
  });

  it("forgets samples older than the window", () => {
    const sim = createSimulation({
      network: straightRoad({ lengthM: 1000, lanes: 1, speedLimitKph: SPEED_LIMIT_KPH }),
      config: defaultSimConfig({
        driver: IDENTICAL_DRIVERS,
        demand: { tripsPerHourPeak: TRIPS_PER_HOUR, warmupMinutes: 0 },
        metrics: { windowS: 60 },
      }),
    });
    sim.runUntil(300);
    const busyFlow = Math.max(...sim.writeMetrics().flow);
    expect(busyFlow).toBeGreaterThan(TRIPS_PER_HOUR * 0.7);

    // Close the tap: after more than a window's worth of empty road the aggregates fall back to 0.
    sim.setParams({ demand: { multiplier: 0 } });
    sim.runUntil(500);
    expect(sim.vehicleCount()).toBe(0);
    const empty = sim.writeMetrics();
    expect(Math.max(...empty.flow)).toBe(0);
    expect(Math.max(...empty.density)).toBe(0);
    expect(Math.max(...empty.speedRatio)).toBe(0);
    expect(Math.max(...empty.causeShare)).toBe(0);
    expect(Math.max(...empty.delayVehS)).toBe(0);
  });

  it("keeps every causeShare row at 1 or 0 and person delay above vehicle delay", () => {
    const network = crossroads({ lanes: 1 });
    const sim = createSimulation({
      network,
      config: defaultSimConfig({
        demand: {
          multiplier: saturationMultiplier(network) * 1.3,
          vehicleBudget: 2000,
          warmupMinutes: 0,
        },
      }),
    });
    sim.runUntil(600);
    const m = sim.writeMetrics();
    let withDelay = 0;
    for (let i = 0; i < m.segmentCount; i++) {
      let sum = 0;
      for (let c = 0; c < CAUSE_COUNT; c++) {
        const share = m.causeShare[i * CAUSE_COUNT + c] as number;
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(1);
        sum += share;
      }
      if ((m.delayVehS[i] as number) > 0) {
        expect(sum).toBeCloseTo(1, 6);
        withDelay++;
      } else {
        expect(sum).toBe(0);
      }
    }
    expect(withDelay).toBeGreaterThan(10);
    // Cars carry 1.5 people by default, so person-delay is a scaled-up copy of vehicle delay.
    let delayVehS = 0;
    let delayPersonS = 0;
    for (let i = 0; i < m.segmentCount; i++) {
      delayVehS += m.delayVehS[i] as number;
      delayPersonS += m.delayPersonS[i] as number;
    }
    expect(delayPersonS).toBeGreaterThan(delayVehS);
  });

  it("samples 20 000 vehicles in under 2 ms", { timeout: 120_000 }, () => {
    // A short, very wide road fills the vehicle budget in a few hundred steps, which is what makes
    // a 20 000-vehicle acceptance test affordable at all.
    const network = straightRoad({ lengthM: 2000, lanes: 400 });
    const sim = createSimulation({
      network,
      config: defaultSimConfig({
        demand: { tripsPerHourPeak: 2_000_000, warmupMinutes: 0, vehicleBudget: 22000 },
      }),
    });
    while (sim.vehicleCount() < 20000 && sim.simTimeS < 600) sim.step();
    expect(sim.vehicleCount()).toBeGreaterThanOrEqual(20000);

    const { runtime, pool } = kernelOf(sim);
    const segments = new SegmentIndex(network, runtime, 1800);
    const roots = new RootCauseResolver(runtime, pool.capacity);
    const acc = new MetricsAccumulators(runtime, segments, pool.capacity, 300);
    const occupancy = Float64Array.from([1.5, 40, 40, 1.8]);
    const cfg = sim.config.metrics;
    // Warm the code paths, then measure the sample the simulation really takes every second.
    for (let k = 0; k < 5; k++) {
      roots.resolve(pool, cfg.stoppedSpeedMps);
      acc.sample(pool, sim.simTimeS + k, 1, occupancy, cfg);
    }
    const samples = 40;
    const t0 = performance.now();
    for (let k = 0; k < samples; k++) {
      roots.resolve(pool, cfg.stoppedSpeedMps);
      acc.sample(pool, sim.simTimeS + 10 + k, 1, occupancy, cfg);
    }
    const perSampleMs = (performance.now() - t0) / samples;
    expect(perSampleMs).toBeLessThan(2);
  });
});
