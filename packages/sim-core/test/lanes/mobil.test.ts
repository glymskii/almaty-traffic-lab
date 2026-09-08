import { describe, expect, it } from "vitest";
import { idmAcceleration, idmFreeAcceleration } from "../../src/models/idm.ts";
import {
  MOBIL_FORCE_WITHIN_M,
  MOBIL_MAX_MANDATORY_BIAS_MPS2,
  MOBIL_SAFE_DECEL_MPS2,
  mandatoryBias,
  mobilIncentive,
  mobilSafe,
} from "../../src/models/mobil.ts";

describe("MOBIL safety criterion", () => {
  it("accepts exactly down to -b_safe and refuses anything harder", () => {
    expect(mobilSafe(0)).toBe(true);
    expect(mobilSafe(-MOBIL_SAFE_DECEL_MPS2)).toBe(true);
    expect(mobilSafe(-MOBIL_SAFE_DECEL_MPS2 - 1e-9)).toBe(false);
    expect(mobilSafe(-8)).toBe(false);
    // A stricter b_safe may be passed explicitly.
    expect(mobilSafe(-3, 2)).toBe(false);
    expect(mobilSafe(-1.5, 2)).toBe(true);
  });

  it("refuses a change that would drop the new follower onto a stopped vehicle", () => {
    // Follower at 14 m/s, 3 m behind a vehicle that stands still: IDM brakes far harder than b_safe.
    const a = idmAcceleration(14, 16.7, 14, 3, 1.2, 2, 1.5, 2);
    expect(a).toBeLessThan(-MOBIL_SAFE_DECEL_MPS2);
    expect(mobilSafe(a)).toBe(false);
  });
});

describe("MOBIL incentive", () => {
  const aFree = idmFreeAcceleration(14, 16.7, 1.5);

  it("is the own gain when the driver is not polite", () => {
    // The candidate lane is free (a_new = free road), the current one costs 1 m/s^2.
    expect(mobilIncentive(aFree, aFree - 1, 0.4, 0, -0.7, 0, 0)).toBeCloseTo(1, 9);
  });

  it("weights both followers with the politeness factor", () => {
    // old follower gains +0.4 (the changer leaves), new follower loses 0.7 (it arrives).
    const p = 0.5;
    const value = mobilIncentive(aFree, aFree - 1, 0.4, 0, -0.7, 0, p);
    expect(value).toBeCloseTo(1 + p * (0.4 - 0.7), 9);
    // A fully polite driver that hurts the new follower more than it gains stays put.
    expect(mobilIncentive(aFree, aFree - 0.2, 0, 0, -1, 0, 1)).toBeLessThan(0);
  });

  it("is symmetric in the sign of the gain: an unattractive lane yields a negative incentive", () => {
    expect(mobilIncentive(aFree - 1, aFree, 0, 0, 0, 0, 0.3)).toBeCloseTo(-1, 9);
  });
});

describe("mandatory bias", () => {
  const lookahead = 250;

  it("is zero beyond the lane-selection lookahead", () => {
    expect(mandatoryBias(400, lookahead)).toBe(0);
    expect(mandatoryBias(lookahead, lookahead)).toBe(0);
  });

  it("grows linearly from the lookahead down to the forcing zone", () => {
    const mid = (lookahead + MOBIL_FORCE_WITHIN_M) / 2;
    expect(mandatoryBias(mid, lookahead)).toBeCloseTo(MOBIL_MAX_MANDATORY_BIAS_MPS2 / 2, 9);
    const quarter = lookahead - (lookahead - MOBIL_FORCE_WITHIN_M) / 4;
    expect(mandatoryBias(quarter, lookahead)).toBeCloseTo(MOBIL_MAX_MANDATORY_BIAS_MPS2 / 4, 9);
    // Monotone all the way down.
    let prev = 0;
    for (let d = lookahead; d > MOBIL_FORCE_WITHIN_M; d -= 5) {
      const value = mandatoryBias(d, lookahead);
      expect(value).toBeGreaterThanOrEqual(prev);
      prev = value;
    }
  });

  it("forces the change (infinite bias) inside the last 30 m of the lane", () => {
    expect(mandatoryBias(MOBIL_FORCE_WITHIN_M, lookahead)).toBe(Number.POSITIVE_INFINITY);
    expect(mandatoryBias(5, lookahead)).toBe(Number.POSITIVE_INFINITY);
    expect(mandatoryBias(0, lookahead)).toBe(Number.POSITIVE_INFINITY);
    // Forcing beats any finite threshold, so only the safety criterion is left.
    expect(mandatoryBias(1, lookahead) - 0.5).toBe(Number.POSITIVE_INFINITY);
  });

  it("degenerates to forcing when the lookahead is inside the forcing zone", () => {
    expect(mandatoryBias(20, 10)).toBe(Number.POSITIVE_INFINITY);
  });
});
