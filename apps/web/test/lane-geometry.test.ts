import type { Point2 } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import {
  laneEdgeOffsetM,
  laneLateralOffsetM,
  offsetPolyline,
  rotateVector,
  sampleAtS,
  slicePolyline,
} from "../src/geometry/lane-geometry.ts";

describe("laneLateralOffsetM", () => {
  it("centres an even lane count on the axis", () => {
    expect(laneLateralOffsetM(0, 2, 3.5)).toBeCloseTo(-1.75);
    expect(laneLateralOffsetM(1, 2, 3.5)).toBeCloseTo(1.75);
  });

  it("puts the middle lane of an odd count on the axis", () => {
    expect(laneLateralOffsetM(0, 3, 3.5)).toBeCloseTo(-3.5);
    expect(laneLateralOffsetM(1, 3, 3.5)).toBeCloseTo(0);
    expect(laneLateralOffsetM(2, 3, 3.5)).toBeCloseTo(3.5);
  });
});

describe("laneEdgeOffsetM", () => {
  it("returns the two edges of a lane, width apart", () => {
    expect(laneEdgeOffsetM(0, 2, 3.5, "left")).toBeCloseTo(-3.5);
    expect(laneEdgeOffsetM(0, 2, 3.5, "right")).toBeCloseTo(0);
  });
});

describe("offsetPolyline", () => {
  it("shifts a straight line to the right of travel by a constant distance", () => {
    const result = offsetPolyline(
      [
        [0, 0],
        [10, 0],
      ],
      2,
    );
    expect(result).toEqual([
      [0, -2],
      [10, -2],
    ]);
  });

  it("shifts left for a negative offset", () => {
    const result = offsetPolyline(
      [
        [0, 0],
        [10, 0],
      ],
      -2,
    );
    expect(result).toEqual([
      [0, 2],
      [10, 2],
    ]);
  });

  it("miters an interior vertex so both segments stay a constant distance away", () => {
    const result = offsetPolyline(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      1,
    );
    expect(result[0]?.[0]).toBeCloseTo(0);
    expect(result[0]?.[1]).toBeCloseTo(-1);
    expect(result[1]?.[0]).toBeCloseTo(11);
    expect(result[1]?.[1]).toBeCloseTo(-1);
    expect(result[2]?.[0]).toBeCloseTo(11);
    expect(result[2]?.[1]).toBeCloseTo(10);
  });
});

describe("sampleAtS", () => {
  const line: Point2[] = [
    [0, 0],
    [10, 0],
  ];

  it("interpolates along a segment", () => {
    const { point, heading } = sampleAtS(line, 4);
    expect(point[0]).toBeCloseTo(4);
    expect(point[1]).toBeCloseTo(0);
    expect(heading).toEqual([1, 0]);
  });

  it("clamps past the end of the polyline", () => {
    const { point } = sampleAtS(line, 50);
    expect(point).toEqual([10, 0]);
  });

  it("clamps before the start of the polyline", () => {
    const { point } = sampleAtS(line, -5);
    expect(point).toEqual([0, 0]);
  });
});

describe("slicePolyline", () => {
  it("extracts a straight sub-segment with interpolated endpoints", () => {
    const result = slicePolyline(
      [
        [0, 0],
        [20, 0],
      ],
      5,
      15,
    );
    expect(result).toEqual([
      [5, 0],
      [15, 0],
    ]);
  });

  it("keeps interior vertices that fall inside the range", () => {
    const result = slicePolyline(
      [
        [0, 0],
        [10, 0],
        [20, 0],
      ],
      5,
      15,
    );
    expect(result).toEqual([
      [5, 0],
      [10, 0],
      [15, 0],
    ]);
  });
});

describe("rotateVector", () => {
  it("rotates counter-clockwise from +x, matching CLAUDE.md's angle convention", () => {
    const left = rotateVector([1, 0], Math.PI / 2);
    expect(left[0]).toBeCloseTo(0);
    expect(left[1]).toBeCloseTo(1);

    const right = rotateVector([1, 0], -Math.PI / 2);
    expect(right[0]).toBeCloseTo(0);
    expect(right[1]).toBeCloseTo(-1);
  });
});
