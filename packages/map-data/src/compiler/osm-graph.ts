import { type BBox, type HighwayClass, HighwayClassSchema, type Point2 } from "@atl/contracts";
import { clipSegmentToRect, distance, lerp, pointInRect, type Rect } from "../geometry/polyline.ts";
import type { OsmElement, OsmSnapshot } from "../importer/index.ts";
import type { Projection } from "../projection.ts";
import { type DirectionAttrs, parseDirectionAttrs } from "./lanes.ts";
import { type DirectionParseContext, isTruthyTag, type Tags, type Warn } from "./tags.ts";

/** Attributes of a way (or of a merged chain of ways) relevant to link generation. */
export interface WayAttrs {
  highwayClass: HighwayClass;
  name?: string;
  oneway: boolean;
  roundabout: boolean;
  /** Direction of travel along the vertex order. */
  forward: DirectionAttrs;
  /** Opposite direction; absent on one-way streets. */
  backward?: DirectionAttrs;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
}

export interface GraphVertex {
  /** Network node id: `n<osmNodeId>` for OSM nodes, `ng<wayId>_<k>` for boundary gates. */
  key: string;
  x: number;
  y: number;
  osmNodeId?: number;
  /** Position along the way's node list: integer for OSM nodes, fractional for gates. */
  wayPos: number;
}

/** Part of a way inside the bbox, in travel-forward vertex order (oneway=-1 is already reversed). */
export interface WayPiece {
  wayId: number;
  attrs: WayAttrs;
  vertices: GraphVertex[];
  /** Vertex order runs against the OSM way's node order (oneway=-1). */
  wayReversed: boolean;
}

export interface OsmGraph {
  /** Sorted by way id, then by position along the way. */
  pieces: WayPiece[];
  /** Vertices on the bbox boundary (kind: gate). */
  gateKeys: Set<string>;
  /** Vertices tagged highway=traffic_signals. */
  signalKeys: Set<string>;
  /** Tags of every OSM node present as an element (for later stages: crossings, stops). */
  nodeTags: Map<number, Tags>;
  /** Local metric position of every tagged OSM node (T-07 places zebras from `highway=crossing`). */
  nodePoints: Map<number, Point2>;
  /** The bbox in local metres. */
  rect: Rect;
}

const ROAD_CLASSES: ReadonlySet<string> = new Set(
  HighwayClassSchema.options.filter((c) => c !== "service"),
);
/** A gate closer than this to an OSM node is snapped onto the node. */
const GATE_SNAP_M = 0.05;

export function nodeKey(osmNodeId: number): string {
  return `n${osmNodeId}`;
}

export function localRect(bbox: BBox, proj: Projection): Rect {
  const sw = proj.toLocal({ lat: bbox.south, lon: bbox.west });
  const ne = proj.toLocal({ lat: bbox.north, lon: bbox.east });
  return { xmin: sw[0], ymin: sw[1], xmax: ne[0], ymax: ne[1] };
}

export interface ParsedWay {
  attrs: WayAttrs;
  /** oneway=-1: node order must be reversed so that vertex order = travel direction. */
  reversed: boolean;
}

/** Tags → WayAttrs; undefined for ways that are not part of the driveable network. */
export function parseWayAttrs(tags: Tags, wayId: number, warn: Warn): ParsedWay | undefined {
  const cls = tags.highway;
  if (cls === undefined || !ROAD_CLASSES.has(cls)) return undefined;
  const highwayClass = HighwayClassSchema.parse(cls);
  if (isTruthyTag(tags.area)) return undefined;

  const roundabout = tags.junction === "roundabout" || tags.junction === "circular";
  const { oneway, reversed } = parseOneway(tags, roundabout, wayId, warn);
  const ctx: DirectionParseContext = { wayId, highwayClass, oneway, wayReversed: reversed, warn };
  const forward = parseDirectionAttrs(tags, "forward", ctx);
  const backward = oneway ? undefined : parseDirectionAttrs(tags, "backward", ctx);
  const name = pickName(tags);
  const layerRaw = tags.layer !== undefined ? Number.parseInt(tags.layer, 10) : 0;
  const attrs: WayAttrs = {
    highwayClass,
    ...(name !== undefined ? { name } : {}),
    oneway,
    roundabout,
    forward,
    ...(backward !== undefined ? { backward } : {}),
    layer: Number.isFinite(layerRaw) ? layerRaw : 0,
    bridge: isTruthyTag(tags.bridge),
    tunnel: isTruthyTag(tags.tunnel),
  };
  return { attrs, reversed };
}

/** `name:ru` is preferred over `name` (card T-02); empty names are dropped. */
export function pickName(tags: Tags): string | undefined {
  const ru = tags["name:ru"]?.trim();
  if (ru) return ru;
  const name = tags.name?.trim();
  return name ? name : undefined;
}

function parseOneway(
  tags: Tags,
  roundabout: boolean,
  wayId: number,
  warn: Warn,
): { oneway: boolean; reversed: boolean } {
  const raw = tags.oneway;
  switch (raw) {
    case undefined:
    case "no":
    case "false":
    case "0":
      return { oneway: roundabout, reversed: false };
    case "yes":
    case "true":
    case "1":
      return { oneway: true, reversed: false };
    case "-1":
    case "reverse":
      return { oneway: true, reversed: true };
    default:
      warn(`way ${wayId}: unknown oneway="${raw}"; treated as two-way`);
      return { oneway: roundabout, reversed: false };
  }
}

/**
 * Selects driveable ways (HighwayClassSchema minus `service`), projects them, clips them by the bbox
 * (crossings become gate vertices) and keeps their OSM node identity for the topology stage.
 */
export function buildOsmGraph(
  snapshot: OsmSnapshot,
  bbox: BBox,
  proj: Projection,
  warn: Warn,
): OsmGraph {
  const rect = localRect(bbox, proj);
  const coords = new Map<number, Point2>();
  const nodeTags = new Map<number, Tags>();
  const ways: OsmElement[] = [];
  for (const el of snapshot.elements) {
    if (el.type === "node") {
      if (el.lat !== undefined && el.lon !== undefined)
        coords.set(el.id, proj.toLocal({ lat: el.lat, lon: el.lon }));
      if (el.tags !== undefined) nodeTags.set(el.id, el.tags);
    } else if (el.type === "way") ways.push(el);
  }
  ways.sort((a, b) => a.id - b.id);
  // Overpass `out geom` ships node coordinates inline with each way.
  for (const w of ways) {
    if (w.nodes === undefined || w.geometry === undefined) continue;
    for (let i = 0; i < w.nodes.length; i++) {
      const id = w.nodes[i];
      const g = w.geometry[i];
      if (id !== undefined && g !== undefined && !coords.has(id)) coords.set(id, proj.toLocal(g));
    }
  }

  const pieces: WayPiece[] = [];
  const gateKeys = new Set<string>();
  for (const w of ways) {
    const parsed = parseWayAttrs(w.tags ?? {}, w.id, warn);
    if (parsed === undefined) continue;
    const ids = w.nodes ? [...w.nodes] : [];
    if (parsed.reversed) ids.reverse();
    if (ids.length < 2) {
      warn(`way ${w.id}: fewer than two nodes; skipped`);
      continue;
    }
    const pts: Point2[] = [];
    let missing: number | undefined;
    for (const id of ids) {
      const p = coords.get(id);
      if (p === undefined) {
        missing = id;
        break;
      }
      pts.push(p);
    }
    if (missing !== undefined) {
      warn(`way ${w.id}: node ${missing} has no coordinates in the snapshot; way skipped`);
      continue;
    }
    pieces.push(...clipWay(w.id, parsed.attrs, parsed.reversed, ids, pts, rect, gateKeys));
  }

  const signalKeys = new Set<string>();
  for (const piece of pieces) {
    for (const v of piece.vertices) {
      if (v.osmNodeId === undefined) continue;
      if (nodeTags.get(v.osmNodeId)?.highway === "traffic_signals") signalKeys.add(v.key);
    }
  }
  const nodePoints = new Map<number, Point2>();
  for (const id of nodeTags.keys()) {
    const p = coords.get(id);
    if (p !== undefined) nodePoints.set(id, p);
  }
  return { pieces, gateKeys, signalKeys, nodeTags, nodePoints, rect };
}

/** Splits a way into the parts inside the rectangle; each boundary crossing yields a gate vertex. */
function clipWay(
  wayId: number,
  attrs: WayAttrs,
  wayReversed: boolean,
  nodeIds: number[],
  pts: Point2[],
  rect: Rect,
  gateKeys: Set<string>,
): WayPiece[] {
  const pieces: WayPiece[] = [];
  let current: GraphVertex[] | undefined;
  let gateSeq = 0;
  const osmVertex = (i: number): GraphVertex => {
    const p = pts[i] as Point2;
    const id = nodeIds[i] as number;
    return { key: nodeKey(id), x: p[0], y: p[1], osmNodeId: id, wayPos: i };
  };
  const gateVertex = (p: Point2, wayPos: number): GraphVertex => {
    const key = `ng${wayId}_${gateSeq}`;
    gateSeq += 1;
    gateKeys.add(key);
    return { key, x: p[0], y: p[1], wayPos };
  };
  const close = () => {
    if (current !== undefined && current.length >= 2)
      pieces.push({ wayId, attrs, vertices: current, wayReversed });
    current = undefined;
  };

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i] as Point2;
    const b = pts[i + 1] as Point2;
    const insideA = pointInRect(a, rect);
    const insideB = pointInRect(b, rect);
    if (insideA && insideB) {
      if (current === undefined) current = [osmVertex(i)];
      current.push(osmVertex(i + 1));
      continue;
    }
    const t = clipSegmentToRect(a, b, rect);
    if (t === undefined) {
      close();
      continue;
    }
    const [t0, t1] = t;
    if (insideA) {
      // Leaving the bbox.
      if (current === undefined) current = [osmVertex(i)];
      const exit = lerp(a, b, t1);
      if (distance(exit, a) < GATE_SNAP_M) gateKeys.add(nodeKey(nodeIds[i] as number));
      else current.push(gateVertex(exit, i + t1));
      close();
    } else if (insideB) {
      // Entering the bbox.
      const entry = lerp(a, b, t0);
      current = [];
      if (distance(entry, b) < GATE_SNAP_M) gateKeys.add(nodeKey(nodeIds[i + 1] as number));
      else current.push(gateVertex(entry, i + t0));
      current.push(osmVertex(i + 1));
    } else {
      // Both ends outside, the segment cuts through a corner of the bbox.
      if (t1 - t0 <= 1e-9) continue;
      const p0 = lerp(a, b, t0);
      const p1 = lerp(a, b, t1);
      if (distance(p0, p1) < GATE_SNAP_M) continue;
      pieces.push({
        wayId,
        attrs,
        vertices: [gateVertex(p0, i + t0), gateVertex(p1, i + t1)],
        wayReversed,
      });
    }
  }
  close();
  return pieces;
}
