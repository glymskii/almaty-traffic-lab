import { describe, expect, it } from "vitest";
import { createDelayHistory, pushDelaySample } from "../src/ui/Sparkline.tsx";

describe("delay history buffer", () => {
  it("starts empty", () => {
    expect(createDelayHistory().samples).toEqual([]);
  });

  it("the first sample is taken as-is (nothing to smooth from yet)", () => {
    const history = pushDelaySample(createDelayHistory(), 0, 42);
    expect(history.samples).toEqual([{ simTimeS: 0, value: 42 }]);
  });

  it("smooths a jump instead of snapping straight to it (docs/tasks/T-18 review: the ±6% saw-tooth)", () => {
    let history = pushDelaySample(createDelayHistory(), 0, 10);
    history = pushDelaySample(history, 30, 20); // a big jump 60s after the first sample
    const last = history.samples[history.samples.length - 1];
    expect(last?.value).toBeGreaterThan(10);
    expect(last?.value).toBeLessThan(20);
  });

  it("converges toward a value held steady over several samples", () => {
    let history = pushDelaySample(createDelayHistory(), 0, 10);
    for (let t = 30; t <= 900; t += 30) history = pushDelaySample(history, t, 20);
    const last = history.samples[history.samples.length - 1];
    expect(last?.value).toBeCloseTo(20, 0);
  });

  it("prunes samples older than the 30-minute span", () => {
    let history = pushDelaySample(createDelayHistory(), 0, 5);
    history = pushDelaySample(history, 1900, 5); // > 1800s later
    expect(history.samples).toHaveLength(1);
    expect(history.samples[0]?.simTimeS).toBe(1900);
  });

  it("a non-advancing or rewound clock doesn't smooth away the new value", () => {
    let history = pushDelaySample(createDelayHistory(), 100, 10);
    history = pushDelaySample(history, 100, 50); // dtS === 0
    const last = history.samples[history.samples.length - 1];
    expect(last?.value).toBe(50);
  });
});
