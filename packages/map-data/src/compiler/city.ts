import type {
  Area,
  Building,
  Point2,
  Polygon,
  Polyline,
  Provenance,
  Waterway,
} from "@atl/contracts";
import { distance, simplifyPolyline } from "../geometry/polyline.ts";
import type { OsmElement } from "../importer/index.ts";
import type { Projection } from "../projection.ts";
import type { CompileContext } from "./stages.ts";
import { parsePositiveInt, type Tags, type Warn } from "./tags.ts";

/**
 * Compiler stage "city" (T-27): renders-only layers read straight from the OSM snapshot, not from
 * the driveable graph - `buildings` from `building=*`, `areas` from `leisure=park`/`landuse=grass`
 * (kind "park") and `natural=water` (kind "water"), `waterways` from `waterway=river|stream|canal`.
 * Multipolygon relations contribute one entry per "outer" member (holes/"inner" members are
 * ignored - card §1: "way и multipolygon outer"); a way that is both tagged standalone *and* an
 * outer member of a relation with the same tag (a handful of cases in the real snapshot) is only
 * counted once, from the standalone way.
 */

const SIMPLIFY_EPS_M = 1;
/** Card §1; matches `WaterwaySchema.widthM`'s zod default (packages/contracts/src/network.ts) - kept
 * as its own constant because a plain object literal (not `parseNetwork`) is built here. */
export const DEFAULT_WATERWAY_WIDTH_M = 6;
export const BUILDING_HEIGHT_PER_LEVEL_M = 3;
/** Card §1: "apartments 15, house 6, иначе 9". Other `building=*` values fall through to the generic default. */
export const BUILDING_TYPE_HEIGHT_M: Record<string, number> = { apartments: 15, house: 6 };
export const DEFAULT_BUILDING_HEIGHT_M = 9;
const WATERWAY_CLASSES: ReadonlySet<string> = new Set(["river", "stream", "canal"]);

/** A relation member carrying its own geometry (Overpass `out geom` on the buildings/landuse layers). */
type OuterMember = NonNullable<OsmElement["members"]>[number];

function areaKindOf(tags: Tags): Area["kind"] | undefined {
  if (tags.natural === "water") return "water";
  if (tags.leisure === "park" || tags.landuse === "grass") return "park";
  return undefined;
}

/** `"15"`, `"15.5"`, `"15 m"` -> 15 / 15.5; anything else (feet, "storeys", garbage) -> undefined. */
function parsePositiveMeters(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*m?\s*$/i.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 ? n : undefined;
}

/** Drops a ring's duplicated closing vertex (OSM ways close on themselves; `PolygonSchema` does not want that), then simplifies. */
function closedRingToPolygon(
  local: readonly Point2[],
  label: string,
  warn: Warn,
): Polygon | undefined {
  const first = local[0];
  const last = local[local.length - 1];
  const open =
    first !== undefined && last !== undefined && distance(first, last) < 1e-6
      ? local.slice(0, -1)
      : local.slice();
  if (open.length < 3) {
    warn(`${label}: fewer than 3 distinct vertices; skipped`);
    return undefined;
  }
  const simplified = simplifyPolyline(open, SIMPLIFY_EPS_M);
  if (simplified.length < 3) {
    warn(`${label}: degenerate after 1 m simplification; skipped`);
    return undefined;
  }
  return simplified;
}

function wayRingPolygon(el: OsmElement, proj: Projection, warn: Warn): Polygon | undefined {
  if (el.geometry === undefined || el.geometry.length < 3) {
    warn(`way ${el.id}: no usable geometry for a footprint; skipped`);
    return undefined;
  }
  return closedRingToPolygon(
    el.geometry.map((p) => proj.toLocal(p)),
    `way ${el.id}`,
    warn,
  );
}

function memberRingPolygon(
  member: OuterMember,
  proj: Projection,
  label: string,
  warn: Warn,
): Polygon | undefined {
  if (member.geometry === undefined || member.geometry.length < 3) {
    warn(`${label}: outer member has no usable geometry; skipped`);
    return undefined;
  }
  return closedRingToPolygon(
    member.geometry.map((p) => proj.toLocal(p)),
    label,
    warn,
  );
}

function wayPolyline(el: OsmElement, proj: Projection, warn: Warn): Polyline | undefined {
  if (el.geometry === undefined || el.geometry.length < 2) {
    warn(`way ${el.id}: no usable geometry for a waterway; skipped`);
    return undefined;
  }
  const simplified = simplifyPolyline(
    el.geometry.map((p) => proj.toLocal(p)),
    SIMPLIFY_EPS_M,
  );
  if (simplified.length < 2) {
    warn(`way ${el.id}: waterway degenerate after 1 m simplification; skipped`);
    return undefined;
  }
  return simplified;
}

interface HeightResolution {
  heightM: number;
  provenance: Provenance;
}

/**
 * Card §1: `height` (m) -> `building:levels` × 3 m -> a lookup by `building=*` -> 9 m. The first
 * two read an explicit OSM number (provenance "osm", same convention as splitting `lanes` in
 * lanes.ts); only the last two invent a number with no tag behind it at all (provenance "default").
 */
function resolveBuildingHeight(tags: Tags): HeightResolution {
  const height = parsePositiveMeters(tags.height);
  if (height !== undefined) return { heightM: height, provenance: "osm" };
  const levels = parsePositiveInt(tags["building:levels"]);
  if (levels !== undefined) {
    return { heightM: levels * BUILDING_HEIGHT_PER_LEVEL_M, provenance: "osm" };
  }
  const byType = tags.building !== undefined ? BUILDING_TYPE_HEIGHT_M[tags.building] : undefined;
  return { heightM: byType ?? DEFAULT_BUILDING_HEIGHT_M, provenance: "default" };
}

function makeBuilding(id: string, footprint: Polygon, tags: Tags): Building {
  const { heightM, provenance } = resolveBuildingHeight(tags);
  return { id, footprint, heightM, provenance: { heightM: provenance } };
}

function resolveWaterwayWidth(tags: Tags): number {
  return parsePositiveMeters(tags.width) ?? DEFAULT_WATERWAY_WIDTH_M;
}

export function runCity(ctx: CompileContext): void {
  const proj = ctx.projection;
  const warn = ctx.warn;
  const elements = ctx.opts.snapshot.elements;

  const buildings: Building[] = [];
  const areas: Area[] = [];
  const waterways: Waterway[] = [];
  // Ways already turned into an entity, so the same footprint reached via a relation's "outer"
  // member (rare, but present in the real snapshot) is not drawn twice.
  const buildingWayIds = new Set<number>();
  const areaWayIds = new Set<number>();

  for (const el of elements) {
    if (el.type !== "way" || el.tags === undefined) continue;
    const tags = el.tags;
    if (tags.building !== undefined) {
      const footprint = wayRingPolygon(el, proj, warn);
      if (footprint === undefined) continue;
      buildingWayIds.add(el.id);
      buildings.push(makeBuilding(`bld.w${el.id}`, footprint, tags));
      continue;
    }
    const kind = areaKindOf(tags);
    if (kind !== undefined) {
      const polygon = wayRingPolygon(el, proj, warn);
      if (polygon === undefined) continue;
      areaWayIds.add(el.id);
      areas.push({ id: `area.w${el.id}`, kind, polygon });
      continue;
    }
    if (tags.waterway !== undefined && WATERWAY_CLASSES.has(tags.waterway)) {
      const polyline = wayPolyline(el, proj, warn);
      if (polyline === undefined) continue;
      waterways.push({ id: `wway.w${el.id}`, polyline, widthM: resolveWaterwayWidth(tags) });
    }
  }

  for (const el of elements) {
    if (el.type !== "relation" || el.tags === undefined) continue;
    const tags = el.tags;
    const isBuildingRelation = tags.building !== undefined;
    const areaKind = areaKindOf(tags);
    if (!isBuildingRelation && areaKind === undefined) continue;

    let outerIndex = 0;
    for (const member of el.members ?? []) {
      if (member.type !== "way" || member.role !== "outer") continue;
      if (isBuildingRelation) {
        if (buildingWayIds.has(member.ref)) continue;
        const footprint = memberRingPolygon(
          member,
          proj,
          `relation ${el.id} outer way ${member.ref}`,
          warn,
        );
        if (footprint === undefined) continue;
        buildings.push(makeBuilding(`bld.r${el.id}.${outerIndex}`, footprint, tags));
        outerIndex += 1;
      } else if (areaKind !== undefined) {
        if (areaWayIds.has(member.ref)) continue;
        const polygon = memberRingPolygon(
          member,
          proj,
          `relation ${el.id} outer way ${member.ref}`,
          warn,
        );
        if (polygon === undefined) continue;
        areas.push({ id: `area.r${el.id}.${outerIndex}`, kind: areaKind, polygon });
        outerIndex += 1;
      }
    }
  }

  ctx.network.buildings = buildings;
  ctx.network.areas = areas;
  ctx.network.waterways = waterways;
}
