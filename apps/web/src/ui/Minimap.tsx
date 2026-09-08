import type { Network, SegmentDescriptor } from "@atl/contracts";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ru } from "../i18n/ru.ts";
import { speedRatioToColor } from "../scene/heatmap.ts";
import type { ViewportHandle } from "../Viewport.tsx";

/**
 * Canvas-2D minimap (docs/tasks/T-25 п.5): every link tinted by its segments' mean `speedRatio`, a
 * quadrilateral for the camera's current ground footprint, click-to-fly. Reads `segmentsRef`/
 * `speedRatioRef` mutable refs rather than props so a metrics tick (up to ~10/s, docs/scene/heatmap.ts)
 * never triggers a React re-render - only the redraw timer below touches the canvas.
 */

const CANVAS_WIDTH = 220;
const CANVAS_HEIGHT = 220;
const REDRAW_INTERVAL_MS = 200;
const BOUNDS_PADDING_M = 40;
const CLICK_FOCUS_RADIUS_M = 100;

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function networkBounds(network: Network): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of network.nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
  }
  if (!Number.isFinite(minX)) return { minX: -100, maxX: 100, minY: -100, maxY: 100 };
  return {
    minX: minX - BOUNDS_PADDING_M,
    maxX: maxX + BOUNDS_PADDING_M,
    minY: minY - BOUNDS_PADDING_M,
    maxY: maxY + BOUNDS_PADDING_M,
  };
}

/** North (+y, map convention) draws "up" on the minimap, matching the overview camera's look-down orientation (scene/camera.ts). */
function worldToCanvas(bounds: Bounds, x: number, y: number): [number, number] {
  const spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-6, bounds.maxY - bounds.minY);
  return [
    ((x - bounds.minX) / spanX) * CANVAS_WIDTH,
    CANVAS_HEIGHT - ((y - bounds.minY) / spanY) * CANVAS_HEIGHT,
  ];
}

function canvasToWorld(bounds: Bounds, cx: number, cy: number): [number, number] {
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  return [
    bounds.minX + (cx / CANVAS_WIDTH) * spanX,
    bounds.minY + (1 - cy / CANVAS_HEIGHT) * spanY,
  ];
}

/** segment indices per link, built once per network/segments pair - segment composition never changes mid-run. */
function segmentsByLink(segments: readonly SegmentDescriptor[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const seg of segments) {
    const list = map.get(seg.linkId);
    if (list) list.push(seg.index);
    else map.set(seg.linkId, [seg.index]);
  }
  return map;
}

function meanSpeedRatio(
  indices: readonly number[],
  speedRatio: Float32Array | undefined,
): number | undefined {
  if (!speedRatio) return undefined;
  let sum = 0;
  let count = 0;
  for (const i of indices) {
    const v = speedRatio[i];
    if (v === undefined || Number.isNaN(v)) continue;
    sum += v;
    count++;
  }
  return count > 0 ? sum / count : undefined;
}

const scratchRaycaster = new THREE.Raycaster();
const scratchPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const scratchHit = new THREE.Vector3();
const NDC_CORNERS: readonly [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** The camera's ground footprint, as (x, y) map-metre corners; a corner looking above the horizon is dropped (rare - only at extreme tilts). */
function cameraFootprint(camera: THREE.Camera): [number, number][] {
  const corners: [number, number][] = [];
  for (const [ndcX, ndcY] of NDC_CORNERS) {
    scratchRaycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    if (scratchRaycaster.ray.intersectPlane(scratchPlane, scratchHit)) {
      corners.push([scratchHit.x, -scratchHit.z]);
    }
  }
  return corners;
}

function draw(
  canvas: HTMLCanvasElement,
  network: Network,
  bounds: Bounds,
  linkSegments: Map<string, number[]>,
  speedRatio: Float32Array | undefined,
  camera: THREE.Camera,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  for (const link of network.links) {
    const indices = linkSegments.get(link.id);
    const ratio = indices ? meanSpeedRatio(indices, speedRatio) : undefined;
    ctx.strokeStyle = speedRatioToColor(ratio).getStyle();
    ctx.lineWidth = 2;
    ctx.beginPath();
    link.geometry.forEach((p, i) => {
      const [cx, cy] = worldToCanvas(bounds, p[0], p[1]);
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();
  }

  const footprint = cameraFootprint(camera);
  if (footprint.length >= 3) {
    ctx.strokeStyle = "#3a7bd5";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    footprint.forEach(([x, y], i) => {
      const [cx, cy] = worldToCanvas(bounds, x, y);
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.closePath();
    ctx.stroke();
  }
}

export interface MinimapProps {
  viewport: ViewportHandle | undefined;
  /** Live, mutated in place by the same subscription that feeds the heat-map (BottlenecksTab) - see this component's header comment. */
  segmentsRef: { current: readonly SegmentDescriptor[] | undefined };
  speedRatioRef: { current: Float32Array | undefined };
}

/** Click-to-fly + link speed colouring; redraws on a fixed timer rather than the render loop (a minimap doesn't need 60fps). */
export function Minimap({ viewport, segmentsRef, speedRatioRef }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!viewport || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const network = viewport.network;
    const bounds = networkBounds(network);

    let linkSegments = segmentsByLink(segmentsRef.current ?? []);
    let lastSegments = segmentsRef.current;

    const interval = setInterval(() => {
      if (segmentsRef.current !== lastSegments) {
        lastSegments = segmentsRef.current;
        linkSegments = segmentsByLink(lastSegments ?? []);
      }
      draw(canvas, network, bounds, linkSegments, speedRatioRef.current, viewport.engine.camera);
    }, REDRAW_INTERVAL_MS);

    const onClick = (event: MouseEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const cx = ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH;
      const cy = ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
      const [x, y] = canvasToWorld(bounds, cx, cy);
      viewport.rig.focus(x, y, CLICK_FOCUS_RADIUS_M);
    };
    canvas.addEventListener("click", onClick);

    return () => {
      clearInterval(interval);
      canvas.removeEventListener("click", onClick);
    };
    // `segmentsRef`/`speedRatioRef` are stable ref objects (their `.current` is read live inside
    // the timer above, not tracked reactively) - listed only so the effect stays exhaustive.
  }, [viewport, segmentsRef, speedRatioRef]);

  return (
    <div className="minimap">
      <span className="minimap-title">{ru.minimapTitle}</span>
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className="minimap-canvas"
      />
    </div>
  );
}
