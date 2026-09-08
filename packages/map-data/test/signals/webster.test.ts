import { defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import {
  approachFlowVph,
  arrowGreenS,
  distributeInt,
  flowRatio,
  MIN_CYCLE_S,
  type PhaseDemand,
  pedestrianGreenS,
  websterPlan,
} from "../../src/signals/webster.ts";

const timing = defaultSimConfig().signals;

function through(criticalY: number, lostS = 5): PhaseDemand {
  return { criticalY, lostS };
}

describe("assumed demand", () => {
  it("scales 400 veh/h per through lane by the class of the street", () => {
    expect(approachFlowVph("trunk", 3)).toBe(1800);
    expect(approachFlowVph("primary", 2)).toBeCloseTo(960, 6);
    expect(approachFlowVph("secondary", 2)).toBe(800);
    expect(approachFlowVph("tertiary", 1)).toBeCloseTo(280, 6);
    expect(approachFlowVph("residential", 1)).toBeCloseTo(160, 6);
    expect(approachFlowVph("primary_link", 1)).toBeCloseTo(480, 6);
  });

  it("turns demand into a flow ratio y = q / (s . n)", () => {
    expect(flowRatio(800, 1800, 2)).toBeCloseTo(800 / 3600, 6);
    expect(flowRatio(800, 1800, 0)).toBe(0);
  });
});

describe("Webster cycle on hand-computed numbers", () => {
  it("C = (1.5L + 5) / (1 - sum y) and the green splits proportionally to y", () => {
    // L = 10, sum y = 0.6 => C = 20 / 0.4 = 50; 40 s of green split 0.4 : 0.2.
    const plan = websterPlan([through(0.4), through(0.2)], timing);
    expect(plan.websterCycleS).toBe(50);
    expect(plan.cycleS).toBe(50);
    expect(plan.greensS).toEqual([24, 16]);
    expect(plan.flowRatioSum).toBeCloseTo(0.6, 6);
  });

  it("never goes below 40 s", () => {
    // L = 10, sum y = 0.2 => C = 25, clamped up to MIN_CYCLE_S.
    const plan = websterPlan([through(0.1), through(0.1)], timing);
    expect(plan.websterCycleS).toBe(25);
    expect(plan.cycleS).toBe(MIN_CYCLE_S);
    expect(plan.greensS).toEqual([15, 15]);
  });

  it("never goes above maxCycleS", () => {
    // L = 10, sum y = 0.85 => C = 133 s, clamped down to 120 s.
    const plan = websterPlan([through(0.45), through(0.4)], timing);
    expect(plan.websterCycleS).toBe(133);
    expect(plan.cycleS).toBe(timing.maxCycleS);
    expect(plan.greensS.reduce((a, b) => a + b, 0)).toBe(timing.maxCycleS - 10);
  });

  it("caps sum y at 0.9 so a saturated node still gets a plan", () => {
    const plan = websterPlan([through(0.7), through(0.7)], timing);
    expect(plan.flowRatioSum).toBeCloseTo(1.4, 6);
    expect(plan.cycleS).toBe(timing.maxCycleS);
    expect(plan.greensS.every((g) => g >= timing.minGreenS)).toBe(true);
  });

  it("keeps minGreenS and lets the cycle grow when the minimums do not fit", () => {
    const phases = [through(0.1), through(0.1), through(0.1), through(0.1), through(0.1)];
    const plan = websterPlan(phases, { ...timing, maxCycleS: 40 });
    expect(plan.greensS).toEqual([7, 7, 7, 7, 7]);
    // 5 x (7 green + 5 lost) = 60 s: the minimum greens win over the cap.
    expect(plan.cycleS).toBe(60);
  });

  it("takes the fixed inserts (arrows, pedestrian phase) out of the split", () => {
    const plan = websterPlan(
      [{ criticalY: 0, lostS: 5, fixedGreenS: 12 }, through(0.4), through(0.2)],
      timing,
    );
    // L = 15, sum y = 0.6 => C = 27.5 / 0.4 = 69; 69 - 15 - 12 = 42 s left to split.
    expect(plan.websterCycleS).toBe(69);
    expect(plan.greensS[0]).toBe(12);
    expect((plan.greensS[1] ?? 0) + (plan.greensS[2] ?? 0)).toBe(42);
    expect(plan.cycleS).toBe(69);
  });
});

describe("fixed-length phases", () => {
  it("gives a protected left 10..15 s, about 15 % of the cycle", () => {
    expect(arrowGreenS(40)).toBe(10);
    expect(arrowGreenS(80)).toBe(12);
    expect(arrowGreenS(120)).toBe(15);
  });

  it("sizes a pedestrian-only phase by the crossing time", () => {
    expect(pedestrianGreenS(26, 7)).toBe(20);
    expect(pedestrianGreenS(3, 7)).toBe(7);
    expect(pedestrianGreenS(120, 7)).toBe(30);
  });
});

describe("integer split", () => {
  it("keeps the total, honours the minimum and is stable in ties", () => {
    expect(distributeInt(40, [0.4, 0.2], 7)).toEqual([24, 16]);
    expect(distributeInt(31, [1, 1, 1], 7)).toEqual([11, 10, 10]);
    expect(distributeInt(10, [1, 1], 7)).toEqual([7, 7]);
    expect(distributeInt(30, [0, 0], 7)).toEqual([15, 15]);
    expect(distributeInt(5, [], 7)).toEqual([]);
  });
});
