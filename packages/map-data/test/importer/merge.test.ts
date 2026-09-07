import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeOsmResponses,
  type OsmLayerResponse,
  readGzJson,
  writeGzJson,
} from "../../src/importer/merge.ts";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

function loadFixture(name: string): {
  elements: OsmLayerResponse["elements"];
  osm3s?: { timestamp_osm_base?: string };
} {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

describe("mergeOsmResponses", () => {
  it("dedupes overlapping tiles, sorts by type then id, keeps first tile's metadata and first-seen element", () => {
    const tileA = loadFixture("tile-a.roads.json");
    const tileB = loadFixture("tile-b.roads.json");
    const responses: OsmLayerResponse[] = [
      {
        elements: tileA.elements,
        ...(tileA.osm3s?.timestamp_osm_base !== undefined
          ? { timestampOsmBase: tileA.osm3s.timestamp_osm_base }
          : {}),
        fetchedAt: "2026-08-01T00:10:00Z",
      },
      {
        elements: tileB.elements,
        ...(tileB.osm3s?.timestamp_osm_base !== undefined
          ? { timestampOsmBase: tileB.osm3s.timestamp_osm_base }
          : {}),
        fetchedAt: "2026-08-01T00:12:00Z",
      },
    ];

    const snapshot = mergeOsmResponses("test-bbox", responses);

    expect(snapshot.bboxId).toBe("test-bbox");
    expect(snapshot.fetchedAt).toBe("2026-08-01T00:10:00Z");
    expect(snapshot.osmTimestamp).toBe("2026-08-01T00:00:00Z");
    // way:100 appears in both tiles (the overlap zone) and must be counted once.
    expect(snapshot.elements.map((e) => `${e.type}:${e.id}`)).toEqual([
      "node:1",
      "node:2",
      "way:100",
      "way:200",
      "way:300",
    ]);
    const way100 = snapshot.elements.find((e) => e.type === "way" && e.id === 100);
    expect(way100?.tags).toEqual({ highway: "primary" });
  });

  it("returns a well-formed empty snapshot for zero responses", () => {
    const snapshot = mergeOsmResponses("empty-bbox", []);
    expect(snapshot.elements).toEqual([]);
    expect(snapshot.osmTimestamp).toBeUndefined();
  });

  it("is pure and deterministic: same input always merges to the same output", () => {
    const tileA = loadFixture("tile-a.roads.json");
    const responses: OsmLayerResponse[] = [{ elements: tileA.elements, fetchedAt: "T" }];
    expect(mergeOsmResponses("b", responses)).toEqual(mergeOsmResponses("b", responses));
  });
});

describe("gzip json cache files", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("round-trips arbitrary JSON through gzip", async () => {
    dir = await mkdtemp(join(tmpdir(), "atl-map-data-"));
    const path = join(dir, "nested", "sample.json.gz");
    const data = { bboxId: "x", elements: [{ type: "node", id: 1 }] };

    await writeGzJson(path, data);
    const back = await readGzJson<typeof data>(path);

    expect(back).toEqual(data);
  });

  it("returns undefined for a missing cache file", async () => {
    dir = await mkdtemp(join(tmpdir(), "atl-map-data-"));
    const back = await readGzJson(join(dir, "missing.json.gz"));
    expect(back).toBeUndefined();
  });

  it("compresses identical input to identical bytes (required for byte-stable cached snapshots)", async () => {
    dir = await mkdtemp(join(tmpdir(), "atl-map-data-"));
    const p1 = join(dir, "a.json.gz");
    const p2 = join(dir, "b.json.gz");
    const data = { a: 1, list: [1, 2, 3], nested: { ok: true } };

    await writeGzJson(p1, data);
    await writeGzJson(p2, data);

    expect((await readFile(p1)).equals(await readFile(p2))).toBe(true);
  });
});
