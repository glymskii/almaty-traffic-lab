import type { Lane, Network } from "@atl/contracts";
import * as THREE from "three";
import { laneAxis, slicePolyline } from "../geometry/lane-geometry.ts";
import { buildRibbonGeometry, mergeRibbons } from "./ribbon.ts";
import { mustGet } from "./util.ts";

/** Muted, low-poly palette (docs/DECISIONS.md D13). */
const SURFACE_COLORS: Record<Lane["kind"], THREE.Color> = {
  general: new THREE.Color("#4b4d52"),
  turn_pocket: new THREE.Color("#55575c"),
  bus: new THREE.Color("#8a5a3c"),
};

const SURFACE_HEIGHT_M = 0;
const CONNECTOR_HEIGHT_M = 0.02;
const CONNECTOR_WIDTH_M = 1;

/** One mesh per lane surface class (general / bus / turn_pocket), each a single merged BufferGeometry with vertex colors. */
export function buildRoadSurfaces(network: Network): THREE.Group {
  const lanesById = new Map(network.lanes.map((lane) => [lane.id, lane]));
  const geometriesByKind: Record<Lane["kind"], THREE.BufferGeometry[]> = {
    general: [],
    turn_pocket: [],
    bus: [],
  };

  for (const link of network.links) {
    const laneCount = link.laneIds.length;
    for (let index = 0; index < laneCount; index++) {
      const laneId = link.laneIds[index] as string;
      const lane = mustGet(lanesById, laneId, "lane");
      const axis = laneAxis(link.geometry, index, laneCount, lane.widthM);
      const segment = slicePolyline(axis, lane.startS, lane.endS);
      const geometry = buildRibbonGeometry(
        segment,
        lane.widthM,
        SURFACE_HEIGHT_M,
        SURFACE_COLORS[lane.kind],
      );
      geometriesByKind[lane.kind].push(geometry);
    }
  }

  // DoubleSide: these are paper-thin ground decals always viewed from above, so it isn't worth
  // getting every quad's winding order exactly right for single-sided culling.
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const group = new THREE.Group();
  group.name = "road-surfaces";
  for (const kind of Object.keys(geometriesByKind) as Lane["kind"][]) {
    const merged = mergeRibbons(geometriesByKind[kind]);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `surface-${kind}`;
    group.add(mesh);
  }
  return group;
}

/** Thin, translucent ribbons along every connector's precomputed geometry - shows which movements are possible through each node. */
export function buildConnectorRibbons(network: Network): THREE.Mesh | null {
  const geometries = network.connectors.map((connector) =>
    buildRibbonGeometry(connector.geometry, CONNECTOR_WIDTH_M, CONNECTOR_HEIGHT_M),
  );
  const merged = mergeRibbons(geometries);
  if (!merged) return null;
  const material = new THREE.MeshBasicMaterial({
    color: "#f2c744",
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = "connectors";
  mesh.renderOrder = 10;
  return mesh;
}
