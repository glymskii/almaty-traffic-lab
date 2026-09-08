import type { Network, SegmentDescriptor } from "@atl/contracts";
import * as THREE from "three";
import { laneAxis, slicePolyline } from "../geometry/lane-geometry.ts";
import { buildRibbonGeometry, mergeRibbons } from "./ribbon.ts";
import { mustGet } from "./util.ts";

/**
 * Speed heat-map overlay (docs/tasks/T-25 п.1). Per the T-05 review notes: the base road surface
 * (`roads.ts`'s `surface-*` meshes) is coloured once per lane and is not cut into segments, so this
 * builds a *separate* thin layer, one ribbon per `SegmentDescriptor`, using the same
 * `slicePolyline`/`laneAxis`/`buildRibbonGeometry`/`mergeRibbons` primitives `roads.ts` uses for the
 * surface itself - `roads.ts` is not touched. The whole layer is one merged mesh (one draw call);
 * `setSpeedRatios` rewrites its vertex colours in place from a `MetricsFrame.speedRatio`-shaped
 * array, so repainting on every metrics tick never rebuilds geometry.
 *
 * Only two modes exist (docs/tasks/T-25 card): the windowed `speedRatio` MetricsFrame already
 * carries (nominally a 5-minute mean, `config.metrics.windowS`) - there is no separate "instant"
 * speed computed anywhere in the worker - and off. `setVisible` toggles between them.
 */

const HEATMAP_HEIGHT_M = 0.05; // above the road surface (0m) and the connector overlay (0.02m, roads.ts) - avoids z-fighting.

/** Grey stand-in for a segment `speedRatio` hasn't reached yet (e.g. before the first metrics frame). */
export const HEATMAP_NO_DATA_COLOR: Readonly<THREE.Color> = new THREE.Color("#8a8d93");

/**
 * Muted green -> yellow -> red (docs/tasks/T-25 context: "приглушённые, читаемые на сером
 * полотне"), keyed by speedRatio (mean speed / free-flow speed, 0..1). Ratio 1 (free flow) is
 * green; 0 (stopped) is red.
 */
const HEATMAP_STOPS: readonly { ratio: number; color: THREE.Color }[] = [
  { ratio: 0, color: new THREE.Color("#b0473f") },
  { ratio: 0.3, color: new THREE.Color("#c98a3f") },
  { ratio: 0.6, color: new THREE.Color("#c7b23f") },
  { ratio: 1, color: new THREE.Color("#4f8f5c") },
];

/** Maps a windowed `speedRatio` to a heat-map colour; `undefined`/`NaN` (no data yet) comes back grey. */
export function speedRatioToColor(
  ratio: number | undefined,
  out: THREE.Color = new THREE.Color(),
): THREE.Color {
  if (ratio === undefined || Number.isNaN(ratio)) return out.copy(HEATMAP_NO_DATA_COLOR);
  const clamped = Math.min(1, Math.max(0, ratio));
  for (let i = 1; i < HEATMAP_STOPS.length; i++) {
    const a = HEATMAP_STOPS[i - 1] as (typeof HEATMAP_STOPS)[number];
    const b = HEATMAP_STOPS[i] as (typeof HEATMAP_STOPS)[number];
    if (clamped <= b.ratio) {
      const span = b.ratio - a.ratio;
      const t = span > 0 ? (clamped - a.ratio) / span : 0;
      return out.copy(a.color).lerp(b.color, t);
    }
  }
  const last = HEATMAP_STOPS[HEATMAP_STOPS.length - 1] as (typeof HEATMAP_STOPS)[number];
  return out.copy(last.color);
}

interface VertexRange {
  start: number;
  count: number;
}

export interface HeatmapLayer {
  readonly mesh: THREE.Mesh;
  /**
   * Recolours every segment. `speedRatio` is indexed exactly like `MetricsFrame.speedRatio`
   * (`array[segment.index]`); a missing/undefined entry (including a `speedRatio` shorter than the
   * segment count) paints that segment grey via `speedRatioToColor`'s `undefined` branch.
   */
  setSpeedRatios(speedRatio: Float32Array | undefined): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const scratchColor = new THREE.Color();

/**
 * Builds the merged overlay mesh for every segment in `segments` (`SimHandle.stats.segments`,
 * `InitStats.segments` - the sim-core `Simulation.segments()` order, fixed at init). Starts grey
 * and hidden; the caller drives colour/visibility.
 */
export function buildHeatmapLayer(
  network: Network,
  segments: readonly SegmentDescriptor[],
): HeatmapLayer {
  const lanesById = new Map(network.lanes.map((lane) => [lane.id, lane]));
  const linksById = new Map(network.links.map((link) => [link.id, link]));

  const geometries: THREE.BufferGeometry[] = [];
  const ranges: VertexRange[] = [];
  let vertexCursor = 0;
  for (const seg of segments) {
    const lane = mustGet(lanesById, seg.laneId, "lane");
    const link = mustGet(linksById, seg.linkId, "link");
    const laneIndex = link.laneIds.indexOf(seg.laneId);
    const axis = laneAxis(link.geometry, laneIndex, link.laneIds.length, lane.widthM);
    const centerline = slicePolyline(axis, seg.startS, seg.endS);
    const geometry = buildRibbonGeometry(
      centerline,
      lane.widthM,
      HEATMAP_HEIGHT_M,
      HEATMAP_NO_DATA_COLOR as THREE.Color,
    );
    const vertexCount = centerline.length * 2;
    ranges[seg.index] = { start: vertexCursor, count: vertexCount };
    vertexCursor += vertexCount;
    geometries.push(geometry);
  }

  const merged = mergeRibbons(geometries) ?? new THREE.BufferGeometry();
  // MeshBasic (not Lambert, unlike roads.ts's surfaces): the heat-map colour must read exactly as
  // mapped, not tinted by scene lighting/time-of-day. depthWrite off + a higher renderOrder keeps
  // it flicker-free just above the road surface and connector overlay.
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = "heatmap";
  mesh.renderOrder = 5;
  mesh.visible = false;

  const colorAttr = merged.getAttribute("color") as THREE.BufferAttribute | undefined;
  const colorArray = colorAttr?.array as Float32Array | undefined;

  return {
    mesh,
    setSpeedRatios(speedRatio) {
      if (!colorAttr || !colorArray) return;
      for (let index = 0; index < ranges.length; index++) {
        const range = ranges[index];
        if (!range) continue;
        speedRatioToColor(speedRatio?.[index], scratchColor);
        for (let v = 0; v < range.count; v++) {
          const base = (range.start + v) * 3;
          colorArray[base] = scratchColor.r;
          colorArray[base + 1] = scratchColor.g;
          colorArray[base + 2] = scratchColor.b;
        }
      }
      colorAttr.needsUpdate = true;
    },
    setVisible(visible) {
      mesh.visible = visible;
    },
    dispose() {
      merged.dispose();
      material.dispose();
    },
  };
}
