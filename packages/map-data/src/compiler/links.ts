import {
  type Lane,
  type Link,
  type NetworkNode,
  type Point2,
  polylineLength,
} from "@atl/contracts";
import {
  dedupePolyline,
  offsetPolyline,
  round,
  roundPolyline,
  simplifyPolyline,
} from "../geometry/polyline.ts";
import type { AssumptionCollector } from "./assumptions.ts";
import { buildLanes, type DirectionAttrs, LANE_WIDTH_M } from "./lanes.ts";
import type { Topology } from "./topology.ts";

/** Douglas–Peucker tolerance for link centrelines. */
export const SIMPLIFY_EPSILON_M = 0.5;

/** Vertical position of a link, kept outside the frozen Network contract (card T-02 §3). */
export interface LinkLevel {
  layer: number;
  bridge: boolean;
  tunnel: boolean;
}

export interface BuiltGraph {
  nodes: NetworkNode[];
  links: Link[];
  lanes: Lane[];
  /** Only links that are not at ground level. */
  linkLevels: Record<string, LinkLevel>;
}

/**
 * Topology → nodes, directed links and lanes. Each direction's geometry is the way centreline shifted
 * to the right by half of that direction's carriageway width (one-way streets: no shift).
 */
export function buildLinks(topo: Topology, assumptions: AssumptionCollector): BuiltGraph {
  const nodeKind = new Map(topo.nodes.map((n) => [n.key, n.kind] as const));
  const nodes: NetworkNode[] = topo.nodes.map((n) => ({
    id: n.key,
    x: round(n.x),
    y: round(n.y),
    kind: n.kind,
    ...(n.name !== undefined ? { name: n.name } : {}),
    ...(n.osmNodeId !== undefined ? { osmNodeId: n.osmNodeId } : {}),
    provenance: n.kind === "signalized" ? { kind: "osm" } : {},
  }));

  const links: Link[] = [];
  const lanes: Lane[] = [];
  const linkLevels: Record<string, LinkLevel> = {};

  for (const seg of topo.segments) {
    const raw: Point2[] = seg.vertices.map((v) => [v.x, v.y]);
    const centre = simplifyPolyline(dedupePolyline(raw), SIMPLIFY_EPSILON_M);
    const osmWayIds = [...new Set(seg.parts.map((p) => p.wayId))].sort((a, b) => a - b);
    const { attrs } = seg;

    const emit = (
      suffix: "f" | "b",
      dir: DirectionAttrs,
      fromNodeId: string,
      toNodeId: string,
      centreline: Point2[],
    ) => {
      const id = `${seg.linkBase}_${suffix}`;
      const offset = attrs.oneway ? 0 : (dir.laneCount * LANE_WIDTH_M) / 2;
      const geometry = roundPolyline(offsetPolyline(centreline, offset));
      const lengthM = round(polylineLength(geometry));
      const toNodeKind = nodeKind.get(toNodeId) ?? "junction";
      const linkLanes = buildLanes({
        linkId: id,
        lengthM,
        highwayClass: attrs.highwayClass,
        dir,
        toNodeKind,
        assumptions,
      });
      const link: Link = {
        id,
        fromNodeId,
        toNodeId,
        ...(attrs.name !== undefined ? { name: attrs.name } : {}),
        highwayClass: attrs.highwayClass,
        geometry,
        lengthM,
        speedLimitKph: dir.speedKph,
        laneIds: linkLanes.map((l) => l.id),
        osmWayIds,
        provenance: { speedLimitKph: dir.speedProvenance, laneIds: dir.laneCountProvenance },
      };
      const label = attrs.name !== undefined ? `${id} (${attrs.name})` : id;
      if (dir.speedProvenance === "default") assumptions.add("speed_limit_default", label);
      if (dir.laneCountProvenance === "default") assumptions.add("lane_count_default", label);
      if (attrs.layer !== 0 || attrs.bridge || attrs.tunnel)
        linkLevels[id] = { layer: attrs.layer, bridge: attrs.bridge, tunnel: attrs.tunnel };
      links.push(link);
      lanes.push(...linkLanes);
    };

    emit("f", attrs.forward, seg.fromKey, seg.toKey, centre);
    if (attrs.backward !== undefined)
      emit("b", attrs.backward, seg.toKey, seg.fromKey, [...centre].reverse());
  }
  return { nodes, links, lanes, linkLevels };
}
