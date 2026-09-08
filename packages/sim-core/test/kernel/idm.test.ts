import { describe, expect, it } from "vitest";
import { IDM_MAX_DECEL, idmAcceleration, idmFreeAcceleration } from "../../src/models/idm.ts";

const T = 1.2;
const S0 = 2;
const A = 1.5;
const B = 2;

describe("IDM", () => {
  it("free road: a = aMax * (1 - (v/v0)^4)", () => {
    expect(idmFreeAcceleration(10, 20, A)).toBeCloseTo(1.40625, 10);
    expect(idmAcceleration(10, 20, 0, Number.POSITIVE_INFINITY, T, S0, A, B)).toBeCloseTo(
      1.40625,
      10,
    );
    expect(idmFreeAcceleration(0, 20, A)).toBeCloseTo(A, 10);
    expect(idmFreeAcceleration(20, 20, A)).toBeCloseTo(0, 10);
  });

  it("standing behind a standing leader at gap s0 gives zero acceleration", () => {
    expect(idmAcceleration(0, 20, 0, S0, T, S0, A, B)).toBeCloseTo(0, 10);
  });

  it("equilibrium following: a = 0 when gap = s* / sqrt(1 - (v/v0)^4)", () => {
    const v = 10;
    const v0 = 20;
    const sStar = S0 + v * T; // dv = 0
    const gapEq = sStar / Math.sqrt(1 - (v / v0) ** 4);
    expect(idmAcceleration(v, v0, 0, gapEq, T, S0, A, B)).toBeCloseTo(0, 10);
    // At exactly s* the interaction term equals aMax, so a = free - aMax.
    expect(idmAcceleration(v, v0, 0, sStar, T, S0, A, B)).toBeCloseTo(1.40625 - A, 10);
  });

  it("closing in on a stopped leader brakes harder than the comfortable deceleration", () => {
    // s* = 2 + 24 + 400 / (2 sqrt(3)) = 141.47; a = 1.5 * (1 - 1 - (141.47 / 100)^2) = -3.0
    const a = idmAcceleration(20, 20, 20, 100, T, S0, A, B);
    expect(a).toBeCloseTo(-1.5 * (141.4700538 / 100) ** 2, 4);
    expect(a).toBeLessThan(-B);
  });

  it("never brakes harder than IDM_MAX_DECEL", () => {
    expect(IDM_MAX_DECEL).toBe(8);
    expect(idmAcceleration(20, 20, 20, 50, T, S0, A, B)).toBe(-IDM_MAX_DECEL);
    expect(idmAcceleration(10, 20, 0, 0, T, S0, A, B)).toBe(-IDM_MAX_DECEL);
    expect(idmFreeAcceleration(60, 20, A)).toBe(-IDM_MAX_DECEL);
    expect(idmFreeAcceleration(25, 20, A)).toBeGreaterThan(-IDM_MAX_DECEL);
  });

  it("is monotonic in the gap and finite for a vanishing gap", () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (const gap of [0, 0.001, 1, 5, 10, 50, 200, 1e6]) {
      const a = idmAcceleration(15, 20, 2, gap, T, S0, A, B);
      expect(Number.isFinite(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it("ignores the dynamic term when the leader pulls away faster than the headway demands", () => {
    // v * dv / (2 sqrt(ab)) strongly negative: s* falls back to s0 (max(0, ...)).
    const a = idmAcceleration(10, 20, -30, 30, T, S0, A, B);
    expect(a).toBeCloseTo(1.40625 - A * (S0 / 30) ** 2, 10);
  });
});
