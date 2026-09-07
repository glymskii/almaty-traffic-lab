import type { HighwayClass, NodeKind } from "@atl/contracts";
import { distance } from "../geometry/polyline.ts";
import type { DirectionAttrs } from "./lanes.ts";
import type { GraphVertex, OsmGraph, WayAttrs, WayPiece } from "./osm-graph.ts";
import type { Warn } from "./tags.ts";

/** A traffic_signals node this close (along the road) to a junction is the junction's signal. */
export const SIGNAL_COLLAPSE_M = 15;
/** Segments shorter than this (duplicate OSM nodes) are dropped. */
const MIN_SEGMENT_M = 0.01;

/** Major first; used for node names ("A × B") and by later stages for priority. */
export const HIGHWAY_CLASS_RANK: Record<HighwayClass, number> = {
  trunk: 0,
  trunk_link: 1,
  primary: 2,
  primary_link: 3,
  secondary: 4,
  secondary_link: 5,
  tertiary: 6,
  tertiary_link: 7,
  unclassified: 8,
  residential: 9,
  living_street: 10,
  service: 11,
};

export interface TopoVertex {
  key: string;
  x: number;
  y: number;
  osmNodeId?: number;
}

/** A stretch of one OSM way inside a segment; `reversed` when the segment runs against the way's node order. */
export interface SegmentPart {
  wayId: number;
  wayPos: number;
  reversed: boolean;
}

export interface TopoSegment {
  /** From node to node; the direction of `attrs.forward`. */
  vertices: TopoVertex[];
  attrs: WayAttrs;
  parts: SegmentPart[];
  fromKey: string;
  toKey: string;
  /** `w<wayId>_<seq>`; links append `_f` / `_b`. */
  linkBase: string;
  lengthM: number;
}

export interface TopoNode {
  key: string;
  x: number;
  y: number;
  osmNodeId?: number;
  kind: NodeKind;
  name?: string;
  degree: number;
}

export interface Topology {
  /** Sorted by key. */
  nodes: TopoNode[];
  /** Sorted by link base id. */
  segments: TopoSegment[];
  /** traffic_signals nodes folded into a nearby junction. */
  signalsCollapsed: number;
}

interface Seg {
  id: number;
  vertices: TopoVertex[];
  attrs: WayAttrs;
  parts: SegmentPart[];
  lengthM: number;
}

const segFrom = (s: Seg): string => (s.vertices[0] as TopoVertex).key;
const segTo = (s: Seg): string => (s.vertices[s.vertices.length - 1] as TopoVertex).key;

function pathLength(vertices: readonly TopoVertex[]): number {
  let len = 0;
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1] as TopoVertex;
    const b = vertices[i] as TopoVertex;
    len += distance([a.x, a.y], [b.x, b.y]);
  }
  return len;
}

function swapDirections(attrs: WayAttrs): WayAttrs {
  const backward = attrs.backward;
  if (backward === undefined) throw new Error("cannot reverse a one-way segment");
  return { ...attrs, forward: backward, backward: attrs.forward };
}

function reverseSeg(s: Seg): Seg {
  return {
    id: s.id,
    vertices: [...s.vertices].reverse(),
    attrs: swapDirections(s.attrs),
    parts: s.parts.map((p) => ({ ...p, reversed: !p.reversed })),
    lengthM: s.lengthM,
  };
}

function directionSignature(d: DirectionAttrs): unknown[] {
  return [
    d.laneCount,
    d.laneCountProvenance,
    d.speedKph,
    d.speedProvenance,
    d.turns ?? null,
    d.busLane,
    d.busLaneMisplaced,
  ];
}

/** Two segments merge across a degree-2 node only when everything that shapes their links is equal. */
export function attrsSignature(a: WayAttrs): string {
  return JSON.stringify([
    a.highwayClass,
    a.name ?? "",
    a.oneway,
    a.roundabout,
    a.layer,
    a.bridge,
    a.tunnel,
    directionSignature(a.forward),
    a.backward ? directionSignature(a.backward) : null,
  ]);
}

function primaryPart(parts: readonly SegmentPart[]): SegmentPart {
  let best = parts[0] as SegmentPart;
  for (const p of parts) {
    if (p.wayId < best.wayId || (p.wayId === best.wayId && p.wayPos < best.wayPos)) best = p;
  }
  return best;
}

/**
 * Way pieces → node/segment graph:
 * 1. split at piece ends, at vertices shared by ≥ 2 pieces, at gates and at traffic_signals;
 * 2. fold traffic_signals nodes within 15 m of a junction into that junction;
 * 3. merge segments across degree-2 nodes when their attributes are identical;
 * 4. classify nodes (gate > signalized > junction > dead_end > bend) and name them "A × B".
 */
export function buildTopology(graph: OsmGraph, warn: Warn): Topology {
  const registry = new Map<string, TopoVertex>();
  const occurrences = new Map<string, number>();
  for (const piece of graph.pieces) {
    for (const v of piece.vertices) {
      occurrences.set(v.key, (occurrences.get(v.key) ?? 0) + 1);
      if (!registry.has(v.key)) {
        registry.set(v.key, {
          key: v.key,
          x: v.x,
          y: v.y,
          ...(v.osmNodeId !== undefined ? { osmNodeId: v.osmNodeId } : {}),
        });
      }
    }
  }

  const splitKeys = new Set<string>();
  for (const piece of graph.pieces) {
    splitKeys.add((piece.vertices[0] as GraphVertex).key);
    splitKeys.add((piece.vertices[piece.vertices.length - 1] as GraphVertex).key);
  }
  for (const [key, n] of occurrences) if (n >= 2) splitKeys.add(key);
  for (const key of graph.gateKeys) splitKeys.add(key);
  for (const key of graph.signalKeys) splitKeys.add(key);

  // 1. Raw segments.
  const segs = new Map<number, Seg>();
  let nextId = 0;
  const addSegment = (vertices: GraphVertex[], piece: WayPiece) => {
    const topo = vertices.map((v) => registry.get(v.key) as TopoVertex);
    const lengthM = pathLength(topo);
    if (lengthM < MIN_SEGMENT_M) {
      warn(
        `way ${piece.wayId}: zero-length segment between ${topo[0]?.key} and ${topo[topo.length - 1]?.key}; dropped`,
      );
      return;
    }
    const first = vertices[0] as GraphVertex;
    const last = vertices[vertices.length - 1] as GraphVertex;
    if (first.key === last.key) {
      // A closed loop with a single split point: cut it in the middle so no link starts where it ends.
      if (vertices.length < 3) {
        warn(`way ${piece.wayId}: degenerate loop at ${first.key}; dropped`);
        return;
      }
      const mid = Math.floor((vertices.length - 1) / 2);
      addSegment(vertices.slice(0, mid + 1), piece);
      addSegment(vertices.slice(mid), piece);
      return;
    }
    const id = nextId;
    nextId += 1;
    segs.set(id, {
      id,
      vertices: topo,
      attrs: piece.attrs,
      parts: [{ wayId: piece.wayId, wayPos: first.wayPos, reversed: false }],
      lengthM,
    });
  };
  for (const piece of graph.pieces) {
    let current: GraphVertex[] = [];
    for (let j = 0; j < piece.vertices.length; j++) {
      const v = piece.vertices[j] as GraphVertex;
      const prev = current[current.length - 1];
      if (prev !== undefined && prev.key === v.key) continue;
      current.push(v);
      const isLast = j === piece.vertices.length - 1;
      if (current.length >= 2 && (splitKeys.has(v.key) || isLast)) {
        addSegment(current, piece);
        current = [v];
      }
    }
  }

  // Incidence: node key -> segment ids.
  const incident = new Map<string, Set<number>>();
  const addIncident = (key: string, id: number) => {
    let set = incident.get(key);
    if (set === undefined) {
      set = new Set();
      incident.set(key, set);
    }
    set.add(id);
  };
  for (const s of segs.values()) {
    addIncident(segFrom(s), s.id);
    addIncident(segTo(s), s.id);
  }
  const degreeOf = (key: string): number => incident.get(key)?.size ?? 0;

  // 2. Traffic signals: junctions keep the tag; degree-2 signal nodes fold into a junction within 15 m.
  const signalized = new Set<string>();
  const collapsed = new Set<string>();
  const signalKeys = [...graph.signalKeys].filter((k) => incident.has(k)).sort();
  for (const key of signalKeys) if (degreeOf(key) >= 3) signalized.add(key);
  const pending = signalKeys.filter((k) => degreeOf(k) === 2);
  const nearestJunction = (key: string): string | undefined => {
    let best: { key: string; dist: number } | undefined;
    const startSegs = [...(incident.get(key) ?? [])].sort((a, b) => a - b);
    for (const startId of startSegs) {
      let dist = 0;
      let prevKey = key;
      let segId = startId;
      for (let steps = 0; steps < 64; steps++) {
        const s = segs.get(segId);
        if (s === undefined) break;
        dist += s.lengthM;
        if (dist > SIGNAL_COLLAPSE_M) break;
        const nextKey = segFrom(s) === prevKey ? segTo(s) : segFrom(s);
        const deg = degreeOf(nextKey);
        if (graph.gateKeys.has(nextKey)) break;
        if (deg >= 3) {
          if (best === undefined || dist < best.dist || (dist === best.dist && nextKey < best.key))
            best = { key: nextKey, dist };
          break;
        }
        const isUnresolvedSignal = graph.signalKeys.has(nextKey) && !collapsed.has(nextKey);
        if (deg !== 2 || isUnresolvedSignal) break;
        const other = [...(incident.get(nextKey) ?? [])].find((id) => id !== segId);
        if (other === undefined) break;
        prevKey = nextKey;
        segId = other;
      }
    }
    return best?.key;
  };
  for (let pass = 0; pass < 3; pass++) {
    for (const key of pending) {
      if (collapsed.has(key)) continue;
      const target = nearestJunction(key);
      if (target !== undefined) {
        signalized.add(target);
        collapsed.add(key);
      }
    }
  }
  for (const key of pending) if (!collapsed.has(key)) signalized.add(key);

  // 3. Merge across degree-2 nodes.
  const kept = new Set<string>([...graph.gateKeys, ...signalized]);
  const signatureCache = new WeakMap<WayAttrs, string>();
  const signatureOf = (attrs: WayAttrs): string => {
    let sig = signatureCache.get(attrs);
    if (sig === undefined) {
      sig = attrsSignature(attrs);
      signatureCache.set(attrs, sig);
    }
    return sig;
  };
  const replaceIncident = (key: string, oldId: number, newId: number) => {
    const set = incident.get(key);
    if (set === undefined) return;
    set.delete(oldId);
    set.add(newId);
  };
  for (const key of [...incident.keys()].sort()) {
    if (kept.has(key)) continue;
    const inc = incident.get(key);
    if (inc === undefined || inc.size !== 2) continue;
    const [ia, ib] = [...inc].sort((x, y) => x - y) as [number, number];
    const a = segs.get(ia);
    const b = segs.get(ib);
    if (a === undefined || b === undefined) continue;
    let first = a;
    if (segTo(first) !== key) {
      if (first.attrs.oneway) continue;
      first = reverseSeg(first);
    }
    let second = b;
    if (segFrom(second) !== key) {
      if (second.attrs.oneway) continue;
      second = reverseSeg(second);
    }
    if (segFrom(first) === segTo(second)) continue;
    if (signatureOf(first.attrs) !== signatureOf(second.attrs)) continue;
    const merged: Seg = {
      id: nextId,
      vertices: [...first.vertices, ...second.vertices.slice(1)],
      attrs: first.attrs,
      parts: [...first.parts, ...second.parts],
      lengthM: first.lengthM + second.lengthM,
    };
    nextId += 1;
    segs.delete(ia);
    segs.delete(ib);
    segs.set(merged.id, merged);
    incident.delete(key);
    replaceIncident(segFrom(merged), ia, merged.id);
    replaceIncident(segTo(merged), ib, merged.id);
  }

  // 4. Orientation and ids: forward = node order of the primary (lowest-id) OSM way.
  const oriented: Seg[] = [];
  for (const s of [...segs.values()]) {
    const primary = primaryPart(s.parts);
    oriented.push(!s.attrs.oneway && primary.reversed ? reverseSeg(s) : s);
  }
  const withPrimary = oriented.map((s) => ({ s, primary: primaryPart(s.parts) }));
  withPrimary.sort(
    (x, y) => x.primary.wayId - y.primary.wayId || x.primary.wayPos - y.primary.wayPos,
  );
  const segments: TopoSegment[] = [];
  let lastWayId = -1;
  let seq = 0;
  for (const { s, primary } of withPrimary) {
    seq = primary.wayId === lastWayId ? seq + 1 : 0;
    lastWayId = primary.wayId;
    segments.push({
      vertices: s.vertices,
      attrs: s.attrs,
      parts: s.parts,
      fromKey: segFrom(s),
      toKey: segTo(s),
      linkBase: `w${primary.wayId}_${seq}`,
      lengthM: s.lengthM,
    });
  }

  // 5. Nodes.
  const namesByNode = new Map<string, { rank: number; name: string }[]>();
  const pushName = (key: string, attrs: WayAttrs) => {
    if (attrs.name === undefined) return;
    let list = namesByNode.get(key);
    if (list === undefined) {
      list = [];
      namesByNode.set(key, list);
    }
    list.push({ rank: HIGHWAY_CLASS_RANK[attrs.highwayClass], name: attrs.name });
  };
  for (const s of segments) {
    pushName(s.fromKey, s.attrs);
    pushName(s.toKey, s.attrs);
  }
  const nodes: TopoNode[] = [];
  for (const key of [...incident.keys()].sort()) {
    const degree = degreeOf(key);
    if (degree === 0) continue;
    const v = registry.get(key) as TopoVertex;
    let kind: NodeKind;
    if (graph.gateKeys.has(key)) kind = "gate";
    else if (signalized.has(key) && degree >= 2) kind = "signalized";
    else if (degree >= 3) kind = "junction";
    else if (degree === 1) kind = "dead_end";
    else kind = "bend";
    if (signalized.has(key) && degree === 1)
      warn(`node ${key}: traffic_signals on a dead end; kept as dead_end`);
    const name = nodeName(namesByNode.get(key));
    nodes.push({
      key,
      x: v.x,
      y: v.y,
      ...(v.osmNodeId !== undefined ? { osmNodeId: v.osmNodeId } : {}),
      kind,
      ...(name !== undefined ? { name } : {}),
      degree,
    });
  }

  return { nodes, segments, signalsCollapsed: collapsed.size };
}

/** "A × B": distinct street names, major class first, then alphabetical. */
function nodeName(entries: { rank: number; name: string }[] | undefined): string | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const sorted = [...entries].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, "ru"));
  const names: string[] = [];
  for (const e of sorted) if (!names.includes(e.name)) names.push(e.name);
  return names.join(" × ");
}
