import type { CauseKey } from "@atl/contracts";
import { CAUSES } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { causeColor, causeLabel, visibleCauses } from "../src/ui/CauseBar.tsx";

type CauseShare = { cause: CauseKey; share: number };

describe("causeLabel/causeColor", () => {
  it("labels come from contracts' CAUSES.ru, not a duplicate translation table", () => {
    const signalRed = CAUSES.find((c) => c.key === "signal_red");
    expect(signalRed).toBeDefined();
    expect(causeLabel("signal_red")).toBe(signalRed?.ru);
  });

  it("gives every cause a colour, stable across calls", () => {
    for (const cause of CAUSES) {
      const color = causeColor(cause.key);
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
      expect(causeColor(cause.key)).toBe(color);
    }
  });
});

describe("visibleCauses", () => {
  it("drops shares too small to read on the bar (docs/tasks/T-25 п.6 'фильтрация')", () => {
    const causes: CauseShare[] = [
      { cause: "signal_red", share: 0.6 },
      { cause: "gridlock", share: 0.35 },
      { cause: "yield_priority", share: 0.01 },
    ];
    expect(visibleCauses(causes)).toEqual([
      { cause: "signal_red", share: 0.6 },
      { cause: "gridlock", share: 0.35 },
    ]);
  });

  it("keeps a share exactly at the visibility threshold", () => {
    const causes: CauseShare[] = [{ cause: "signal_red", share: 0.02 }];
    expect(visibleCauses(causes)).toEqual(causes);
  });

  it("passes through an empty list", () => {
    expect(visibleCauses([])).toEqual([]);
  });
});
