import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { OverpassResult } from "./fetch.ts";
import type { OsmElement, OsmSnapshot } from "./index.ts";

/** One tile+layer Overpass result, stamped with when it was actually fetched (kept across cache hits). */
export interface OsmLayerResponse extends OverpassResult {
  fetchedAt: string;
}

const TYPE_ORDER: Record<OsmElement["type"], number> = { node: 0, way: 1, relation: 2 };

/**
 * Merges every tile/layer response into one snapshot: dedupes by (type, id) keeping the first
 * occurrence, sorts stably by type then id, and takes fetchedAt/osmTimestamp from the first
 * response so re-merging unchanged (cached) responses yields a byte-identical snapshot.
 */
export function mergeOsmResponses(bboxId: string, responses: OsmLayerResponse[]): OsmSnapshot {
  const seen = new Map<string, OsmElement>();
  for (const response of responses) {
    for (const element of response.elements) {
      const key = `${element.type}:${element.id}`;
      if (!seen.has(key)) seen.set(key, element);
    }
  }
  const elements = Array.from(seen.values()).sort((a, b) => {
    const byType = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    return byType !== 0 ? byType : a.id - b.id;
  });

  const first = responses[0];
  return {
    bboxId,
    fetchedAt: first?.fetchedAt ?? new Date().toISOString(),
    ...(first?.timestampOsmBase !== undefined ? { osmTimestamp: first.timestampOsmBase } : {}),
    elements,
  };
}

/** Reads a gzip-compressed JSON file, or undefined if it doesn't exist yet. */
export async function readGzJson<T = unknown>(path: string): Promise<T | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(gunzipSync(raw).toString("utf8")) as T;
}

/** Writes data as gzip-compressed JSON, creating parent directories as needed. */
export async function writeGzJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, gzipSync(Buffer.from(JSON.stringify(data), "utf8")));
}
