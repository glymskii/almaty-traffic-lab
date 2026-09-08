import { describe, expect, it } from "vitest";
import { createTimeOfDaySample, sampleTimeOfDay } from "../src/scene/time-of-day.ts";

function sample(timeOfDayMin: number) {
  const out = createTimeOfDaySample();
  sampleTimeOfDay(timeOfDayMin, out);
  return out;
}

describe("sampleTimeOfDay", () => {
  it("is bright with no headlight glow at the day anchor (13:00)", () => {
    const s = sample(13 * 60);
    expect(s.hemiIntensity).toBeCloseTo(1.0, 5);
    expect(s.sunIntensity).toBeCloseTo(1.3, 5);
    expect(s.headlight).toBe(0);
    expect(s.background.getHexString()).toBe("dfe6ea");
  });

  it("is dim with full headlight glow at the night anchor (02:00)", () => {
    const s = sample(2 * 60);
    expect(s.hemiIntensity).toBeCloseTo(0.3, 5);
    expect(s.sunIntensity).toBeCloseTo(0.2, 5);
    expect(s.headlight).toBe(1);
  });

  it("is dimmer than day but brighter than night, with partial glow, at the evening anchor (19:30)", () => {
    const s = sample(19 * 60 + 30);
    expect(s.hemiIntensity).toBeCloseTo(0.75, 5);
    expect(s.headlight).toBeCloseTo(0.6, 5);
    expect(s.hemiIntensity).toBeLessThan(sample(13 * 60).hemiIntensity);
    expect(s.hemiIntensity).toBeGreaterThan(sample(2 * 60).hemiIntensity);
  });

  it("interpolates halfway between two anchors", () => {
    // Halfway from the night anchor (02:00) to the day anchor (13:00) is 07:30.
    const mid = sample(7 * 60 + 30);
    const night = sample(2 * 60);
    const day = sample(13 * 60);
    expect(mid.headlight).toBeCloseTo((night.headlight + day.headlight) / 2, 5);
    expect(mid.hemiIntensity).toBeCloseTo((night.hemiIntensity + day.hemiIntensity) / 2, 5);
  });

  it("wraps around midnight smoothly (23:59 is close to 00:01, both near the night anchor)", () => {
    const late = sample(23 * 60 + 59);
    const early = sample(1);
    expect(Math.abs(late.hemiIntensity - early.hemiIntensity)).toBeLessThan(0.02);
  });

  it("never produces a negative or out-of-range intensity across the full day", () => {
    for (let m = 0; m < 1440; m += 15) {
      const s = sample(m);
      expect(s.hemiIntensity).toBeGreaterThan(0);
      expect(s.sunIntensity).toBeGreaterThan(0);
      expect(s.headlight).toBeGreaterThanOrEqual(0);
      expect(s.headlight).toBeLessThanOrEqual(1);
    }
  });

  it("writes into the same output object without allocating a new one each call (mutates in place)", () => {
    const out = createTimeOfDaySample();
    sampleTimeOfDay(8 * 60, out);
    const bg = out.background;
    sampleTimeOfDay(20 * 60, out);
    expect(out.background).toBe(bg); // same Color instance, mutated
  });
});
