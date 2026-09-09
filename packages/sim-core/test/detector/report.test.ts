/**
 * T-19: `report()` end to end -- the three conditions, the ranking, the stability of the ids the UI
 * keys its markers on, and the cost of a report on a full 20 000-vehicle load.
 */
import { BottleneckReportSchema, defaultSimConfig, type Network } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, straightRoad } from "../fixtures/builders.ts";

const WARMUP_MIN = 3;
const RUN_MIN = 10;

/** The N24 fixture: a permissive left with no pocket, fed by a left-heavy north approach. */
function leftTurnCrossroads(): Network {
  return crossroads({ leftPocketM: 0, leftTurnMode: "permissive", greenSplitNS: 0.7 });
}

function jammedSim(multiplier: number) {
  const network = leftTurnCrossroads();
  const sim = createSimulation({
    network,
    config: defaultSimConfig({
      seed: 1,
      demand: {
        tripsPerHourPeak: 2000,
        multiplier,
        warmupMinutes: WARMUP_MIN,
        vehicleBudget: 4000,
      },
    }),
  });
  kernelOf(sim).setTurnShares("N.in", { left: 0.5, through: 0.5 });
  for (const dir of ["E", "S", "W"]) kernelOf(sim).setTurnShares(`${dir}.in`, { through: 1 });
  sim.runUntil((WARMUP_MIN + RUN_MIN) * 60);
  return sim;
}

describe("bottleneck report", () => {
  it("returns a report the contract accepts, with the window totals of T-18", () => {
    const sim = jammedSim(1.5);
    const report = sim.report();
    expect(() => BottleneckReportSchema.parse(report)).not.toThrow();
    expect(report.simTimeS).toBe(sim.simTimeS);
    expect(report.windowS).toBe(sim.config.metrics.windowS);
    expect(report.totals.delayVehH).toBeGreaterThan(0);
    expect(report.items.length).toBeGreaterThan(0);
  });

  it("finds nothing on an empty network", () => {
    const sim = createSimulation({
      network: straightRoad({ lengthM: 1000, lanes: 2 }),
      config: defaultSimConfig({ seed: 1, demand: { multiplier: 0 } }),
    });
    sim.runUntil(600);
    expect(sim.vehicleCount()).toBe(0);
    expect(sim.report().items).toEqual([]);
  });

  it("ranks by vehicle-hours of delay and numbers the items from 1", () => {
    const items = jammedSim(1.5).report().items;
    expect(items.length).toBeGreaterThan(0);
    for (let i = 0; i < items.length; i++) {
      expect((items[i] as (typeof items)[number]).rank).toBe(i + 1);
      if (i > 0) {
        const prev = (items[i - 1] as (typeof items)[number]).delayVehH;
        expect((items[i] as (typeof items)[number]).delayVehH).toBeLessThanOrEqual(prev);
      }
    }
    // Person-hours are reported for every item but never reorder the list.
    for (const item of items) expect(item.delayPersonH).toBeGreaterThan(item.delayVehH);
  });

  it("keeps item ids stable between two reports over the same window", () => {
    const sim = jammedSim(1.5);
    const first = sim.report();
    const second = sim.report();
    expect(second.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
    expect(second.items.map((i) => i.delayVehH)).toEqual(first.items.map((i) => i.delayVehH));

    // And after another minute of jam the same place still carries the same id.
    sim.runUntil(sim.simTimeS + 60);
    const later = sim.report();
    expect(later.items.map((i) => i.id)).toContain(first.items[0]?.id);
    for (const item of later.items) {
      expect(item.id).toBe(`${item.linkId}:${item.nodeId ?? "mid"}`);
    }
  });

  it("respects topN", () => {
    const network = leftTurnCrossroads();
    const sim = createSimulation({
      network,
      config: defaultSimConfig({
        seed: 1,
        demand: { tripsPerHourPeak: 3000, warmupMinutes: WARMUP_MIN, vehicleBudget: 4000 },
        metrics: { topN: 1 },
      }),
    });
    sim.runUntil((WARMUP_MIN + RUN_MIN) * 60);
    expect(sim.report().items.length).toBeLessThanOrEqual(1);
  });

  it("keeps a jammed stretch inside a queue out of the report and blames its head instead", () => {
    const report = jammedSim(1.5).report();
    const head = report.items[0];
    expect(head).toBeDefined();
    if (head === undefined) return;
    // The approach is what is reported; the metres of link behind it are inside the same queue and
    // must not be counted a second time as their own bottleneck.
    expect(head.nodeId).toBeDefined();
    expect(report.items.some((i) => i.id === `${head.linkId}:mid`)).toBe(false);
  });

  // T-30 integration review: on GitHub Actions' shared runners this measured 30-32ms across
  // several runs (vs. the ~12-15ms a dev machine sees) - the threshold carries headroom for that
  // slower, noisier hardware rather than the tighter budget a local machine could hold to.
  it("builds a report on 20 000 vehicles in under 60 ms", { timeout: 120_000 }, () => {
    // The same very wide road the T-18 sampling budget uses: it fills the vehicle budget fast.
    const sim = createSimulation({
      network: straightRoad({ lengthM: 2000, lanes: 400 }),
      config: defaultSimConfig({
        demand: { tripsPerHourPeak: 2_000_000, warmupMinutes: 0, vehicleBudget: 22000 },
      }),
    });
    while (sim.vehicleCount() < 20000 && sim.simTimeS < 600) sim.step();
    expect(sim.vehicleCount()).toBeGreaterThanOrEqual(20000);

    for (let k = 0; k < 3; k++) sim.report(); // warm the code paths
    const runs = 20;
    const t0 = performance.now();
    for (let k = 0; k < runs; k++) sim.report();
    const perReportMs = (performance.now() - t0) / runs;
    expect(perReportMs).toBeLessThan(60);
  });
});
