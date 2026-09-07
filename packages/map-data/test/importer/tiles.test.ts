import { describe, expect, it } from "vitest";
import { splitIntoTiles, TILE_OVERLAP_DEG, tileCacheKey } from "../../src/importer/tiles.ts";

const bbox = { south: 43.0, west: 76.0, north: 43.1, east: 76.1 };

describe("splitIntoTiles", () => {
  it("returns tilesPerSide^2 tiles in row-major order", () => {
    const tiles = splitIntoTiles(bbox, 2);
    expect(tiles.map((t) => `${t.row}-${t.col}`)).toEqual(["0-0", "0-1", "1-0", "1-1"]);
  });

  it("grows every tile by the overlap margin on all sides", () => {
    const tiles = splitIntoTiles(bbox, 1);
    const tile = tiles[0];
    expect(tiles).toHaveLength(1);
    expect(tile).toBeDefined();
    if (!tile) throw new Error("unreachable");
    expect(tile.south).toBeCloseTo(bbox.south - TILE_OVERLAP_DEG, 10);
    expect(tile.west).toBeCloseTo(bbox.west - TILE_OVERLAP_DEG, 10);
    expect(tile.north).toBeCloseTo(bbox.north + TILE_OVERLAP_DEG, 10);
    expect(tile.east).toBeCloseTo(bbox.east + TILE_OVERLAP_DEG, 10);
  });

  it("makes neighbouring tiles overlap by exactly twice the margin", () => {
    const tiles = splitIntoTiles(bbox, 2);
    const a = tiles.find((t) => t.row === 0 && t.col === 0);
    const b = tiles.find((t) => t.row === 0 && t.col === 1);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) throw new Error("unreachable");
    expect(a.east - b.west).toBeCloseTo(2 * TILE_OVERLAP_DEG, 10);
  });

  it("is pure: repeated calls with the same inputs give the same output", () => {
    expect(splitIntoTiles(bbox, 3)).toEqual(splitIntoTiles(bbox, 3));
  });

  it("rejects a non-positive tile count", () => {
    expect(() => splitIntoTiles(bbox, 0)).toThrow();
    expect(() => splitIntoTiles(bbox, -1)).toThrow();
  });
});

describe("tileCacheKey", () => {
  it("formats as row-col", () => {
    expect(tileCacheKey({ row: 2, col: 5 })).toBe("2-5");
    expect(tileCacheKey({ row: 0, col: 0 })).toBe("0-0");
  });
});
