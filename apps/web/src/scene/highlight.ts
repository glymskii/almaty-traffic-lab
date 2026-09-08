import type { Network } from "@atl/contracts";
import * as THREE from "three";
import { buildRibbonGeometry, mergeRibbons } from "./ribbon.ts";

/**
 * Outlines the links and signalized nodes a scenario touched (docs/tasks/T-24 п.4: "Подсветка
 * изменённых объектов на карте (контур)"). Rather than tracking the scenario's own override list,
 * this reads `provenance` straight off the compiled network: every field `applyOverrides`
 * (`@atl/map-data`) changes is marked `"manual"` there, so "what changed" is exactly "what a fresh
 * compile from OSM would never mark that way" - no separate bookkeeping to keep in sync.
 */

const HIGHLIGHT_COLOR = new THREE.Color("#ffb020");
const LINK_HEIGHT_M = 0.06;
const LINK_MARGIN_M = 0.6;
const NODE_HALF_SIZE_M = 9;
const NODE_FRAME_WIDTH_M = 0.8;
const NODE_HEIGHT_M = 0.08;

function isLinkOverridden(link: Network["links"][number]): boolean {
  const p = link.provenance;
  return p.laneIds === "manual" || p.speedLimitKph === "manual";
}

function isControllerOverridden(controller: Network["signalControllers"][number]): boolean {
  const p = controller.provenance;
  return p.phases === "manual" || p.leftTurnModes === "manual" || p.offsetS === "manual";
}

function linkWidthM(network: Network, link: Network["links"][number]): number {
  const byId = new Map(network.lanes.map((l) => [l.id, l.widthM] as const));
  let width = 0;
  for (const id of link.laneIds) width += byId.get(id) ?? 0;
  return width;
}

/** A square contour centred on (x, y): four thin ribbon segments, not a filled outline. */
function squareFrame(x: number, y: number): THREE.BufferGeometry[] {
  const r = NODE_HALF_SIZE_M;
  const corners: [number, number][] = [
    [x - r, y - r],
    [x + r, y - r],
    [x + r, y + r],
    [x - r, y + r],
    [x - r, y - r],
  ];
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const a = corners[i];
    const b = corners[i + 1];
    if (a === undefined || b === undefined) continue;
    out.push(buildRibbonGeometry([a, b], NODE_FRAME_WIDTH_M, NODE_HEIGHT_M, HIGHLIGHT_COLOR));
  }
  return out;
}

/** One merged translucent mesh outlining every manually-overridden link and signalized node. */
export function buildOverrideHighlights(network: Network): THREE.Mesh | null {
  const geometries: THREE.BufferGeometry[] = [];

  for (const link of network.links) {
    if (!isLinkOverridden(link)) continue;
    geometries.push(
      buildRibbonGeometry(
        link.geometry,
        linkWidthM(network, link) + LINK_MARGIN_M * 2,
        LINK_HEIGHT_M,
        HIGHLIGHT_COLOR,
      ),
    );
  }

  const nodeById = new Map(network.nodes.map((n) => [n.id, n] as const));
  for (const controller of network.signalControllers) {
    if (!isControllerOverridden(controller)) continue;
    const node = nodeById.get(controller.nodeId);
    if (node === undefined) continue;
    geometries.push(...squareFrame(node.x, node.y));
  }

  const merged = mergeRibbons(geometries);
  if (!merged) return null;
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = "scenario-highlights";
  return mesh;
}
