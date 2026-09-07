import { describe, expect, it } from "vitest";
import { buildOverpassQuery, OSM_LAYERS } from "../../src/importer/queries.ts";

const tile = { row: 0, col: 0, south: 43.222, west: 76.898, north: 43.244, east: 76.938 };

describe("buildOverpassQuery", () => {
  for (const layer of OSM_LAYERS) {
    it(`renders a stable "${layer}" query`, () => {
      expect(buildOverpassQuery(layer, tile)).toMatchSnapshot();
    });
  }

  it("embeds the tile bbox as (south,west,north,east)", () => {
    const q = buildOverpassQuery("roads", tile);
    expect(q).toContain("(43.222,76.898,43.244,76.938)");
  });

  it("sets a 180s timeout and JSON output on every layer", () => {
    for (const layer of OSM_LAYERS) {
      expect(buildOverpassQuery(layer, tile)).toMatch(/^\[out:json\]\[timeout:180\];/);
    }
  });

  it("is pure: same layer and tile always produce the same text", () => {
    expect(buildOverpassQuery("roads", tile)).toBe(buildOverpassQuery("roads", tile));
  });
});
