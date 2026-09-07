/**
 * Nuance tests N05-N08: signals. Fixtures: crossroads, corridor. Closed by T-09 (N05, N06), T-18 (N07), T-22 (N08).
 */
import { describe, it } from "vitest";

describe("N05 red stops, green discharges", () => {
  it.todo("queue grows during red and discharges at ~1800 veh/h/lane during green (±15%)");
});

describe("N06 local signal sequence", () => {
  it.todo(
    "group state timeline is GREEN -> FLASHING_GREEN (3 s) -> YELLOW -> RED -> RED_YELLOW (2 s) -> GREEN",
  );
  it.todo("arrow sections report OFF, never RED, outside their green");
});

describe("N07 green split", () => {
  it.todo(
    "raising NS green from 30 s to 50 s lowers NS approach delay and raises EW approach delay",
  );
});

describe("N08 green wave", () => {
  it.todo(
    "corridor offsets = spacing / speed give fewer stops per vehicle than zero offsets (≥25% fewer)",
  );
});
