import type { Link, Network, NetworkNode, Point2 } from "@atl/contracts";
import * as THREE from "three";

/**
 * Nearest-node/nearest-link picking on the ground plane, shared by the hover tooltip (T-23) and
 * the scenario editor's "click a node/link to edit it" (T-24). A plain nearest-neighbour scan over
 * `network.nodes`/`network.links` rather than a mesh raycast: road surfaces are one big merged
 * geometry per link kind (docs/ARCHITECTURE.md) and carry no per-link identity to hit-test against.
 */

export const NODE_PICK_RADIUS_M = 12;
export const LINK_PICK_RADIUS_M = 6;

export type PickResult = { kind: "node"; node: NetworkNode } | { kind: "link"; link: Link };

function distancePointToSegment(px: number, py: number, a: Point2, b: Point2): number {
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function nearestDistanceOnLink(link: Link, x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < link.geometry.length - 1; i++) {
    const a = link.geometry[i];
    const b = link.geometry[i + 1];
    if (a === undefined || b === undefined) continue;
    const d = distancePointToSegment(x, y, a, b);
    if (d < best) best = d;
  }
  return best;
}

/** Nearest node within `NODE_PICK_RADIUS_M`, else nearest link within `LINK_PICK_RADIUS_M`, else nothing. */
export function pickNodeOrLink(network: Network, x: number, y: number): PickResult | undefined {
  let nearestNode: NetworkNode | undefined;
  let nearestNodeDist = Number.POSITIVE_INFINITY;
  for (const node of network.nodes) {
    const d = Math.hypot(node.x - x, node.y - y);
    if (d < nearestNodeDist) {
      nearestNodeDist = d;
      nearestNode = node;
    }
  }
  if (nearestNode !== undefined && nearestNodeDist <= NODE_PICK_RADIUS_M) {
    return { kind: "node", node: nearestNode };
  }

  let nearestLink: Link | undefined;
  let nearestLinkDist = Number.POSITIVE_INFINITY;
  for (const link of network.links) {
    const d = nearestDistanceOnLink(link, x, y);
    if (d < nearestLinkDist) {
      nearestLinkDist = d;
      nearestLink = link;
    }
  }
  if (nearestLink !== undefined && nearestLinkDist <= LINK_PICK_RADIUS_M) {
    return { kind: "link", link: nearestLink };
  }
  return undefined;
}

/** Ground-plane local (x, y) metres under a mouse/pointer event, or undefined off the horizon. */
export function groundPointFromEvent(
  event: { clientX: number; clientY: number },
  dom: HTMLElement,
  camera: THREE.Camera,
  raycaster: THREE.Raycaster,
  groundPlane: THREE.Plane,
): Point2 | undefined {
  const rect = dom.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(groundPlane, hit)) return undefined;
  return [hit.x, -hit.z];
}
