/**
 * T-18: the segment index behind the metrics window -- lane lookup, connector attribution and the
 * V/C denominator.
 */
import { defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, straightRoad } from "../fixtures/builders.ts";

const SATURATION_FLOW = 1800;

function kernel(network = straightRoad()) {
  return kernelOf(createSimulation({ network, config: defaultSimConfig() }));
}

describe("segment index", () => {
  it("maps a lane coordinate to its segment and clamps outside the lane", () => {
    const { runtime, segmentIndex } = kernel(straightRoad({ lengthM: 1000, lanes: 2 }));
    const lane = runtime.laneIndex.get("l0:0") as number;
    const first = runtime.laneSegStart[lane] as number;
    const count = runtime.laneSegCount[lane] as number;
    expect(count).toBe(40); // 1000 m / 25 m
    expect(segmentIndex.segmentOfLane(lane, 0)).toBe(first);
    expect(segmentIndex.segmentOfLane(lane, 24.9)).toBe(first);
    expect(segmentIndex.segmentOfLane(lane, 25.1)).toBe(first + 1);
    expect(segmentIndex.segmentOfLane(lane, 999.9)).toBe(first + count - 1);
    expect(segmentIndex.segmentOfLane(lane, -5)).toBe(first);
    expect(segmentIndex.segmentOfLane(lane, 5000)).toBe(first + count - 1);
    expect(segmentIndex.firstSegmentOfLane(lane)).toBe(first);
    expect(segmentIndex.lastSegmentOfLane(lane)).toBe(first + count - 1);
  });

  it("gives a pocket its own segments on the link's coordinate scale", () => {
    // With a pocket the leftmost lane of an approach *is* the pocket (`N.in:0`, T-03 builder).
    const { runtime, segmentIndex } = kernel(crossroads({ leftPocketM: 60 }));
    const pocket = runtime.laneIndex.get("N.in:0") as number;
    const startS = runtime.trackStartS[pocket] as number;
    const endS = runtime.trackEndS[pocket] as number;
    expect(endS - startS).toBeCloseTo(60, 6);
    const first = segmentIndex.firstSegmentOfLane(pocket);
    const last = segmentIndex.lastSegmentOfLane(pocket);
    expect(last - first).toBe(1); // 60 m -> two pieces of 30 m, not the link's 25 m grid
    expect(segmentIndex.segLengthM[first]).toBeCloseTo(30, 6);
    // The pocket's stretch is indexed from `startS`, not from the start of the link, and a
    // coordinate before it opens still resolves to its first segment (clamped).
    expect(segmentIndex.segmentOfLane(pocket, startS - 10)).toBe(first);
    expect(segmentIndex.segmentOfLane(pocket, startS + 1)).toBe(first);
    expect(segmentIndex.segmentOfLane(pocket, startS + 45)).toBe(last);
    expect(segmentIndex.segEndS[last]).toBeCloseTo(endS, 6);
  });

  it("attributes a connector to the last segment of its incoming lane", () => {
    const { runtime, segmentIndex } = kernel(crossroads());
    let checked = 0;
    for (let c = 0; c < runtime.connectorCount; c++) {
      const track = runtime.laneCount + c;
      const from = runtime.connFromLane[c] as number;
      expect(segmentIndex.connSegment[track]).toBe(segmentIndex.lastSegmentOfLane(from));
      // Whatever `s` a vehicle has on the connector, it counts into that one segment.
      expect(segmentIndex.segmentOf(track, 0)).toBe(segmentIndex.lastSegmentOfLane(from));
      expect(segmentIndex.segmentOf(track, runtime.trackEndS[track] as number)).toBe(
        segmentIndex.lastSegmentOfLane(from),
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("scales the V/C denominator of an approach by its green share", () => {
    // Default plan: two phases of 45 s green + 3 s yellow + 2 s all-red, so the cycle is 100 s and
    // a main group is available for 48 of them.
    const { runtime, segmentIndex } = kernel(crossroads({ cycleS: 90, greenSplitNS: 0.5 }));
    const lane = runtime.laneIndex.get("N.in:0") as number;
    const approach = segmentIndex.lastSegmentOfLane(lane);
    expect(segmentIndex.segIsApproach[approach]).toBe(1);
    expect(segmentIndex.segCapacityVehH[approach]).toBeCloseTo(SATURATION_FLOW * 0.48, 6);
    // A segment in the middle of the same lane is not an approach: full saturation flow.
    const middle = segmentIndex.firstSegmentOfLane(lane);
    expect(segmentIndex.segIsApproach[middle]).toBe(0);
    expect(segmentIndex.segCapacityVehH[middle]).toBeCloseTo(SATURATION_FLOW, 6);
  });

  it("gives the busier axis the larger share when the green split is uneven", () => {
    const nsHeavy = kernel(crossroads({ greenSplitNS: 0.7 }));
    const nsLane = nsHeavy.runtime.laneIndex.get("N.in:0") as number;
    const ewLane = nsHeavy.runtime.laneIndex.get("E.in:0") as number;
    const nsCap = nsHeavy.segmentIndex.segCapacityVehH[
      nsHeavy.segmentIndex.lastSegmentOfLane(nsLane)
    ] as number;
    const ewCap = nsHeavy.segmentIndex.segCapacityVehH[
      nsHeavy.segmentIndex.lastSegmentOfLane(ewLane)
    ] as number;
    expect(nsCap).toBeGreaterThan(ewCap);
    // Both greens (90 s) plus both yellows (6 s) over the 100 s cycle.
    expect(nsCap + ewCap).toBeCloseTo(SATURATION_FLOW * 0.96, 6);
  });

  it("leaves an unsignalized approach at the full saturation flow", () => {
    const { runtime, segmentIndex } = kernel(straightRoad({ lengthM: 500 }));
    const lane = runtime.laneIndex.get("l0:0") as number;
    for (
      let s = segmentIndex.firstSegmentOfLane(lane);
      s <= segmentIndex.lastSegmentOfLane(lane);
      s++
    ) {
      expect(segmentIndex.segCapacityVehH[s]).toBeCloseTo(SATURATION_FLOW, 6);
    }
  });
});
