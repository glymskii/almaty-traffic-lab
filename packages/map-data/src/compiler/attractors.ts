import type { Attractor, Network, Point2 } from "@atl/contracts";
import { round } from "../geometry/polyline.ts";
import type { OsmElement, OsmSnapshot } from "../importer/index.ts";
import type { Projection } from "../projection.ts";
import type { AssumptionCollector } from "./assumptions.ts";
import type { NodeMovements } from "./movements.ts";
import { pickName } from "./osm-graph.ts";
import type { Tags } from "./tags.ts";

type AttractorKind = Attractor["kind"];

/** A POI is attached to the nearest junction no further away than this. */
export const ATTRACTOR_SEARCH_M = 250;
/** Weight of one cul-de-sac, standing in for the yards and driveways behind it. */
export const DEAD_END_WEIGHT = 0.05;

interface PoiRule {
  kind: AttractorKind;
  weight: number;
  matches: (tags: Tags) => boolean;
}

/** Card T-07 §7, in priority order: the first rule that matches wins. */
const POI_RULES: PoiRule[] = [
  { kind: "mall", weight: 3, matches: (t) => t.shop === "mall" },
  {
    kind: "university",
    weight: 2,
    matches: (t) => t.amenity === "university" || t.amenity === "college",
  },
  { kind: "hospital", weight: 1, matches: (t) => t.amenity === "hospital" },
  { kind: "stadium", weight: 1.5, matches: (t) => t.leisure === "stadium" },
  {
    kind: "transport_hub",
    weight: 2,
    matches: (t) => t.railway === "station" || t.public_transport === "station",
  },
  {
    kind: "other",
    weight: 0.5,
    matches: (t) => t.amenity === "theatre" || t.amenity === "cinema",
  },
  { kind: "office", weight: 0.5, matches: (t) => t.office !== undefined },
];

export interface AttractorInput {
  net: Network;
  byNode: ReadonlyMap<string, NodeMovements>;
  snapshot: OsmSnapshot;
  projection: Projection;
  assumptions: AssumptionCollector;
}

const TYPE_PREFIX: Record<OsmElement["type"], string> = { node: "n", way: "w", relation: "r" };

/**
 * Trip ends: POIs from the snapshot attached to the nearest junction (card T-07 §7) and one small
 * residential attractor per cul-de-sac. Positions come from OSM, weights are always assumptions.
 */
export function buildAttractors(input: AttractorInput): Attractor[] {
  const { net, byNode, snapshot, projection, assumptions } = input;
  const junctions = net.nodes.filter((n) => (byNode.get(n.id)?.degree ?? 0) >= 3);
  const attractors: Attractor[] = [];

  for (const el of snapshot.elements) {
    const tags = el.tags;
    if (tags === undefined) continue;
    const rule = POI_RULES.find((r) => r.matches(tags));
    if (rule === undefined) continue;
    const lonLat =
      el.lat !== undefined && el.lon !== undefined
        ? { lat: el.lat, lon: el.lon }
        : el.center !== undefined
          ? { lat: el.center.lat, lon: el.center.lon }
          : undefined;
    if (lonLat === undefined) continue;
    const point = projection.toLocal(lonLat);
    const nodeId = nearestNode(point, junctions, ATTRACTOR_SEARCH_M);
    if (nodeId === undefined) continue;
    const name = pickName(tags);
    const id = `poi.${TYPE_PREFIX[el.type]}${el.id}`;
    attractors.push({
      id,
      ...(name !== undefined ? { name } : {}),
      x: round(point[0]),
      y: round(point[1]),
      nodeId,
      kind: rule.kind,
      weightIn: rule.weight,
      weightOut: rule.weight,
      provenance: { x: "osm", y: "osm", weightIn: "default", weightOut: "default" },
    });
    assumptions.add("attractor_weight_default", id);
  }

  for (const node of net.nodes) {
    if (node.kind !== "dead_end") continue;
    const id = `poi.d${node.id}`;
    attractors.push({
      id,
      ...(node.name !== undefined ? { name: node.name } : {}),
      x: node.x,
      y: node.y,
      nodeId: node.id,
      kind: "residential",
      weightIn: DEAD_END_WEIGHT,
      weightOut: DEAD_END_WEIGHT,
      provenance: { x: "osm", y: "osm", weightIn: "default", weightOut: "default" },
    });
    assumptions.add("attractor_weight_default", id);
  }

  attractors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return attractors;
}

function nearestNode(
  point: Point2,
  candidates: readonly { id: string; x: number; y: number }[],
  maxM: number,
): string | undefined {
  let bestId: string | undefined;
  let bestDist = maxM;
  for (const node of candidates) {
    const d = Math.hypot(node.x - point[0], node.y - point[1]);
    if (d < bestDist || (d === bestDist && bestId !== undefined && node.id < bestId)) {
      bestDist = d;
      bestId = node.id;
    }
  }
  return bestId;
}
