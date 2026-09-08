import type { Crosswalk, Network, Point2 } from "@atl/contracts";
import { normalizeVec, perpRight } from "../geometry/angles.ts";
import { round, roundPolyline } from "../geometry/polyline.ts";
import type { AssumptionCollector } from "./assumptions.ts";
import type { Arm, NodeMovements } from "./movements.ts";
import type { OsmGraph } from "./osm-graph.ts";

/** An OSM `highway=crossing` node this close to a network node puts zebras on that node. */
export const CROSSING_ATTACH_M = 30;
/** Clearance between the node centre and the stop line, on top of half the crossing carriageway. */
export const CROSSWALK_CLEARANCE_M = 2;
/** Upper bound on how far from the node centre a zebra may be pushed. */
const CROSSWALK_MAX_OFFSET_M = 15;

export interface CrosswalkInput {
  net: Network;
  byNode: ReadonlyMap<string, NodeMovements>;
  graph: OsmGraph;
  assumptions: AssumptionCollector;
}

/**
 * A zebra across every arm of a signalized node and of any node with an OSM `highway=crossing`
 * within 30 m (card T-07 §5). Signalized zebras stay without a group until T-08 assigns one;
 * zebras that come from a crossing tag are unsignalized for good.
 */
export function buildCrosswalks(input: CrosswalkInput): Crosswalk[] {
  const { net, byNode, graph, assumptions } = input;
  const wanted = new Set<string>();
  for (const node of net.nodes) if (node.kind === "signalized") wanted.add(node.id);
  for (const nodeId of nodesNearCrossings(net, graph)) wanted.add(nodeId);
  return buildCrosswalksForNodes(net, byNode, [...wanted].sort(), assumptions);
}

/**
 * The per-node half of `buildCrosswalks`, split out so a scenario override (T-24) can refresh the
 * zebras of just the nodes whose connectors it just rebuilt, without needing the OSM graph that
 * decides *which* nodes get zebras in the first place (that decision doesn't change when a link's
 * lane count or bus lane changes, only the connectors the zebra must list do).
 */
export function buildCrosswalksForNodes(
  net: Network,
  byNode: ReadonlyMap<string, NodeMovements>,
  nodeIds: readonly string[],
  assumptions: AssumptionCollector,
): Crosswalk[] {
  const connectorsByLink = new Map<string, string[]>();
  const laneLink = new Map(net.lanes.map((l) => [l.id, l.linkId] as const));
  for (const c of net.connectors) {
    const linkId = laneLink.get(c.toLaneId);
    if (linkId === undefined) continue;
    const list = connectorsByLink.get(linkId);
    if (list === undefined) connectorsByLink.set(linkId, [c.id]);
    else list.push(c.id);
  }
  const connectorById = new Map(net.connectors.map((c) => [c.id, c] as const));

  const crosswalks: Crosswalk[] = [];
  for (const nodeId of nodeIds) {
    const movements = byNode.get(nodeId);
    if (movements === undefined) continue;
    movements.arms.forEach((arm, index) => {
      const geometry = crosswalkGeometry(arm, movements);
      if (geometry === undefined) return;
      const connectorIds: string[] = [];
      for (const link of arm.outLinks)
        for (const id of connectorsByLink.get(link.id) ?? []) {
          const connector = connectorById.get(id);
          if (connector?.viaNodeId === nodeId) connectorIds.push(id);
        }
      connectorIds.sort();
      const id = `${nodeId}.x${index}`;
      for (const cid of connectorIds) connectorById.get(cid)?.crosswalkIds.push(id);
      crosswalks.push({
        id,
        nodeId,
        geometry: roundPolyline(geometry.points),
        lengthM: round(geometry.lengthM),
        connectorIds,
        provenance: { geometry: "default" },
      });
      assumptions.add("crosswalk_default", id);
    });
  }
  for (const c of net.connectors) c.crosswalkIds.sort();
  return crosswalks;
}

/** A zebra sits across the arm just outside the junction box, as wide as both carriageways. */
function crosswalkGeometry(
  arm: Arm,
  movements: NodeMovements,
): { points: [Point2, Point2]; lengthM: number } | undefined {
  const lengthM = arm.widthM;
  if (lengthM <= 0) return undefined;
  let boxHalfWidth = 0;
  for (const other of movements.arms)
    if (other !== arm) boxHalfWidth = Math.max(boxHalfWidth, other.widthM / 2);
  const offset = Math.min(boxHalfWidth + CROSSWALK_CLEARANCE_M, CROSSWALK_MAX_OFFSET_M);
  const dir = normalizeVec(arm.direction);
  const perp = perpRight(dir);
  const anchors: Point2[] = [];
  for (const link of arm.inLinks) anchors.push(link.geometry[link.geometry.length - 1] as Point2);
  for (const link of arm.outLinks) anchors.push(link.geometry[0] as Point2);
  if (anchors.length === 0) return undefined;
  let cx = 0;
  let cy = 0;
  for (const p of anchors) {
    cx += p[0];
    cy += p[1];
  }
  cx = cx / anchors.length + dir[0] * offset;
  cy = cy / anchors.length + dir[1] * offset;
  const half = lengthM / 2;
  return {
    points: [
      [cx - perp[0] * half, cy - perp[1] * half],
      [cx + perp[0] * half, cy + perp[1] * half],
    ],
    lengthM,
  };
}

/** Network nodes within `CROSSING_ATTACH_M` of an OSM node tagged `highway=crossing`. */
function nodesNearCrossings(net: Network, graph: OsmGraph): string[] {
  const crossings: Point2[] = [];
  for (const osmId of [...graph.nodeTags.keys()].sort((a, b) => a - b)) {
    if (graph.nodeTags.get(osmId)?.highway !== "crossing") continue;
    const point = graph.nodePoints.get(osmId);
    if (point !== undefined) crossings.push(point);
  }
  if (crossings.length === 0) return [];
  const out: string[] = [];
  for (const node of net.nodes) {
    if (node.kind === "gate" || node.kind === "dead_end") continue;
    for (const p of crossings) {
      if (Math.hypot(p[0] - node.x, p[1] - node.y) <= CROSSING_ATTACH_M) {
        out.push(node.id);
        break;
      }
    }
  }
  return out;
}
