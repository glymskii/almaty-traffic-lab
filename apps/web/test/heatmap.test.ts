import type { SegmentDescriptor } from "@atl/contracts";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  buildHeatmapLayer,
  HEATMAP_NO_DATA_COLOR,
  speedRatioToColor,
} from "../src/scene/heatmap.ts";
import { buildStraightRoad } from "./fixtures.ts";

function colorAt(colorAttr: THREE.BufferAttribute, vertexIndex: number): THREE.Color {
  return new THREE.Color(
    colorAttr.getX(vertexIndex),
    colorAttr.getY(vertexIndex),
    colorAttr.getZ(vertexIndex),
  );
}

function expectCloseColor(actual: THREE.Color, expected: THREE.Color): void {
  expect(actual.r).toBeCloseTo(expected.r, 5);
  expect(actual.g).toBeCloseTo(expected.g, 5);
  expect(actual.b).toBeCloseTo(expected.b, 5);
}

describe("speedRatioToColor", () => {
  it("is grey for undefined and NaN (no data yet)", () => {
    expectCloseColor(speedRatioToColor(undefined), HEATMAP_NO_DATA_COLOR as THREE.Color);
    expectCloseColor(speedRatioToColor(Number.NaN), HEATMAP_NO_DATA_COLOR as THREE.Color);
  });

  it("is green at free flow (1) and red when stopped (0)", () => {
    expectCloseColor(speedRatioToColor(1), new THREE.Color("#4f8f5c"));
    expectCloseColor(speedRatioToColor(0), new THREE.Color("#b0473f"));
  });

  it("clamps out-of-range ratios instead of extrapolating", () => {
    expectCloseColor(speedRatioToColor(1.4), speedRatioToColor(1));
    expectCloseColor(speedRatioToColor(-0.4), speedRatioToColor(0));
  });

  it("is monotonic-ish: a higher ratio never comes out redder (lower green channel) than a lower one", () => {
    const low = speedRatioToColor(0.2);
    const high = speedRatioToColor(0.8);
    expect(high.g).toBeGreaterThan(low.g);
  });
});

describe("buildHeatmapLayer", () => {
  // Single 50m lane cut into two 25m segments (config.metrics.segmentLengthM default) - mirrors
  // roads.test.ts's vertex-count convention: a straight 2-point centreline -> 4 vertices per ribbon.
  const network = buildStraightRoad({ lanes: 1, lengthM: 50 });
  const segments: SegmentDescriptor[] = [
    { index: 0, laneId: "l0:0", linkId: "l0", startS: 0, endS: 25, freeFlowSpeedMps: 10 },
    { index: 1, laneId: "l0:0", linkId: "l0", startS: 25, endS: 50, freeFlowSpeedMps: 10 },
  ];

  it("builds one merged ribbon, 4 vertices per segment, starting grey and hidden", () => {
    const layer = buildHeatmapLayer(network, segments);
    expect(layer.mesh.visible).toBe(false);
    expect(layer.mesh.geometry.attributes.position?.count).toBe(8);

    const colors = layer.mesh.geometry.attributes.color as THREE.BufferAttribute;
    for (let v = 0; v < 8; v++) {
      expectCloseColor(colorAt(colors, v), HEATMAP_NO_DATA_COLOR as THREE.Color);
    }
  });

  it("setSpeedRatios recolours each segment's own vertex range, indexed by SegmentDescriptor.index", () => {
    const layer = buildHeatmapLayer(network, segments);
    layer.setSpeedRatios(Float32Array.from([1, 0]));

    const colors = layer.mesh.geometry.attributes.color as THREE.BufferAttribute;
    for (let v = 0; v < 4; v++) expectCloseColor(colorAt(colors, v), speedRatioToColor(1));
    for (let v = 4; v < 8; v++) expectCloseColor(colorAt(colors, v), speedRatioToColor(0));
  });

  it("setVisible toggles the mesh without touching colours", () => {
    const layer = buildHeatmapLayer(network, segments);
    layer.setVisible(true);
    expect(layer.mesh.visible).toBe(true);
    layer.setVisible(false);
    expect(layer.mesh.visible).toBe(false);
  });

  it("a shorter/undefined speedRatio array repaints every segment grey", () => {
    const layer = buildHeatmapLayer(network, segments);
    layer.setSpeedRatios(Float32Array.from([1, 0]));
    layer.setSpeedRatios(undefined);
    const colors = layer.mesh.geometry.attributes.color as THREE.BufferAttribute;
    for (let v = 0; v < 8; v++) {
      expectCloseColor(colorAt(colors, v), HEATMAP_NO_DATA_COLOR as THREE.Color);
    }
  });
});
