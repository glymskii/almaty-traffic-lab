/**
 * Nuance tests N23-N24: metrics in people and the detector. Closed by T-18, T-19.
 */
import { describe, it } from "vitest";

describe("N23 person metrics", () => {
  it.todo(
    "bus-lane scenario with frequent buses: person-delay lower while vehicle-delay higher than baseline",
  );
});

describe("N24 detector root cause", () => {
  it.todo(
    "on a fixture with a known cause the top-1 item is the expected approach and its dominant cause matches",
  );
  it.todo("queue members inherit the root cause of the queue head (root-cause propagation)");
});
