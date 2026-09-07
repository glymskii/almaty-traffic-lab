import { describe, expect, it } from "vitest";
import { isRuntimeSafePatch } from "../src/worker-main.ts";

describe("isRuntimeSafePatch", () => {
  it("accepts an empty patch", () => {
    expect(isRuntimeSafePatch({})).toBe(true);
  });

  it("accepts a patch touching only RUNTIME_SAFE_PARAM_PATHS leaves", () => {
    expect(
      isRuntimeSafePatch({
        demand: { multiplier: 2, navigatorShare: 0.4 },
        behavior: { gridlockDiscipline: 0.5, busLaneViolatorShare: 0.1 },
      }),
    ).toBe(true);
  });

  it("rejects a patch that also touches an unsafe leaf under a safe branch", () => {
    expect(isRuntimeSafePatch({ demand: { multiplier: 2, vehicleBudget: 100 } })).toBe(false);
  });

  it("rejects an unrelated top-level key", () => {
    expect(isRuntimeSafePatch({ seed: 2 })).toBe(false);
  });

  it("rejects an unsafe leaf even alone", () => {
    expect(isRuntimeSafePatch({ dtS: 0.2 })).toBe(false);
  });
});
