import type { Link, NetworkNode, Provenance } from "@atl/contracts";
import { useEffect, useState } from "react";
import * as THREE from "three";
import { ru } from "../i18n/ru.ts";
import { groundPointFromEvent, pickNodeOrLink } from "../scene/picking.ts";
import { useStore } from "../state/store.ts";

/**
 * Hover tooltip (docs/tasks/T-23 п.7): raycasts the cursor onto the ground plane, finds the
 * nearest node/link in local metres (`../scene/picking.ts`, shared with T-24's click-to-select)
 * and shows name/class/lanes/speed/provenance for it.
 */

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
    const anchor = new THREE.Vector3();
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

      const ground = groundPointFromEvent(
        event,
        dom,
        viewport.engine.camera,
        raycaster,
        groundPlane,
      );
      if (ground === undefined) {
        setData(undefined);
        return;
      }
      const hit = pickNodeOrLink(viewport.network, ground[0], ground[1]);
      if (hit?.kind === "node") {
        const { title, rows } = nodeTooltip(hit.node);
        setData({ ...worldToScreen(hit.node.x, hit.node.y), title, rows });
        return;
      }
      if (hit?.kind === "link") {
        const { title, rows } = linkTooltip(hit.link);
        setData({ ...worldToScreen(ground[0], ground[1]), title, rows });
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
