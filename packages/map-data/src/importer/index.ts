import { join } from "node:path";
import type { BBoxPreset } from "../bboxes.ts";
import { fetchOverpassQuery } from "./fetch.ts";
import { mergeOsmResponses, type OsmLayerResponse, readGzJson, writeGzJson } from "./merge.ts";
import { buildOverpassQuery, OSM_LAYERS } from "./queries.ts";
import { splitIntoTiles, tileCacheKey } from "./tiles.ts";

/** Raw Overpass JSON element (subset we rely on). */
export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  members?: { type: string; ref: number; role: string }[];
  geometry?: { lat: number; lon: number }[];
}

export interface OsmSnapshot {
  bboxId: string;
  fetchedAt: string;
  /** Overpass `osm3s.timestamp_osm_base` of the first tile. */
  osmTimestamp?: string;
  elements: OsmElement[];
}

export interface ImportOptions {
  bbox: BBoxPreset;
  /** Directory where tiles are written as .json.gz (default data/osm/<bboxId>). */
  outDir: string;
  endpoints?: string[];
  /** Reuse tiles already on disk instead of refetching. */
  useCache?: boolean;
}

/** Pause between tiles (not between the 5 layer requests within a tile) so mirrors don't answer 429. */
const TILE_FETCH_DELAY_MS = 2000;

/**
 * Tiled Overpass import with retries and mirror fallback.
 * Writes data/osm/<bboxId>/tiles/<row>-<col>.<layer>.json.gz and data/osm/<bboxId>/snapshot.json.gz
 * (merged, deduplicated). Tiles already on disk are reused when useCache is true (the default).
 */
export async function importOsm(opts: ImportOptions): Promise<OsmSnapshot> {
  const { bbox, outDir } = opts;
  const useCache = opts.useCache ?? true;
  const tiles = splitIntoTiles(bbox, bbox.tilesPerSide);
  const tilesDir = join(outDir, "tiles");

  const responses: OsmLayerResponse[] = [];
  for (const [i, tile] of tiles.entries()) {
    let fetchedFromNetwork = false;
    for (const layer of OSM_LAYERS) {
      const cachePath = join(tilesDir, `${tileCacheKey(tile)}.${layer}.json.gz`);
      const cached = useCache ? await readGzJson<OsmLayerResponse>(cachePath) : undefined;
      if (cached) {
        responses.push(cached);
        continue;
      }
      const query = buildOverpassQuery(layer, tile);
      const result = await fetchOverpassQuery(
        query,
        opts.endpoints !== undefined ? { endpoints: opts.endpoints } : {},
      );
      const stamped: OsmLayerResponse = { ...result, fetchedAt: new Date().toISOString() };
      await writeGzJson(cachePath, stamped);
      responses.push(stamped);
      fetchedFromNetwork = true;
    }
    if (fetchedFromNetwork && i < tiles.length - 1) {
      await sleep(TILE_FETCH_DELAY_MS);
    }
  }

  const snapshot = mergeOsmResponses(bbox.id, responses);
  await writeGzJson(join(outDir, "snapshot.json.gz"), snapshot);
  return snapshot;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
