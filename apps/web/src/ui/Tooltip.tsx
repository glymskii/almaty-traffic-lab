import type { Link, NetworkNode, Point2, Provenance } from "@atl/contracts";
import { useEffect, useState } from "react";
import * as THREE from "three";
import { ru } from "../i18n/ru.ts";
import { useStore } from "../state/store.ts";

/**
 * Hover tooltip (docs/tasks/T-23 п.7): raycasts the cursor onto the ground plane, finds the
 * nearest node/link in local metres and shows name/class/lanes/speed/provenance for it. Picking
 * is a plain nearest-neighbour scan over `network.nodes`/`network.links` (a few hundred/thousand
 * entries on the small square) rather than a mesh raycast, since the road surfaces are one big
 * merged geometry per docs/ARCHITECTURE.md and don't carry per-link identity.
 */

const NODE_PICK_RADIUS_M = 12;
const LINK_PICK_RADIUS_M = 6;
const MOVE_THROTTLE_MS = 80;

interface TooltipRow {
  label: string;
  value: string;
}
interface TooltipData {
  leftPx: number;
  topPx: number;
  title: string;
  rows: TooltipRow[];
}

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

function originLabel(provenance: Record<string, Provenance>, key: string): string {
  const value = provenance[key];
  return value === undefined ? ru.hudNoData : ru.provenance[value];
}

function nodeTooltip(node: NetworkNode): { title: string; rows: TooltipRow[] } {
  const rows: TooltipRow[] = [{ label: ru.tooltipClass, value: ru.nodeKinds[node.kind] }];
  if (node.provenance.kind !== undefined) {
    rows.push({ label: ru.tooltipOrigin, value: originLabel(node.provenance, "kind") });
  }
  return { title: node.name ?? `${ru.tooltipNode} ${node.id}`, rows };
}

function linkTooltip(link: Link): { title: string; rows: TooltipRow[] } {
  return {
    title: link.name ?? ru.tooltipUnnamed,
    rows: [
      { label: ru.tooltipClass, value: ru.highwayClasses[link.highwayClass] },
      { label: ru.tooltipLanes, value: String(link.laneIds.length) },
      { label: ru.tooltipSpeed, value: ru.kphLabel(link.speedLimitKph) },
      {
        label: ru.tooltipOrigin,
        value: `${ru.tooltipSpeed}: ${originLabel(link.provenance, "speedLimitKph")}, ${ru.tooltipLanes}: ${originLabel(link.provenance, "laneIds")}`,
      },
    ],
  };
}

/** Floating panel that follows the hovered node/link; renders nothing while the scene isn't ready or nothing is hovered. */
export function Tooltip() {
  const viewport = useStore((s) => s.viewport);
  const [data, setData] = useState<TooltipData | undefined>(undefined);

  useEffect(() => {
    setData(undefined);
    if (!viewport) return;
    const dom = viewport.engine.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitPoint = new THREE.Vector3();
    const anchor = new THREE.Vector3();
    const ndc = new THREE.Vector2();
    let lastMoveMs = 0;

    const worldToScreen = (x: number, y: number): { leftPx: number; topPx: number } => {
      anchor.set(x, 0, -y).project(viewport.engine.camera);
      const rect = dom.getBoundingClientRect();
      return {
        leftPx: rect.left + ((anchor.x + 1) / 2) * rect.width,
        topPx: rect.top + ((1 - anchor.y) / 2) * rect.height,
      };
    };

    const onMove = (event: MouseEvent): void => {
      const nowMs = event.timeStamp;
      if (nowMs - lastMoveMs < MOVE_THROTTLE_MS) return;
      lastMoveMs = nowMs;

      const rect = dom.getBoundingClientRect();
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, viewport.engine.camera);
      if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) {
        setData(undefined);
        return;
      }
      const x = hitPoint.x;
      const y = -hitPoint.z;

      let nearestNode: NetworkNode | undefined;
      let nearestNodeDist = Number.POSITIVE_INFINITY;
      for (const node of viewport.network.nodes) {
        const d = Math.hypot(node.x - x, node.y - y);
        if (d < nearestNodeDist) {
          nearestNodeDist = d;
          nearestNode = node;
        }
      }
      if (nearestNode !== undefined && nearestNodeDist <= NODE_PICK_RADIUS_M) {
        const { title, rows } = nodeTooltip(nearestNode);
        setData({ ...worldToScreen(nearestNode.x, nearestNode.y), title, rows });
        return;
      }

      let nearestLink: Link | undefined;
      let nearestLinkDist = Number.POSITIVE_INFINITY;
      for (const link of viewport.network.links) {
        const d = nearestDistanceOnLink(link, x, y);
        if (d < nearestLinkDist) {
          nearestLinkDist = d;
          nearestLink = link;
        }
      }
      if (nearestLink !== undefined && nearestLinkDist <= LINK_PICK_RADIUS_M) {
        const { title, rows } = linkTooltip(nearestLink);
        setData({ ...worldToScreen(x, y), title, rows });
        return;
      }

      setData(undefined);
    };

    const onLeave = (): void => setData(undefined);
    dom.addEventListener("mousemove", onMove);
    dom.addEventListener("mouseleave", onLeave);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      dom.removeEventListener("mouseleave", onLeave);
    };
  }, [viewport]);

  if (!data) return null;
  return (
    <div className="tooltip" style={{ left: data.leftPx, top: data.topPx }}>
      <div className="tooltip-title">{data.title}</div>
      {data.rows.map((row) => (
        <div key={row.label} className="tooltip-row">
          <span className="tooltip-row-label">{row.label}</span>
          <span className="tooltip-row-value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
