/**
 * Nuance tests N09-N13: left turns, pockets, additional sections. Fixture: crossroads. Closed by T-10, T-11, T-12, T-22.
 */
import { describe, it } from "vitest";

describe("N09 pocket spillback", () => {
  it.todo(
    "with high left demand a 40 m pocket yields lower through throughput than a 120 m pocket",
  );
  it.todo("root cause pocket_spillback share on the affected approach > 20% (needs T-18 metrics)");
});

describe("N10 permissive left without pocket", () => {
  it.todo(
    "left-turners waiting for gaps block the leftmost through lane; dominant cause gap_left_turn",
  );
});

describe("N11 protected arrow", () => {
  it.todo("protected mode gives lower left-turn delay than permissive at the same demand");
  it.todo("protected mode does not increase opposing through delay at low left demand");
});

describe("N12 arrow off = prohibited", () => {
  it.todo(
    "during main green with the arrow OFF no left-turn vehicle enters the intersection; cause arrow_off appears",
  );
});

describe("N13 prohibited left", () => {
  it.todo("no vehicle uses a left connector; routing sends left-bound trips around the block");
});
