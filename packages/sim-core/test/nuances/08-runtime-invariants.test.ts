/**
 * Nuance tests N25-N27: runtime parameters, invariants, performance. Closed by T-04/T-06 (N25), T-21 (N26), T-28 (N27).
 */
import { describe, it } from "vitest";

describe("N25 runtime parameters", () => {
  it.todo("setParams with a RUNTIME_SAFE path applies immediately; any other path throws");
});

describe("N26 invariants", () => {
  it.todo(
    "10 sim-minutes of saturated crossroads: no vehicle overlap, no NaN, no negative gap (debugInvariants on)",
  );
});

describe("N27 performance", () => {
  it.todo(
    "20 000 vehicles: mean step time <= 30 ms on the reference machine (benchmark, run separately)",
  );
});
