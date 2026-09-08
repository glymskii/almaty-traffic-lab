import type { Point2 } from "@atl/contracts";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { offsetPolyline } from "../geometry/lane-geometry.ts";

/**
 * THREE.BufferGeometry builders shared by roads.ts and markings.ts. Local (x, y) map coordinates
 * become THREE (x, height, -y) here (see CLAUDE.md, "Координаты и единицы") - this is the only
 * place that conversion happens, everything upstream stays in plane 2D metres.
 */

function toVec3(p: Point2, heightM: number): [number, number, number] {
  return [p[0], heightM, -p[1]];
}

function setFlatColor(
  geometry: THREE.BufferGeometry,
  vertexCount: number,
  color: THREE.Color,
): void {
  const colors = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) colors.set([color.r, color.g, color.b], i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/**
 * A flat quad-strip mesh geometry following `centerline`, `widthM` wide, at a small height above
 * the ground. `uv.v` runs 0..1 along the strip's own arc length (for repeating textures); `uv.u`
 * is 0 on the left edge, 1 on the right. Optionally tinted with a single flat vertex color.
 */
export function buildRibbonGeometry(
  centerline: readonly Point2[],
  widthM: number,
  heightM: number,
  color?: THREE.Color,
): THREE.BufferGeometry {
  const left = offsetPolyline(centerline, -widthM / 2);
  const right = offsetPolyline(centerline, widthM / 2);
  const n = centerline.length;
  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  let arcLength = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const a = centerline[i - 1] as Point2;
      const b = centerline[i] as Point2;
      arcLength += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    positions.set(toVec3(left[i] as Point2, heightM), i * 6);
    positions.set(toVec3(right[i] as Point2, heightM), i * 6 + 3);
    uvs.set([0, arcLength, 1, arcLength], i * 4);
  }
  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  if (color) setFlatColor(geometry, n * 2, color);
  return geometry;
}

/** A flat rectangle, `widthM` across `forward` x `depthM` along it, centred on `center`. */
export function buildQuadGeometry(
  center: Point2,
  widthM: number,
  depthM: number,
  forward: Point2,
  heightM: number,
  color?: THREE.Color,
): THREE.BufferGeometry {
  const right: Point2 = [forward[1], -forward[0]];
  const corners: Point2[] = [
    [-widthM / 2, -depthM / 2],
    [widthM / 2, -depthM / 2],
    [widthM / 2, depthM / 2],
    [-widthM / 2, depthM / 2],
  ];
  const positions = new Float32Array(4 * 3);
  for (let i = 0; i < 4; i++) {
    const [lx, ly] = corners[i] as Point2;
    const wx = center[0] + lx * right[0] + ly * forward[0];
    const wy = center[1] + lx * right[1] + ly * forward[1];
    positions.set(toVec3([wx, wy], heightM), i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
  );
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  geometry.computeVertexNormals();
  if (color) setFlatColor(geometry, 4, color);
  return geometry;
}

/** A flat isoceles triangle: apex `lengthM` ahead of `center` along `forward`, `widthM` at the base. */
export function buildTriangleGeometry(
  center: Point2,
  widthM: number,
  lengthM: number,
  forward: Point2,
  heightM: number,
  color?: THREE.Color,
): THREE.BufferGeometry {
  const right: Point2 = [forward[1], -forward[0]];
  const local: Point2[] = [
    [-widthM / 2, -lengthM / 2],
    [widthM / 2, -lengthM / 2],
    [0, lengthM / 2],
  ];
  const positions = new Float32Array(3 * 3);
  for (let i = 0; i < 3; i++) {
    const [lx, ly] = local[i] as Point2;
    const wx = center[0] + lx * right[0] + ly * forward[0];
    const wy = center[1] + lx * right[1] + ly * forward[1];
    positions.set(toVec3([wx, wy], heightM), i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
  geometry.setIndex([0, 2, 1]);
  geometry.computeVertexNormals();
  if (color) setFlatColor(geometry, 3, color);
  return geometry;
}

/** Merge many same-shaped geometries (position + uv + optional color) into one, for a single draw call per surface class. */
export function mergeRibbons(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  const merged = mergeGeometries(geometries, false);
  if (!merged) throw new Error("mergeRibbons: geometries have incompatible attributes");
  return merged;
}
