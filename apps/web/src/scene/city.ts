import type { Area, Building, Network, Point2, Polygon } from "@atl/contracts";
import * as THREE from "three";
import { buildRibbonGeometry, mergeRibbons } from "./ribbon.ts";

/**
 * Buildings, parks, water and rivers (docs/tasks/T-27 §2), built once from the compiled `Network`
 * and merged into a handful of meshes (≤ 10 total, well under the card's budget) so the frame rate
 * doesn't depend on block count. `ExtrudeGeometry`/`ShapeGeometry` triangulate every footprint with
 * three's bundled earcut; the map's (x, y) -> three (x, height, -y) convention (CLAUDE.md) is applied
 * by building each shape in the (x, y) plane, extruding/flattening along +z, then `rotateX(-90°)`,
 * which turns (x, y, z) into (x, z, -y) - exactly that mapping, with the extrude/flat axis becoming "up".
 */

/** Parks/water sit a little below the road surface (SURFACE_HEIGHT_M = 0 in roads.ts) but above
 * bare ground (renderer.ts's ground plane is at y = -0.05), so they read as ground cover, not deck. */
const AREA_HEIGHT_M = -0.03;

/** "Два оттенка по высоте" (card §2): buildings at or above this height read as mid/high-rise. */
const BUILDING_HEIGHT_SHADE_THRESHOLD_M = 15;
const BUILDING_LOW_COLOR = new THREE.Color("#9c8a72");
const BUILDING_HIGH_COLOR = new THREE.Color("#7a8494");
const PARK_COLOR = new THREE.Color("#4f6b4a");
const WATER_COLOR = new THREE.Color("#3e6478");

export interface CityLayers {
  buildings: THREE.Group;
  greenery: THREE.Group;
}

/** Signed area via the shoelace formula; positive = counter-clockwise in the (x, y) = (east, north) plane. */
function signedArea(points: readonly Point2[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i] as Point2;
    const [x2, y2] = points[(i + 1) % n] as Point2;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** `THREE.Shape`/earcut triangulate correctly regardless of winding, but a consistent CCW outer
 * ring keeps every footprint's computed face normal pointing the same way (up, not down). */
function toCCW(points: readonly Point2[]): Point2[] {
  return signedArea(points) < 0 ? [...points].reverse() : points.slice();
}

function polygonToShape(polygon: Polygon): THREE.Shape {
  return new THREE.Shape(toCCW(polygon).map(([x, y]) => new THREE.Vector2(x, y)));
}

/** OSM footprints occasionally self-intersect after simplification; earcut can choke on those. One
 * bad polygon should not blank the whole layer, so each build is isolated and merely skipped. */
function pushSafely(
  out: THREE.BufferGeometry[],
  id: string,
  build: () => THREE.BufferGeometry,
): void {
  try {
    out.push(build());
  } catch (err) {
    console.warn(`city.ts: failed to build geometry for ${id}`, err);
  }
}

function buildingGeometry(building: Building): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(polygonToShape(building.footprint), {
    depth: building.heightM,
    bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function areaGeometry(area: Area): THREE.BufferGeometry {
  const geometry = new THREE.ShapeGeometry(polygonToShape(area.polygon));
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, AREA_HEIGHT_M, 0);
  return geometry;
}

/** Merges `geometries` (if any) into one flat-shaded, single-colour mesh named `name`. */
function mergedMesh(
  geometries: THREE.BufferGeometry[],
  color: THREE.Color,
  flatShading: boolean,
  name: string,
): THREE.Mesh | undefined {
  const merged = mergeRibbons(geometries);
  if (!merged) return undefined;
  const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color, flatShading }));
  mesh.name = name;
  return mesh;
}

/** Builds the "Здания" and "Зелень/вода" scene layers (docs/tasks/T-27 §2); either group may be
 * empty (no meshes) when the network carries no such data, e.g. the hand-built demo network. */
export function buildCityLayers(network: Network): CityLayers {
  const lowGeometries: THREE.BufferGeometry[] = [];
  const highGeometries: THREE.BufferGeometry[] = [];
  for (const building of network.buildings) {
    const bucket =
      building.heightM >= BUILDING_HEIGHT_SHADE_THRESHOLD_M ? highGeometries : lowGeometries;
    pushSafely(bucket, building.id, () => buildingGeometry(building));
  }
  const buildings = new THREE.Group();
  buildings.name = "buildings";
  const low = mergedMesh(lowGeometries, BUILDING_LOW_COLOR, true, "buildings-low");
  const high = mergedMesh(highGeometries, BUILDING_HIGH_COLOR, true, "buildings-high");
  if (low) buildings.add(low);
  if (high) buildings.add(high);

  const parkGeometries: THREE.BufferGeometry[] = [];
  const waterGeometries: THREE.BufferGeometry[] = [];
  for (const area of network.areas) {
    if (area.kind !== "park" && area.kind !== "water") continue; // rail/pedestrian: no producer yet
    const bucket = area.kind === "water" ? waterGeometries : parkGeometries;
    pushSafely(bucket, area.id, () => areaGeometry(area));
  }
  const waterwayGeometries: THREE.BufferGeometry[] = [];
  for (const waterway of network.waterways) {
    pushSafely(waterwayGeometries, waterway.id, () =>
      buildRibbonGeometry(waterway.polyline, waterway.widthM, AREA_HEIGHT_M),
    );
  }

  const greenery = new THREE.Group();
  greenery.name = "greenery";
  const park = mergedMesh(parkGeometries, PARK_COLOR, false, "areas-park");
  const water = mergedMesh(waterGeometries, WATER_COLOR, false, "areas-water");
  const waterways = mergedMesh(waterwayGeometries, WATER_COLOR, false, "waterways");
  if (park) greenery.add(park);
  if (water) greenery.add(water);
  if (waterways) greenery.add(waterways);

  return { buildings, greenery };
}
