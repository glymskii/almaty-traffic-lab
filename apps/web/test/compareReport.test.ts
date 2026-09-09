import type { BottleneckItem, NetworkTotals } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { computeTotalsDelta, diffBottlenecks } from "../src/state/compareReport.ts";

/**
 * docs/tasks/T-26 п.5: "расчёт дельт и классификация новых/исчезнувших/переехавших на двух
 * синтетических отчётах" - pure-math tests against hand-built `BottleneckItem`/`NetworkTotals`,
 * no store/worker/report involved.
 */

function buildTotals(overrides: Partial<NetworkTotals> = {}): NetworkTotals {
  return {
    vehiclesActive: 100,
    vehiclesCompleted: 50,
    delayVehH: 20,
    delayPersonH: 30,
    meanSpeedKph: 25,
    carMeanSpeedKph: 25,
    busMeanSpeedKph: 20,
    stoppedShare: 0.1,
    congestedSegmentShare: 0.2,
    ...overrides,
  };
}

function buildItem(overrides: Partial<BottleneckItem> = {}): BottleneckItem {
  return {
    rank: 1,
    id: "l0:n0",
    segmentIndices: [0],
    linkId: "l0",
    nodeId: "n0",
    title: "Тестовый подход",
    delayVehH: 10,
    delayPersonH: 15,
    speedRatio: 0.2,
    queueM: 80,
    vcRatio: 0.9,
    los: "E",
    persistence: 0.9,
    causes: [],
    recommendations: [],
    focus: [0, 0],
    ...overrides,
  };
}

describe("computeTotalsDelta", () => {
  it("returns one row per TOTALS_DELTA_KEYS, in order, with b - a as the delta", () => {
    const a = buildTotals({ delayVehH: 20, meanSpeedKph: 25, congestedSegmentShare: 0.3 });
    const b = buildTotals({ delayVehH: 12, meanSpeedKph: 30, congestedSegmentShare: 0.1 });
    const rows = computeTotalsDelta(a, b);
    expect(rows.map((r) => r.key)).toEqual([
      "delayVehH",
      "delayPersonH",
      "meanSpeedKph",
      "carMeanSpeedKph",
      "busMeanSpeedKph",
      "congestedSegmentShare",
    ]);
    const delayRow = rows.find((r) => r.key === "delayVehH");
    expect(delayRow).toEqual({ key: "delayVehH", a: 20, b: 12, delta: -8 });
    const speedRow = rows.find((r) => r.key === "meanSpeedKph");
    expect(speedRow).toEqual({ key: "meanSpeedKph", a: 25, b: 30, delta: 5 });
  });

  it("a left-turn arrow that cuts delay in half shows a negative delayVehH delta (docs/tasks/T-26 acceptance)", () => {
    const a = buildTotals({ delayVehH: 40 });
    const b = buildTotals({ delayVehH: 18 });
    const rows = computeTotalsDelta(a, b);
    const delayRow = rows.find((r) => r.key === "delayVehH");
    expect(delayRow?.delta).toBeLessThan(0);
  });
});

describe("diffBottlenecks", () => {
  it("an id present in both is neither appeared nor disappeared", () => {
    const shared = buildItem({ id: "l0:n0" });
    const diff = diffBottlenecks([shared], [shared]);
    expect(diff.appeared).toEqual([]);
    expect(diff.disappeared).toEqual([]);
    expect(diff.moved).toEqual([]);
  });

  it("an id only in B is a new bottleneck (docs/tasks/T-26 acceptance: 'новые узкие места')", () => {
    const b = buildItem({ id: "l1:n1", title: "Новое" });
    const diff = diffBottlenecks([], [b]);
    expect(diff.appeared).toEqual([b]);
    expect(diff.disappeared).toEqual([]);
    expect(diff.moved).toEqual([]);
  });

  it("an id only in A is a disappeared bottleneck", () => {
    const a = buildItem({ id: "l1:n1", title: "Пропало" });
    const diff = diffBottlenecks([a], []);
    expect(diff.disappeared).toEqual([a]);
    expect(diff.appeared).toEqual([]);
    expect(diff.moved).toEqual([]);
  });

  it("same node, different approach link in A vs B is classified as moved, not appeared+disappeared", () => {
    const a = buildItem({ id: "north:n0", linkId: "north", nodeId: "n0", title: "С севера" });
    const b = buildItem({ id: "south:n0", linkId: "south", nodeId: "n0", title: "С юга" });
    const diff = diffBottlenecks([a], [b]);
    expect(diff.appeared).toEqual([]);
    expect(diff.disappeared).toEqual([]);
    expect(diff.moved).toEqual([{ nodeId: "n0", a, b }]);
  });

  it("does not match a mid-link item (no nodeId) as moved even if another item shares no node", () => {
    const a = buildItem({ id: "l0:mid", linkId: "l0", nodeId: undefined, title: "Середина A" });
    const b = buildItem({ id: "l1:mid", linkId: "l1", nodeId: undefined, title: "Середина B" });
    const diff = diffBottlenecks([a], [b]);
    expect(diff.disappeared).toEqual([a]);
    expect(diff.appeared).toEqual([b]);
    expect(diff.moved).toEqual([]);
  });

  it("greedily matches at most one B item per A item at the same node", () => {
    const a = buildItem({ id: "north:n0", linkId: "north", nodeId: "n0" });
    const bWest = buildItem({ id: "west:n0", linkId: "west", nodeId: "n0", title: "Запад" });
    const bEast = buildItem({ id: "east:n0", linkId: "east", nodeId: "n0", title: "Восток" });
    const diff = diffBottlenecks([a], [bWest, bEast]);
    expect(diff.moved).toHaveLength(1);
    expect(diff.moved[0]?.b).toBe(bWest); // first candidate in B's own order
    expect(diff.appeared).toEqual([bEast]);
  });

  it("mixes appeared/disappeared/moved together on a realistic pair of reports", () => {
    const kept = buildItem({ id: "keep:n1", linkId: "keep", nodeId: "n1" });
    const disappearing = buildItem({ id: "gone:n2", linkId: "gone", nodeId: "n2" });
    const movedA = buildItem({ id: "north:n3", linkId: "north", nodeId: "n3" });
    const movedB = buildItem({ id: "south:n3", linkId: "south", nodeId: "n3" });
    const appearing = buildItem({ id: "new:n4", linkId: "new", nodeId: "n4" });

    const diff = diffBottlenecks([kept, disappearing, movedA], [kept, movedB, appearing]);
    expect(diff.appeared).toEqual([appearing]);
    expect(diff.disappeared).toEqual([disappearing]);
    expect(diff.moved).toEqual([{ nodeId: "n3", a: movedA, b: movedB }]);
  });
});
