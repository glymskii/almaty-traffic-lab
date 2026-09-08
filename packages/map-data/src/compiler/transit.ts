import type { BusRoute, BusStop, Link, Point2, Provenance } from "@atl/contracts";
import { perpRight } from "../geometry/angles.ts";
import { round } from "../geometry/polyline.ts";
import type { OsmElement } from "../importer/index.ts";
import type { WayLinks } from "./links.ts";
import { pickName } from "./osm-graph.ts";
import type { CompileContext } from "./stages.ts";
import { isTruthyTag, type Tags, type Warn } from "./tags.ts";

/** A bus/platform node this close to, and to the right of, a route link is attached to it (card §3). */
export const STOP_ATTACH_M = 30;
/** Headways when the relation tags neither `interval:peak` nor `interval` (decision D10). */
export const DEFAULT_HEADWAY_PEAK_S = 480;
export const DEFAULT_HEADWAY_OFFPEAK_S = 900;

/** Way-member roles that mark a stop/platform position, not a piece of the driven path. */
const SKIP_MEMBER_ROLES = new Set(["platform", "stop"]);

interface RelationMember {
  type: string;
  ref: number;
  role: string;
}

/** One resolved way, in its own node order or against it, that survived compilation (card §1). */
interface DirCandidate {
  linkIds: string[];
  entryNodeId: string;
  exitNodeId: string;
}

interface RoutePiece {
  linkIds: string[];
  lengthM: number;
}

interface HeadwayResolution {
  seconds: number;
  provenance: Provenance;
}

/** Both travel directions of a way that reached the compiled network, keyed by direction. */
function wayCandidates(
  wayLinks: WayLinks | undefined,
  linkById: ReadonlyMap<string, Link>,
): { forward?: DirCandidate; backward?: DirCandidate } {
  if (wayLinks === undefined) return {};
  const build = (ids: readonly string[]): DirCandidate | undefined => {
    if (ids.length === 0) return undefined;
    const first = linkById.get(ids[0] as string);
    const last = linkById.get(ids[ids.length - 1] as string);
    if (first === undefined || last === undefined) return undefined;
    return { linkIds: [...ids], entryNodeId: first.fromNodeId, exitNodeId: last.toNodeId };
  };
  const forward = build(wayLinks.forward);
  const backward = build(wayLinks.backward);
  return {
    ...(forward !== undefined ? { forward } : {}),
    ...(backward !== undefined ? { backward } : {}),
  };
}

/** Unordered node-pair key: real Almaty data maps the same corridor as several parallel ways
 * (extra lanes, a bus lane traced separately), which a relation lists back to back. */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Splits one relation's ordered way members into contiguous, direction-resolved pieces (card §1).
 * A way outside the bbox or not a road has no entry in `wayLinks`; a way that does not connect to
 * the running chain (wrong direction, missing segment) also ends the piece. Either way, the next
 * usable member starts a new piece. Direction is picked by matching the running end node first
 * (`role` only disambiguates the first way of a new piece, when both directions are open). A way
 * that only restates the edge just travelled (a parallel mapping of the same corridor) is skipped
 * rather than treated as a gap or as genuine progress.
 */
function buildPieces(
  members: readonly RelationMember[],
  wayLinksAll: Readonly<Record<number, WayLinks>>,
  linkById: ReadonlyMap<string, Link>,
): { pieces: RoutePiece[]; hadGap: boolean } {
  const pieces: RoutePiece[] = [];
  let current: string[] | undefined;
  let currentExit: string | undefined;
  let lastEdge: string | undefined;
  let hadGap = false;

  const closeCurrent = () => {
    if (current !== undefined) {
      let lengthM = 0;
      for (const id of current) lengthM += linkById.get(id)?.lengthM ?? 0;
      pieces.push({ linkIds: current, lengthM: round(lengthM) });
    }
    current = undefined;
    currentExit = undefined;
    lastEdge = undefined;
  };

  for (const member of members) {
    if (member.type !== "way" || SKIP_MEMBER_ROLES.has(member.role)) continue;
    const cand = wayCandidates(wayLinksAll[member.ref], linkById);
    const anyDir = cand.forward ?? cand.backward;
    if (anyDir === undefined) {
      if (current !== undefined) hadGap = true;
      closeCurrent();
      continue;
    }
    if (
      currentExit !== undefined &&
      lastEdge !== undefined &&
      edgeKey(anyDir.entryNodeId, anyDir.exitNodeId) === lastEdge
    ) {
      continue;
    }
    let chosen: DirCandidate | undefined;
    if (currentExit !== undefined) {
      if (cand.forward?.entryNodeId === currentExit) chosen = cand.forward;
      else if (cand.backward?.entryNodeId === currentExit) chosen = cand.backward;
    }
    if (chosen === undefined) {
      if (current !== undefined) {
        hadGap = true;
        closeCurrent();
      }
      if (member.role === "forward" && cand.forward !== undefined) chosen = cand.forward;
      else if (member.role === "backward" && cand.backward !== undefined) chosen = cand.backward;
      else chosen = cand.forward ?? cand.backward;
    }
    if (chosen === undefined) continue;
    current = current === undefined ? [...chosen.linkIds] : [...current, ...chosen.linkIds];
    currentExit = chosen.exitNodeId;
    lastEdge = edgeKey(chosen.entryNodeId, chosen.exitNodeId);
  }
  closeCurrent();
  return { pieces, hadGap };
}

/** The longest piece with at least two links (card §1); undefined discards the whole route. */
function pickLongestPiece(pieces: readonly RoutePiece[]): RoutePiece | undefined {
  let best: RoutePiece | undefined;
  for (const piece of pieces) {
    if (piece.linkIds.length < 2) continue;
    if (best === undefined || piece.lengthM > best.lengthM) best = piece;
  }
  return best;
}

/** Leading number of an `interval`/`interval:peak` tag, ignoring the unit ("20 минут", "10 min"). */
export function parseIntervalMinutes(raw: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(raw);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return n > 0 ? n : undefined;
}

function resolveHeadwayS(
  raw: string | undefined,
  defaultS: number,
  warn: Warn,
  relationId: number,
  tagName: string,
): HeadwayResolution {
  if (raw !== undefined) {
    const minutes = parseIntervalMinutes(raw);
    if (minutes !== undefined) return { seconds: Math.round(minutes * 60), provenance: "osm" };
    warn(`relation ${relationId}: cannot interpret ${tagName}="${raw}"; using the default`);
  }
  return { seconds: defaultS, provenance: "default" };
}

function routeRelations(ctx: CompileContext): OsmElement[] {
  return ctx.opts.snapshot.elements
    .filter(
      (el) =>
        el.type === "relation" && (el.tags?.route === "bus" || el.tags?.route === "trolleybus"),
    )
    .sort((a, b) => a.id - b.id);
}

/**
 * Every compiled link that belongs to a way any bus/trolleybus relation drives over, in either
 * direction. Wider than a single route's (truncated) `linkIds`: a stop sits on the street a route
 * is tagged along even where the piece that street is part of was not the longest inside the bbox.
 */
function transitLinkIds(
  relations: readonly OsmElement[],
  wayLinksAll: Readonly<Record<number, WayLinks>>,
): Set<string> {
  const ids = new Set<string>();
  for (const rel of relations) {
    for (const member of (rel.members ?? []) as RelationMember[]) {
      if (member.type !== "way" || SKIP_MEMBER_ROLES.has(member.role)) continue;
      const wayLinks = wayLinksAll[member.ref];
      if (wayLinks === undefined) continue;
      for (const id of wayLinks.forward) ids.add(id);
      for (const id of wayLinks.backward) ids.add(id);
    }
  }
  return ids;
}

/**
 * Compiler stage "transit" (T-17): `route=bus|trolleybus` relations become `BusRoute`s over the
 * compiled link graph, and `highway=bus_stop` / `public_transport=platform[bus=yes]` nodes become
 * `BusStop`s attached to whichever route link passes closest on their right (card §1-4).
 */
export function runTransit(ctx: CompileContext): void {
  const net = ctx.network;
  const linkById = new Map(net.links.map((l) => [l.id, l] as const));
  const relations = routeRelations(ctx);

  let truncated = 0;
  let discarded = 0;
  const routes: BusRoute[] = [];

  for (const rel of relations) {
    const tags: Tags = rel.tags ?? {};
    const members = (rel.members ?? []) as RelationMember[];
    const { pieces, hadGap } = buildPieces(members, ctx.wayLinks, linkById);
    const kept = pickLongestPiece(pieces);
    if (kept === undefined) {
      discarded += 1;
      continue;
    }
    const first = linkById.get(kept.linkIds[0] as string);
    const last = linkById.get(kept.linkIds[kept.linkIds.length - 1] as string);
    if (first === undefined || last === undefined) {
      discarded += 1;
      continue;
    }
    if (hadGap || pieces.length > 1) truncated += 1;

    const id = `route.r${rel.id}`;
    const peak = resolveHeadwayS(
      tags["interval:peak"],
      DEFAULT_HEADWAY_PEAK_S,
      ctx.warn,
      rel.id,
      "interval:peak",
    );
    const offpeak = resolveHeadwayS(
      tags.interval,
      DEFAULT_HEADWAY_OFFPEAK_S,
      ctx.warn,
      rel.id,
      "interval",
    );
    const name = pickName(tags);
    routes.push({
      id,
      ref: tags.ref ?? String(rel.id),
      ...(name !== undefined ? { name } : {}),
      kind: tags.route === "trolleybus" ? "trolleybus" : "bus",
      linkIds: kept.linkIds,
      stopIds: [],
      headwayPeakS: peak.seconds,
      headwayOffpeakS: offpeak.seconds,
      entryNodeId: first.fromNodeId,
      exitNodeId: last.toNodeId,
      osmRelationId: rel.id,
      provenance: { headwayPeakS: peak.provenance, headwayOffpeakS: offpeak.provenance },
    });
    if (peak.provenance === "default") ctx.assumptions.add("bus_headway_peak_default", id);
    if (offpeak.provenance === "default") ctx.assumptions.add("bus_headway_offpeak_default", id);
  }
  routes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const stops = buildStops(ctx, transitLinkIds(relations, ctx.wayLinks), linkById);
  attachStopsToRoutes(routes, stops);

  net.busRoutes = routes;
  net.busStops = stops;

  // Stay silent on a bbox with no transit data at all (most synthetic test fixtures).
  if (relations.length > 0) {
    ctx.warn(
      `transit: ${relations.length} route relation(s), ${routes.length} compiled ` +
        `(${truncated} truncated to their longest piece), ${discarded} discarded (fewer than 2 links inside the bbox)`,
    );
  }
}

/** Every route's `stopIds`: every stop on one of its links, sorted for determinism. */
function attachStopsToRoutes(routes: BusRoute[], stops: readonly BusStop[]): void {
  const stopsByLink = new Map<string, string[]>();
  for (const stop of stops) {
    const list = stopsByLink.get(stop.linkId);
    if (list === undefined) stopsByLink.set(stop.linkId, [stop.id]);
    else list.push(stop.id);
  }
  for (const route of routes) {
    const ids = new Set<string>();
    for (const linkId of route.linkIds)
      for (const stopId of stopsByLink.get(linkId) ?? []) ids.add(stopId);
    route.stopIds = [...ids].sort();
  }
}

function isStopNodeTags(tags: Tags | undefined): boolean {
  if (tags === undefined) return false;
  if (tags.highway === "bus_stop") return true;
  return tags.public_transport === "platform" && tags.bus === "yes";
}

interface PolylineHit {
  distM: number;
  sM: number;
  /** > 0: `pt` is to the right of travel at the nearest point (decision: stops sit on the right). */
  side: number;
}

/** Nearest point on `pts` to `pt`: Euclidean distance, arc-length `s`, and which side `pt` is on. */
function projectOntoPolyline(pt: Point2, pts: readonly Point2[]): PolylineHit | undefined {
  let best: PolylineHit | undefined;
  let sBefore = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i] as Point2;
    const b = pts[i + 1] as Point2;
    const segX = b[0] - a[0];
    const segY = b[1] - a[1];
    const segLen = Math.hypot(segX, segY);
    if (segLen < 1e-9) continue;
    const dirX = segX / segLen;
    const dirY = segY / segLen;
    const t = Math.max(0, Math.min(segLen, (pt[0] - a[0]) * dirX + (pt[1] - a[1]) * dirY));
    const dx = pt[0] - (a[0] + dirX * t);
    const dy = pt[1] - (a[1] + dirY * t);
    const distM = Math.hypot(dx, dy);
    if (best === undefined || distM < best.distM) {
      const right = perpRight([dirX, dirY]);
      best = { distM, sM: sBefore + t, side: dx * right[0] + dy * right[1] };
    }
    sBefore += segLen;
  }
  return best;
}

/** Nearest route link that passes `pt` on its right within `STOP_ATTACH_M`. */
function nearestRouteLink(
  pt: Point2,
  links: readonly Link[],
): { link: Link; sM: number } | undefined {
  let best: { link: Link; sM: number } | undefined;
  let bestDist = STOP_ATTACH_M;
  for (const link of links) {
    const hit = projectOntoPolyline(pt, link.geometry);
    if (hit === undefined || hit.side <= 0) continue;
    if (hit.distM < bestDist) {
      bestDist = hit.distM;
      best = { link, sM: hit.sM };
    }
  }
  return best;
}

/** `highway=bus_stop` / `public_transport=platform[bus=yes]` nodes attached to a route link (card §3). */
function buildStops(
  ctx: CompileContext,
  routeLinkIds: ReadonlySet<string>,
  linkById: ReadonlyMap<string, Link>,
): BusStop[] {
  const candidateLinks = [...routeLinkIds]
    .sort()
    .map((id) => linkById.get(id))
    .filter((l): l is Link => l !== undefined);

  const { graph } = ctx;
  const candidateNodeIds = [...graph.nodeTags.keys()]
    .filter((osmId) => isStopNodeTags(graph.nodeTags.get(osmId)))
    .sort((a, b) => a - b);

  let unattached = 0;
  const stops: BusStop[] = [];
  for (const osmId of candidateNodeIds) {
    const point = graph.nodePoints.get(osmId);
    const best = point === undefined ? undefined : nearestRouteLink(point, candidateLinks);
    if (best === undefined) {
      unattached += 1;
      continue;
    }
    const tags = graph.nodeTags.get(osmId) ?? {};
    const bay = isTruthyTag(tags.bus_bay);
    const name = pickName(tags);
    const id = `stop.n${osmId}`;
    stops.push({
      id,
      ...(name !== undefined ? { name } : {}),
      linkId: best.link.id,
      laneId: best.link.laneIds[best.link.laneIds.length - 1] as string,
      s: round(best.sM),
      kind: bay ? "bay" : "in_lane",
      osmNodeId: osmId,
      provenance: { kind: bay ? "osm" : "default" },
    });
    if (!bay) ctx.assumptions.add("bus_stop_kind_default", id);
  }
  stops.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Stay silent on a bbox with no candidate stop nodes at all (most synthetic test fixtures).
  if (candidateNodeIds.length > 0) {
    ctx.warn(
      `transit: ${stops.length} bus stop(s) attached within ${STOP_ATTACH_M} m of a route link, ` +
        `${unattached} unattached (discarded)`,
    );
  }
  return stops;
}
