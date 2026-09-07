import type { BBox } from "@atl/contracts";

/** The five Overpass layers fetched per tile (see docs/tasks/T-01-osm-importer.md). */
export const OSM_LAYERS = ["roads", "transit", "pois", "buildings", "landuse"] as const;
export type OsmLayer = (typeof OSM_LAYERS)[number];

const OVERPASS_TIMEOUT_S = 180;

const ROAD_HIGHWAY_CLASSES =
  "trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street";
const ROAD_NODE_KINDS = "traffic_signals|crossing|stop|give_way";
const TRANSIT_ROUTES = "bus|trolleybus";
const POI_AMENITIES = "university|college|hospital|theatre|cinema";
const WATERWAYS = "river|stream|canal";

function bboxClause(b: BBox): string {
  return `(${b.south},${b.west},${b.north},${b.east})`;
}

/** Wraps a union of Overpass statements into a full [out:json] query with a single `out` at the end. */
function query(statements: string[], out: string): string {
  const body = statements.map((s) => `  ${s}`).join("\n");
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];\n(\n${body}\n);\nout ${out};\n`;
}

function roadsQuery(tile: BBox): string {
  const bbox = bboxClause(tile);
  return query(
    [
      `way[highway~"^(${ROAD_HIGHWAY_CLASSES})$"]${bbox};`,
      `node[highway~"^(${ROAD_NODE_KINDS})$"]${bbox};`,
    ],
    "geom",
  );
}

function transitQuery(tile: BBox): string {
  const bbox = bboxClause(tile);
  return query(
    [
      `relation[type=route][route~"^(${TRANSIT_ROUTES})$"]${bbox};`,
      `node[highway=bus_stop]${bbox};`,
      `node[public_transport=platform][bus=yes]${bbox};`,
    ],
    "body",
  );
}

/** node|way pair for every filter, e.g. "shop=mall" -> node[shop=mall](bbox); way[shop=mall](bbox); */
function nodeWayPairs(filters: string[], bbox: string): string[] {
  return filters.flatMap((f) => [`node${f}${bbox};`, `way${f}${bbox};`]);
}

function poisQuery(tile: BBox): string {
  const bbox = bboxClause(tile);
  const filters = [
    "[shop=mall]",
    `[amenity~"^(${POI_AMENITIES})$"]`,
    "[leisure=stadium]",
    "[office]",
    "[railway=station]",
    "[public_transport=station]",
  ];
  return query(nodeWayPairs(filters, bbox), "center");
}

function buildingsQuery(tile: BBox): string {
  const bbox = bboxClause(tile);
  return query([`way[building]${bbox};`, `relation[building][type=multipolygon]${bbox};`], "geom");
}

function landuseQuery(tile: BBox): string {
  const bbox = bboxClause(tile);
  const filters = [
    "[leisure=park]",
    "[natural=water]",
    "[landuse=grass]",
    `[waterway~"^(${WATERWAYS})$"]`,
  ];
  const statements = filters.flatMap((f) => [`way${f}${bbox};`, `relation${f}${bbox};`]);
  return query(statements, "geom");
}

const BUILDERS: Record<OsmLayer, (tile: BBox) => string> = {
  roads: roadsQuery,
  transit: transitQuery,
  pois: poisQuery,
  buildings: buildingsQuery,
  landuse: landuseQuery,
};

/** Builds the Overpass QL text for one layer over one tile bbox. Pure: no I/O. */
export function buildOverpassQuery(layer: OsmLayer, tile: BBox): string {
  return BUILDERS[layer](tile);
}
