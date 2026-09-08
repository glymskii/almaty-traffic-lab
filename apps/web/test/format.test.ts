import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatFps,
  formatShare,
  roundHours,
  roundKph,
  rtFactorLevel,
} from "../src/state/format.ts";

describe("formatClock", () => {
  it("formats minutes since midnight as HH:MM", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(480)).toBe("08:00");
    expect(formatClock(1110)).toBe("18:30");
    expect(formatClock(59)).toBe("00:59");
  });

  it("wraps a run that crosses midnight (both directions)", () => {
    expect(formatClock(1440)).toBe("00:00");
    expect(formatClock(1500)).toBe("01:00");
    expect(formatClock(-60)).toBe("23:00");
  });
});

describe("rtFactorLevel", () => {
  it("thresholds match docs/tasks/T-23 (yellow < 0.8, red < 0.5)", () => {
    expect(rtFactorLevel(1)).toBe("ok");
    expect(rtFactorLevel(0.8)).toBe("ok");
    expect(rtFactorLevel(0.79)).toBe("warn");
    expect(rtFactorLevel(0.5)).toBe("warn");
    expect(rtFactorLevel(0.49)).toBe("danger");
    expect(rtFactorLevel(0)).toBe("danger");
  });
});

describe("roundKph / roundHours / formatFps / formatShare", () => {
  it("round to the precision the HUD displays", () => {
    expect(roundKph(23.6)).toBe(24);
    expect(roundHours(1.449)).toBe(1.4);
    expect(roundHours(1.45)).toBe(1.5);
    expect(formatFps(59.8)).toBe("60");
    expect(formatShare(0.256)).toBe("26%");
  });
});
