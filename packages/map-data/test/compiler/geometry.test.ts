import { describe, expect, it } from "vitest";
import {
  clipSegmentToRect,
  dedupePolyline,
  offsetPolyline,
  simplifyPolyline,
} from "../../src/geometry/polyline.ts";

describe("polyline helpers", () => {
  it("Douglas–Peucker drops near-collinear points and keeps real bends", () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 0.2],
      [20, -0.3],
      [30, 0],
      [40, 20],
      [50, 20],
    ];
    const out = simplifyPolyline(pts, 0.5);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([50, 20]);
    expect(out).toContainEqual([30, 0]);
    expect(out).toContainEqual([40, 20]);
    expect(out).not.toContainEqual([10, 0.2]);
    expect(out).not.toContainEqual([20, -0.3]);
    expect(simplifyPolyline([[0, 0]], 0.5)).toEqual([[0, 0]]);
  });

  it("offsets to the right of the direction of travel", () => {
    const north = offsetPolyline(
      [
        [0, 0],
        [0, 100],
      ],
      3.5,
    );
    expect(north[0]?.[0]).toBeCloseTo(3.5);
    expect(north[1]?.[0]).toBeCloseTo(3.5);
    const east = offsetPolyline(
      [
        [0, 0],
        [100, 0],
      ],
      3.5,
    );
    expect(east[0]?.[1]).toBeCloseTo(-3.5);
    // A right-angle bend: the miter point sits at d in both directions.
    const bend = offsetPolyline(
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      2,
    );
    expect(bend[1]?.[0]).toBeCloseTo(102);
    expect(bend[1]?.[1]).toBeCloseTo(-2);
    expect(offsetPolyline([[0, 0]], 2)).toEqual([[0, 0]]);
  });

  it("limits the miter at hairpins", () => {
    const hairpin = offsetPolyline(
      [
        [0, 0],
        [100, 0],
        [0, 1],
      ],
      3,
    );
    const p = hairpin[1] as [number, number];
    expect(Math.hypot(p[0] - 100, p[1])).toBeLessThanOrEqual(6.01);
  });

  it("clips segments with Liang–Barsky", () => {
    const r = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
    expect(clipSegmentToRect([-5, 5], [5, 5], r)).toEqual([0.5, 1]);
    expect(clipSegmentToRect([5, 5], [15, 5], r)).toEqual([0, 0.5]);
    expect(clipSegmentToRect([-5, 5], [15, 5], r)).toEqual([0.25, 0.75]);
    expect(clipSegmentToRect([-5, 20], [15, 20], r)).toBeUndefined();
    expect(clipSegmentToRect([2, 2], [8, 8], r)).toEqual([0, 1]);
  });

  it("dedupes coincident points", () => {
    expect(
      dedupePolyline([
        [0, 0],
        [0, 0.0001],
        [1, 1],
        [1, 1],
      ]),
    ).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});
