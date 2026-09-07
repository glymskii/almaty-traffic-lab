/**
 * Nuance tests N18-N20: pedestrians, gridlock, merges. Fixtures: crossroads, mergeRamp. Closed by T-15 (N18), T-11 + T-21 (N19), T-16 (N20).
 */
import { describe, it } from "vitest";

describe("N18 pedestrian yield", () => {
  it.todo(
    "crosswalks with pedestrian flow lower right-turn throughput; cause pedestrian_yield present",
  );
  it.todo("pedestrians.enabled = false restores right-turn throughput");
});

describe("N19 gridlock", () => {
  it.todo(
    "gridlockDiscipline 0 with a blocked exit lets cars stop inside the intersection; cross flow drops, cause gridlock",
  );
  it.todo("gridlockDiscipline 1 keeps the intersection clear; cross flow unaffected");
});

describe("N20 merge yield", () => {
  it.todo(
    "high ramp flow lowers mainline speed near the merge; cause merge_yield on the ramp, downstream_spillback/leader upstream",
  );
});
