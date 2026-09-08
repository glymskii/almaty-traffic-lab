import {
  allocateFrameBuffers,
  allocateMetricsFrame,
  causeCode,
  defaultSimConfig,
  type SimConfigPatch,
  VEHICLE_CLASS_CODE,
  VehicleFlag,
} from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { straightRoad } from "../fixtures/builders.ts";
import { bentRoad, twoLinkRoad } from "./networks.ts";

function sim(network = straightRoad(), patch: SimConfigPatch = {}) {
  return createSimulation({ network, config: defaultSimConfig(patch) });
}

/** Smallest bumper-to-bumper gap and smallest (gap - s0 of the follower) over every track list. */
function minGaps(s: ReturnType<typeof createSimulation>): { gap: number; gapMinusS0: number } {
  const { pool, runtime } = kernelOf(s);
  let gap = Number.POSITIVE_INFINITY;
  let gapMinusS0 = Number.POSITIVE_INFINITY;
  for (let t = 0; t < runtime.trackCount; t++) {
    let i = pool.trackTail[t] as number;
    while (i >= 0) {
      const j = pool.ahead[i] as number;
      if (j >= 0) {
        const g = (pool.s[j] as number) - (pool.length[j] as number) - (pool.s[i] as number);
        gap = Math.min(gap, g);
        gapMinusS0 = Math.min(gapMinusS0, g - (pool.minGap[i] as number));
        expect(pool.s[j] as number).toBeGreaterThanOrEqual(pool.s[i] as number);
      }
      i = j;
    }
  }
  return { gap, gapMinusS0 };
}

describe("createSimulation on a straight road", () => {
  it("spawns at gates, drives vehicles out at the other gate and keeps trip counters consistent", () => {
    const s = sim(straightRoad(), { demand: { tripsPerHourPeak: 600, warmupMinutes: 3 } });
    expect(s.vehicleCount()).toBe(0);
    s.runUntil(13 * 60);
    expect(Math.abs(s.simTimeS - 780)).toBeLessThan(1e-6);
    const st = s.tripStats();
    expect(st.simTimeS).toBe(s.simTimeS);
    expect(st.total.spawned).toBeGreaterThan(60);
    expect(st.total.completed).toBeGreaterThan(50);
    // Everything alive at minute 13 was spawned after the 3-minute warm-up (a trip takes ~1 minute).
    expect(st.total.spawned).toBe(st.total.completed + st.total.active);
    expect(st.total.active).toBe(s.vehicleCount());
    // Poisson arrivals occasionally cluster at the entry; waits stay rare at this demand.
    expect(st.spawnWaits).toBeLessThan(st.total.spawned * 0.05);
    expect(st.total.meanTripTimeS).toBeGreaterThan(50);
    expect(st.total.meanTripTimeS).toBeLessThan(75);
    expect(st.total.meanTripDelayS).toBeGreaterThanOrEqual(0);
    expect(st.total.meanStops).toBe(0);
    expect(st.byClass.car.spawned + st.byClass.taxi.spawned).toBe(st.total.spawned);
    expect(st.byClass.bus.spawned).toBe(0);
    expect(st.byClass.taxi.spawned).toBeGreaterThan(0);
  });

  it("estimates demand automatically as 0.7 x entry-lane capacity", () => {
    const auto = kernelOf(sim(straightRoad({ lanes: 3 })));
    expect(auto.baseTripsPerHour).toBeCloseTo(0.7 * 3 * 1800, 6);
    const explicit = kernelOf(sim(straightRoad(), { demand: { tripsPerHourPeak: 123 } }));
    expect(explicit.baseTripsPerHour).toBe(123);
  });

  it("writes frames with stable ids, positions on the lanes and plausible codes", () => {
    const s = sim(straightRoad({ lanes: 2 }), { demand: { tripsPerHourPeak: 1200 } });
    s.runUntil(120);
    const frame = allocateFrameBuffers(100, 0, 0);
    s.writeFrame(frame);
    expect(frame.count).toBe(s.vehicleCount());
    expect(frame.count).toBeGreaterThan(5);
    expect(frame.simTimeS).toBe(s.simTimeS);
    const ids = new Set<number>();
    const seen = new Map<number, number>();
    for (let k = 0; k < frame.count; k++) {
      const id = frame.id[k] as number;
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      seen.set(id, frame.x[k] as number);
      expect(frame.x[k]).toBeGreaterThanOrEqual(0);
      expect(frame.x[k]).toBeLessThanOrEqual(1000);
      expect(Math.abs(Math.abs(frame.y[k] as number) - 1.75)).toBeLessThan(1e-4);
      expect(frame.heading[k]).toBeCloseTo(0, 6);
      expect(frame.speed[k]).toBeGreaterThanOrEqual(0);
      expect([VEHICLE_CLASS_CODE.car, VEHICLE_CLASS_CODE.taxi]).toContain(frame.cls[k]);
      expect([causeCode("free_flow"), causeCode("speed_limit"), causeCode("leader")]).toContain(
        frame.cause[k],
      );
      expect((frame.flags[k] as number) & VehicleFlag.IN_INTERSECTION).toBe(0);
    }
    s.runUntil(125);
    s.writeFrame(frame);
    let matched = 0;
    for (let k = 0; k < frame.count; k++) {
      const before = seen.get(frame.id[k] as number);
      if (before === undefined) continue;
      matched++;
      expect(frame.x[k]).toBeGreaterThan(before);
    }
    expect(matched).toBeGreaterThan(0);
    // A smaller buffer is filled up to its capacity.
    const small = allocateFrameBuffers(3, 0, 0);
    s.writeFrame(small);
    expect(small.count).toBe(3);
  });

  it("never lets a follower come closer than its jam distance, at low and at saturated demand", () => {
    for (const rate of [900, 4000]) {
      const s = sim(straightRoad(), { demand: { tripsPerHourPeak: rate } });
      let worst = Number.POSITIVE_INFINITY;
      while (s.simTimeS < 600) {
        s.step();
        const g = minGaps(s);
        worst = Math.min(worst, g.gapMinusS0);
      }
      expect(worst).toBeGreaterThan(0);
      expect(s.vehicleCount()).toBeGreaterThan(0);
    }
  });

  it("reports vehicles cruising at their desired speed as speed_limit and queued ones as leader", () => {
    const s = sim(straightRoad({ lanes: 1 }), { demand: { tripsPerHourPeak: 3000 } });
    s.runUntil(300);
    const frame = allocateFrameBuffers(1000, 0, 0);
    s.writeFrame(frame);
    const counts = new Map<number, number>();
    for (let k = 0; k < frame.count; k++) {
      const c = frame.cause[k] as number;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(counts.get(causeCode("speed_limit")) ?? 0).toBeGreaterThan(0);
    expect(counts.get(causeCode("leader")) ?? 0).toBeGreaterThan(0);
  });

  it("counts spawn waits when the entry lane is occupied and respects the vehicle budget", () => {
    const saturated = sim(straightRoad({ lanes: 1 }), {
      demand: { tripsPerHourPeak: 4000, warmupMinutes: 0 },
    });
    saturated.runUntil(300);
    expect(saturated.tripStats().spawnWaits).toBeGreaterThan(0);

    const capped = sim(straightRoad(), { demand: { tripsPerHourPeak: 3000, vehicleBudget: 7 } });
    let maxActive = 0;
    while (capped.simTimeS < 300) {
      capped.step();
      maxActive = Math.max(maxActive, capped.vehicleCount());
    }
    expect(maxActive).toBe(7);
  });

  it("keeps the clock in minutes of day and wraps at midnight", () => {
    const s = sim(straightRoad(), { startTimeMin: 1439 });
    expect(s.timeOfDayMin).toBe(1439);
    s.runUntil(120);
    expect(s.timeOfDayMin).toBeCloseTo(1, 9);
    expect(s.simTimeS).toBeCloseTo(120, 9);
    expect(s.scenarioId).toBe("baseline");
    expect(s.config.dtS).toBe(0.1);
  });

  it("returns honest stubs for metrics, report, signals and crosswalks", () => {
    const s = sim(straightRoad(), { demand: { tripsPerHourPeak: 600, warmupMinutes: 0 } });
    s.runUntil(200);
    expect(s.segments()).toHaveLength(80);
    expect(s.signalGroupIds()).toEqual([]);
    expect(s.crosswalkIds()).toEqual([]);
    const m = s.writeMetrics();
    expect(m.segmentCount).toBe(80);
    expect(m.windowS).toBe(300);
    expect(m.simTimeS).toBe(s.simTimeS);
    expect(m.speedRatio.every((v) => v === 0)).toBe(true);
    const own = allocateMetricsFrame(80, 300);
    own.flow[3] = 42;
    expect(s.writeMetrics(own)).toBe(own);
    expect(own.flow[3]).toBe(0);
    const r = s.report();
    expect(r.items).toEqual([]);
    expect(r.totals.vehiclesActive).toBe(s.vehicleCount());
    expect(r.totals.vehiclesCompleted).toBe(s.tripStats().total.completed);
    expect(r.totals.meanSpeedKph).toBeGreaterThan(30);
    expect(r.totals.stoppedShare).toBe(0);
    expect(r.totals.busMeanSpeedKph).toBe(0);
    expect(r.windowS).toBe(300);
  });

  it("produces a 16-hex trajectory hash that evolves with every step", () => {
    const s = sim(straightRoad(), { demand: { tripsPerHourPeak: 1200 } });
    s.runUntil(30);
    const h1 = s.trajectoryHash();
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    s.step();
    expect(s.trajectoryHash()).not.toBe(h1);
  });

  it("applies runtime-safe parameters immediately and rejects the rest without side effects", () => {
    const s = sim(straightRoad(), { demand: { tripsPerHourPeak: 1200, warmupMinutes: 0 } });
    s.runUntil(120);
    const before = s.tripStats().total.spawned;
    s.setParams({ demand: { multiplier: 0 } });
    expect(s.config.demand.multiplier).toBe(0);
    s.runUntil(240);
    expect(s.tripStats().total.spawned).toBe(before);
    s.setParams({ demand: { multiplier: 1 } });
    s.runUntil(360);
    expect(s.tripStats().total.spawned).toBeGreaterThan(before);

    const snapshot = JSON.stringify(s.config);
    expect(() => s.setParams({ dtS: 0.2 })).toThrow(/not runtime-safe/);
    expect(() => s.setParams({ demand: { vehicleBudget: 5 } })).toThrow(/demand\.vehicleBudget/);
    expect(() => s.setParams({ demand: { multiplier: 2, taxiShare: 0 } })).toThrow(/taxiShare/);
    expect(() => s.setParams({})).not.toThrow();
    expect(JSON.stringify(s.config)).toBe(snapshot);
  });
});

describe("track transitions", () => {
  it("drives vehicles through a connector onto the next link and out of the far gate", () => {
    // Identical drivers: on a single lane a slow driver would otherwise hold a platoon behind it.
    const s = sim(twoLinkRoad(), {
      demand: { tripsPerHourPeak: 600, warmupMinutes: 1, taxiShare: 0 },
      driver: { desiredSpeedFactor: { mean: 1, sd: 0, min: 0.7, max: 1.3 } },
    });
    const frame = allocateFrameBuffers(200, 0, 0);
    let sawConnector = 0;
    let sawSecondLink = 0;
    const lastX = new Map<number, number>();
    while (s.simTimeS < 6 * 60) {
      s.step();
      s.writeFrame(frame);
      for (let k = 0; k < frame.count; k++) {
        const id = frame.id[k] as number;
        const x = frame.x[k] as number;
        const prev = lastX.get(id);
        if (prev !== undefined) expect(x).toBeGreaterThanOrEqual(prev);
        lastX.set(id, x);
        expect(Math.abs(frame.y[k] as number)).toBeLessThan(1e-6);
        const inIntersection = ((frame.flags[k] as number) & VehicleFlag.IN_INTERSECTION) !== 0;
        if (x > 500 && x < 510) {
          expect(inIntersection).toBe(true);
          sawConnector++;
        } else {
          expect(inIntersection).toBe(false);
        }
        if (x > 510) sawSecondLink++;
      }
    }
    expect(sawConnector).toBeGreaterThan(0);
    expect(sawSecondLink).toBeGreaterThan(0);
    const st = s.tripStats();
    expect(st.total.completed).toBeGreaterThan(20);
    // 500 m at 60 km/h + 10 m + 500 m at 40 km/h ~ 30 + 1 + 45 s. The few seconds of delay come from
    // followers matching the slower leader on the 40 km/h link before they reach it.
    expect(st.total.meanTripTimeS).toBeGreaterThan(72);
    expect(st.total.meanTripTimeS).toBeLessThan(85);
    expect(st.total.meanTripDelayS).toBeLessThan(8);
  });

  it("removes cars at the end of a lane whose only connector leads to a bus-only lane", () => {
    const s = sim(twoLinkRoad({ busOnlySecondLink: true }), {
      demand: { tripsPerHourPeak: 600, warmupMinutes: 1 },
    });
    const frame = allocateFrameBuffers(200, 0, 0);
    let maxX = 0;
    while (s.simTimeS < 5 * 60) {
      s.step();
      s.writeFrame(frame);
      for (let k = 0; k < frame.count; k++) maxX = Math.max(maxX, frame.x[k] as number);
    }
    expect(maxX).toBeLessThanOrEqual(500);
    const st = s.tripStats();
    expect(st.total.completed).toBeGreaterThan(10);
    expect(st.total.meanTripTimeS).toBeGreaterThan(25);
    expect(st.total.meanTripTimeS).toBeLessThan(35);
  });

  it("follows a bent polyline with lane offsets and headings", () => {
    const s = sim(bentRoad(), { demand: { tripsPerHourPeak: 900, warmupMinutes: 0 } });
    s.runUntil(150);
    const frame = allocateFrameBuffers(200, 0, 0);
    s.writeFrame(frame);
    let east = 0;
    let north = 0;
    for (let k = 0; k < frame.count; k++) {
      const x = frame.x[k] as number;
      const y = frame.y[k] as number;
      if (y < -1) {
        // still on the eastbound leg: y is the lane offset, heading east
        expect(Math.abs(Math.abs(y) - 1.75)).toBeLessThan(1e-4);
        expect(frame.heading[k]).toBeCloseTo(0, 6);
        east++;
      } else if (y > 5) {
        // northbound leg: x is 500 +- lane offset, heading north
        expect(Math.abs(Math.abs(x - 500) - 1.75)).toBeLessThan(1e-4);
        expect(frame.heading[k]).toBeCloseTo(Math.PI / 2, 6);
        north++;
      }
    }
    expect(east).toBeGreaterThan(0);
    expect(north).toBeGreaterThan(0);
  });
});

describe("performance", () => {
  it("steps 5000 vehicles well under 5 ms", () => {
    // A 5 km road cannot hold 5000 moving vehicles; use 20 lanes x 10 km near capacity instead.
    const s = sim(straightRoad({ lengthM: 10000, lanes: 20 }), {
      demand: { tripsPerHourPeak: 36000, warmupMinutes: 0, vehicleBudget: 8000 },
    });
    while (s.vehicleCount() < 5000 && s.simTimeS < 1200) s.step();
    expect(s.vehicleCount()).toBeGreaterThanOrEqual(5000);
    const steps = 100;
    const t0 = performance.now();
    for (let k = 0; k < steps; k++) s.step();
    const perStepMs = (performance.now() - t0) / steps;
    expect(perStepMs).toBeLessThan(5);
  });
});
