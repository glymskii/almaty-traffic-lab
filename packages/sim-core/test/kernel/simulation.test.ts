import {
  allocateFrameBuffers,
  allocateMetricsFrame,
  CAUSE_COUNT,
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

const BLINKERS = VehicleFlag.BLINKER_LEFT | VehicleFlag.BLINKER_RIGHT;

function sim(network = straightRoad(), patch: SimConfigPatch = {}) {
  return createSimulation({ network, config: defaultSimConfig(patch) });
}

interface GapStats {
  /** Smallest bumper-to-bumper gap over every consecutive pair. */
  gap: number;
  /** Smallest (gap - s0 of the follower) over pairs on the same track. */
  gapMinusS0: number;
  /** Smallest (gap - s0 of the follower) over pairs across a track boundary. */
  crossGapMinusS0: number;
}

/**
 * Gap statistics over every pair of consecutive vehicles, including pairs across track boundaries
 * (head of a track vs the first vehicle on the tracks ahead, following `nextTrack` like the kernel).
 */
function minGaps(s: ReturnType<typeof createSimulation>): GapStats {
  const { pool, runtime } = kernelOf(s);
  const out: GapStats = {
    gap: Number.POSITIVE_INFINITY,
    gapMinusS0: Number.POSITIVE_INFINITY,
    crossGapMinusS0: Number.POSITIVE_INFINITY,
  };
  for (let t = 0; t < runtime.trackCount; t++) {
    let i = pool.trackTail[t] as number;
    while (i >= 0) {
      const j = pool.ahead[i] as number;
      if (j >= 0) {
        const g = (pool.s[j] as number) - (pool.length[j] as number) - (pool.s[i] as number);
        out.gap = Math.min(out.gap, g);
        out.gapMinusS0 = Math.min(out.gapMinusS0, g - (pool.minGap[i] as number));
        expect(pool.s[j] as number).toBeGreaterThanOrEqual(pool.s[i] as number);
      } else {
        let dist = (runtime.trackEndS[t] as number) - (pool.s[i] as number);
        let nt = pool.nextTrack[i] as number;
        for (let hop = 0; hop < 3 && nt >= 0; hop++) {
          const leader = pool.trackTail[nt] as number;
          if (leader >= 0) {
            const g =
              dist +
              (pool.s[leader] as number) -
              (runtime.trackStartS[nt] as number) -
              (pool.length[leader] as number);
            out.gap = Math.min(out.gap, g);
            out.crossGapMinusS0 = Math.min(out.crossGapMinusS0, g - (pool.minGap[i] as number));
            break;
          }
          dist += (runtime.trackEndS[nt] as number) - (runtime.trackStartS[nt] as number);
          nt = runtime.trackNextByClass[nt * 4 + (pool.cls[i] as number)] as number;
        }
      }
      i = j;
    }
  }
  return out;
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
      // Lane centres are +-1.75 m; a vehicle changing lanes (T-10) slides between them for 2 s
      // and then reports a blinker.
      const offset = Math.abs(frame.y[k] as number);
      const changing = ((frame.flags[k] as number) & BLINKERS) !== 0;
      expect(offset).toBeLessThanOrEqual(1.75 + 1e-4);
      if (!changing) expect(Math.abs(offset - 1.75)).toBeLessThan(1e-4);
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

  /** Spawns per entry lane over `seconds` of simulation (new ids are counted on the step they appear). */
  function spawnsPerLane(s: ReturnType<typeof createSimulation>, seconds: number): number[] {
    const { pool, runtime } = kernelOf(s);
    const perLane = new Array<number>(runtime.laneCount).fill(0);
    let maxId = 0;
    while (s.simTimeS < seconds) {
      s.step();
      let newMax = maxId;
      for (let i = 0; i < pool.highWater; i++) {
        const t = pool.track[i] as number;
        const id = pool.id[i] as number;
        if (t < 0 || id <= maxId) continue;
        perLane[t] = (perLane[t] ?? 0) + 1;
        if (id > newMax) newMax = id;
      }
      maxId = newMax;
    }
    return perLane;
  }

  it("prefers the rightmost entry lane when lanes are equally free and spreads out under load", () => {
    const first = sim(straightRoad({ lanes: 3 }), { demand: { tripsPerHourPeak: 300 } });
    while (first.vehicleCount() === 0) first.step();
    const frame = allocateFrameBuffers(10, 0, 0);
    first.writeFrame(frame);
    // Lane 2 is the rightmost of three (offset +3.5 m to the right = south of the eastbound axis).
    expect(frame.y[0]).toBeCloseTo(-3.5, 4);

    // The freest lane wins and ties go right, so no lane dominates at any demand (the old
    // "+Infinity beats +Infinity" tie-break sent most vehicles to the leftmost lane).
    for (const rate of [300, 3000]) {
      const perLane = spawnsPerLane(
        sim(straightRoad({ lanes: 3 }), { demand: { tripsPerHourPeak: rate } }),
        600,
      );
      const total = perLane.reduce((a, b) => a + b, 0);
      for (const n of perLane) {
        expect(n).toBeGreaterThan(total * 0.2);
        expect(n).toBeLessThan(total * 0.5);
      }
    }
  });

  it("keeps persistent flags across steps and rebuilds per-step flags", () => {
    const s = sim(straightRoad(), { demand: { tripsPerHourPeak: 1200 } });
    s.runUntil(60);
    const { pool } = kernelOf(s);
    let i = 0;
    while ((pool.track[i] as number) < 0) i++;
    pool.persistentFlags[i] = VehicleFlag.NAVIGATOR | VehicleFlag.BLINKER_LEFT;
    s.step();
    expect((pool.flags[i] as number) & VehicleFlag.NAVIGATOR).not.toBe(0);
    expect((pool.flags[i] as number) & VehicleFlag.BLINKER_LEFT).not.toBe(0);
    pool.persistentFlags[i] = 0;
    s.step();
    expect((pool.flags[i] as number) & (VehicleFlag.NAVIGATOR | VehicleFlag.BLINKER_LEFT)).toBe(0);
  });

  it("takes the hourly profile at the time the step produces, not the time it started", () => {
    const profile = new Array<number>(24).fill(0);
    profile[9] = 1;
    // 08:59:59.94: the first step ends at 09:00:00.04, when the profile switches on.
    const s = sim(straightRoad(), {
      startTimeMin: 540 - 0.001,
      demand: { tripsPerHourPeak: 1e6, hourlyProfile: profile, warmupMinutes: 0 },
    });
    s.step();
    expect(Math.floor(s.timeOfDayMin / 60)).toBe(9);
    expect(s.vehicleCount()).toBeGreaterThan(0);
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

  it("fills metrics and totals on a free-flowing road, and leaves the detector to T-19", () => {
    const s = sim(straightRoad(), { demand: { tripsPerHourPeak: 600, warmupMinutes: 0 } });
    s.runUntil(200);
    expect(s.segments()).toHaveLength(80);
    expect(s.segments()).not.toBe(s.segments());
    expect(Object.isFrozen(s.segments()[0])).toBe(true);
    expect(s.signalGroupIds()).toEqual([]);
    expect(s.crosswalkIds()).toEqual([]);
    const m = s.writeMetrics();
    expect(m.segmentCount).toBe(80);
    expect(m.windowS).toBe(300);
    expect(m.simTimeS).toBe(s.simTimeS);
    // Free flow: every segment that saw a vehicle is close to its free-flow speed and nowhere
    // near congested, and the road as a whole is nowhere near capacity.
    const busy = [...m.speedRatio].filter((v) => v > 0);
    expect(busy.length).toBeGreaterThan(0);
    expect(Math.min(...busy)).toBeGreaterThan(0.8);
    expect(m.congestedShare.every((v) => v === 0)).toBe(true);
    expect(m.queueM.every((v) => v === 0)).toBe(true);
    // 600 trips/h over the road's lanes, minus the ramp-up the window still covers.
    expect(Math.max(...m.flow)).toBeGreaterThan(150);
    expect(Math.max(...m.vcRatio)).toBeLessThan(0.9);
    // Rows of causeShare sum to 1 (delay was attributed) or to 0 (no delay on the segment).
    for (let i = 0; i < m.segmentCount; i++) {
      let sum = 0;
      for (let c = 0; c < CAUSE_COUNT; c++) sum += m.causeShare[i * CAUSE_COUNT + c] as number;
      expect(sum === 0 || Math.abs(sum - 1) < 1e-6).toBe(true);
    }
    const own = allocateMetricsFrame(80, 300);
    own.flow[3] = 42;
    expect(s.writeMetrics(own)).toBe(own);
    expect(own.flow[3]).toBe(m.flow[3]);
    const r = s.report();
    expect(r.items).toEqual([]);
    expect(r.totals.vehiclesActive).toBe(s.vehicleCount());
    expect(r.totals.vehiclesCompleted).toBe(s.tripStats().total.completed);
    expect(r.totals.meanSpeedKph).toBeGreaterThan(30);
    expect(r.totals.stoppedShare).toBe(0);
    expect(r.totals.busMeanSpeedKph).toBe(0);
    expect(r.totals.congestedSegmentShare).toBe(0);
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

  it("drops cars at a junction whose only connector leads to a bus-only lane, without a trip", () => {
    const s = sim(twoLinkRoad({ busOnlySecondLink: true }), {
      demand: { tripsPerHourPeak: 600, warmupMinutes: 0 },
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
    const dropped = kernelOf(s).droppedVehicles;
    expect(dropped).toBeGreaterThan(10);
    expect(st.total.completed).toBe(0);
    expect(st.total.spawned).toBe(st.total.active + dropped);
  });

  it("merges vehicles out of a lane that ends mid-link instead of dropping them (T-10)", () => {
    const net = straightRoad({ lanes: 2 });
    const lane = net.lanes[1];
    if (!lane) throw new Error("fixture");
    lane.endS = 600;
    // Identical drivers so that completed trips on the single remaining lane are not slowed by platoons.
    const s = sim(net, {
      demand: { tripsPerHourPeak: 3000, warmupMinutes: 0, taxiShare: 0 },
      driver: { desiredSpeedFactor: { mean: 1, sd: 0, min: 0.7, max: 1.3 } },
    });
    const { pool, runtime } = kernelOf(s);
    while (s.simTimeS < 600) {
      s.step();
      for (let i = 0; i < pool.highWater; i++) {
        const t = pool.track[i] as number;
        if (t >= 0) expect(pool.s[i] as number).toBeLessThan(runtime.trackEndS[t] as number);
      }
    }
    const st = s.tripStats();
    // Before T-10 the ending lane dropped its vehicles; now the mandatory change moves them over.
    expect(kernelOf(s).droppedVehicles).toBe(0);
    expect(st.total.completed).toBeGreaterThan(10);
    expect(st.total.spawned).toBe(st.total.completed + st.total.active);
    // Every completed trip ran the full 1000 m; merging into a saturated lane costs a little delay.
    expect(st.total.meanTripTimeS).toBeGreaterThan(55);
  });

  it("holds vehicles at a blocked entry, reports its cause, and keeps gaps >= s0 across boundaries", () => {
    const s = sim(twoLinkRoad(), { demand: { tripsPerHourPeak: 1200, warmupMinutes: 0 } });
    const { pool, runtime, entryBlockedCause } = kernelOf(s);
    const connector = 2;
    const red = causeCode("signal_red");
    entryBlockedCause[connector] = red;
    let worstGap = Number.POSITIVE_INFINITY;
    let worstSameTrack = Number.POSITIVE_INFINITY;
    let worstCross = Number.POSITIVE_INFINITY;
    const track = () => {
      const g = minGaps(s);
      worstGap = Math.min(worstGap, g.gap);
      worstSameTrack = Math.min(worstSameTrack, g.gapMinusS0);
      worstCross = Math.min(worstCross, g.crossGapMinusS0);
    };
    while (s.simTimeS < 180) {
      s.step();
      track();
      for (let i = 0; i < pool.highWater; i++) {
        const t = pool.track[i] as number;
        if (t < 0) continue;
        expect(t).toBe(0);
        expect(pool.s[i] as number).toBeLessThanOrEqual(500);
      }
    }
    // The head of the queue stands just before the stop line with the signal cause; followers see the leader.
    const head = pool.trackHead[0] as number;
    expect(head).toBeGreaterThanOrEqual(0);
    expect(pool.v[head]).toBeLessThan(0.5);
    expect((runtime.trackEndS[0] as number) - (pool.s[head] as number)).toBeLessThan(6);
    expect(pool.cause[head]).toBe(red);
    const follower = pool.behind[head] as number;
    expect(follower).toBeGreaterThanOrEqual(0);
    expect(pool.cause[follower]).toBe(causeCode("leader"));
    expect(s.tripStats().total.completed).toBe(0);

    entryBlockedCause[connector] = 0;
    while (s.simTimeS < 480) {
      s.step();
      track();
    }
    // Across lane -> connector -> lane the gap never drops below the follower's s0. Inside a standing
    // queue the discrete IDM may stop a few decimetres short of s0 (never a collision), see README.
    expect(worstCross).toBeGreaterThanOrEqual(0);
    expect(worstSameTrack).toBeGreaterThan(-1);
    expect(worstGap).toBeGreaterThan(0.5);
    expect(s.tripStats().total.completed).toBeGreaterThan(20);
    expect(kernelOf(s).droppedVehicles).toBe(0);
  });

  it("keeps gaps >= s0 across lane -> connector -> lane under a speed drop at high demand", () => {
    const s = sim(twoLinkRoad(), { demand: { tripsPerHourPeak: 1500, warmupMinutes: 0 } });
    let worst = Number.POSITIVE_INFINITY;
    let worstCross = Number.POSITIVE_INFINITY;
    while (s.simTimeS < 600) {
      s.step();
      const g = minGaps(s);
      worst = Math.min(worst, g.gapMinusS0);
      worstCross = Math.min(worstCross, g.crossGapMinusS0);
    }
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(worstCross).toBeGreaterThanOrEqual(0);
    expect(worstCross).toBeLessThan(Number.POSITIVE_INFINITY); // boundary pairs were actually observed
    expect(s.tripStats().total.completed).toBeGreaterThan(100);
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
      // A vehicle changing lanes (T-10) slides between the two lane centres for 2 s.
      const changing = ((frame.flags[k] as number) & BLINKERS) !== 0;
      if (y < -1) {
        // still on the eastbound leg: y is the lane offset, heading east
        if (!changing) expect(Math.abs(Math.abs(y) - 1.75)).toBeLessThan(1e-4);
        expect(Math.abs(y)).toBeLessThanOrEqual(1.75 + 1e-4);
        expect(frame.heading[k]).toBeCloseTo(0, 6);
        east++;
      } else if (y > 5) {
        // northbound leg: x is 500 +- lane offset, heading north
        if (!changing) expect(Math.abs(Math.abs(x - 500) - 1.75)).toBeLessThan(1e-4);
        expect(Math.abs(x - 500)).toBeLessThanOrEqual(1.75 + 1e-4);
        expect(frame.heading[k]).toBeCloseTo(Math.PI / 2, 6);
        north++;
      }
    }
    expect(east).toBeGreaterThan(0);
    expect(north).toBeGreaterThan(0);
  });
});

describe("performance", () => {
  // The explicit timeout covers the warm-up, not the measurement: filling 20 lanes takes a few
  // thousand steps and T-10 made every one of them do lane-change work.
  it("steps 5000 vehicles well under 5 ms", { timeout: 30_000 }, () => {
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
