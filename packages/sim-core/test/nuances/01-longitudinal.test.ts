/**
 * Nuance tests N01-N04: longitudinal movement and determinism. Fixture: straightRoad. Closed by T-04.
 * Full specification of each test: docs/NUANCES.md
 */
import { describe, it } from "vitest";

describe("N01 speed limit", () => {
  it.todo(
    "free-flow mean speed tracks the limit: 60 km/h road ~ 60 * mean(desiredSpeedFactor), 40 km/h road ~ 40 (±5%)",
  );
});

describe("N02 lane count", () => {
  it.todo("at saturation demand a 3-lane road passes ~1.5x the flow of a 2-lane road (±15%)");
});

describe("N03 driver heterogeneity", () => {
  it.todo(
    "with sd > 0 free-flow speeds spread (p90/p10 > 1.15); with sd = 0 all vehicles drive the same speed",
  );
});

describe("N04 determinism", () => {
  it.todo("same seed + network + config => identical trajectoryHash after 10 sim-minutes");
  it.todo("different seed => different trajectoryHash");
});
