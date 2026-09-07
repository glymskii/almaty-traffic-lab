/**
 * Nuance tests N21-N22: routing and demand. Fixtures: corridor(parallelStreet), crossroads. Closed by T-12, T-19.
 */
import { describe, it } from "vitest";

describe("N21 navigator re-routing", () => {
  it.todo(
    "with the arterial saturated, navigatorShare 0.5 sends more flow to the parallel street than navigatorShare 0",
  );
});

describe("N22 demand tipping point", () => {
  it.todo(
    "demand multiplier 0.5 produces no bottleneck; 1.5 produces one on the expected approach",
  );
});
