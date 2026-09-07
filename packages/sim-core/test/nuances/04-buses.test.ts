/**
 * Nuance tests N14-N17: buses and dedicated lanes. Fixtures: straightRoad, crossroads. Closed by T-14.
 */
import { describe, it } from "vitest";

describe("N14 bus lane", () => {
  it.todo("3 general lanes vs 2 general + bus lane: car capacity drops by ~1/3 (±10%)");
  it.todo("under congestion bus travel time is lower with a bus lane than without");
});

describe("N15 right-turn entry", () => {
  it.todo(
    "right-turning cars enter the bus lane only within carsMayEnterForRightTurnWithinM of the stop line",
  );
});

describe("N16 violators", () => {
  it.todo(
    "busLaneViolatorShare 0.3 raises bus travel time versus 0; violators carry the BUS_LANE_VIOLATOR flag",
  );
});

describe("N17 in-lane bus stop", () => {
  it.todo("in_lane stop produces cause behind_stopped_bus on the lane; bay stop does not");
});
