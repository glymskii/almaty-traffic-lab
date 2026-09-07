import type { BBoxPreset } from "../bboxes.ts";

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

/**
 * Tiled Overpass import with retries and mirror fallback. Implemented in T-01.
 * Writes data/osm/<bboxId>/tiles/<row>-<col>.json.gz and data/osm/<bboxId>/snapshot.json.gz (merged, deduplicated).
 */
export async function importOsm(_opts: ImportOptions): Promise<OsmSnapshot> {
  throw new Error("not implemented: see docs/tasks/T-01-osm-importer.md");
}
