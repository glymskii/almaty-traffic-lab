import type { BBox } from "@atl/contracts";

/** One Overpass query tile: a bbox slice grown by TILE_OVERLAP_DEG on every side. */
export interface OsmTile extends BBox {
  row: number;
  col: number;
}

/**
 * Degrees of padding added on every side of each tile so that ways crossing a tile
 * boundary are captured whole by at least one of the two neighbouring tiles.
 * ~0.0005 deg is ~55m at Almaty's latitude, comfortably wider than a street segment.
 */
export const TILE_OVERLAP_DEG = 0.0005;

/**
 * Splits a bbox into tilesPerSide x tilesPerSide equal tiles (row-major, row 0 = south),
 * each padded by TILE_OVERLAP_DEG. Pure function: same inputs always produce the same tiles.
 */
export function splitIntoTiles(bbox: BBox, tilesPerSide: number): OsmTile[] {
  if (!Number.isInteger(tilesPerSide) || tilesPerSide < 1) {
    throw new Error(`tilesPerSide must be a positive integer, got ${tilesPerSide}`);
  }
  const lonStep = (bbox.east - bbox.west) / tilesPerSide;
  const latStep = (bbox.north - bbox.south) / tilesPerSide;
  const tiles: OsmTile[] = [];
  for (let row = 0; row < tilesPerSide; row++) {
    const south = bbox.south + row * latStep;
    const north = south + latStep;
    for (let col = 0; col < tilesPerSide; col++) {
      const west = bbox.west + col * lonStep;
      const east = west + lonStep;
      tiles.push({
        row,
        col,
        south: south - TILE_OVERLAP_DEG,
        west: west - TILE_OVERLAP_DEG,
        north: north + TILE_OVERLAP_DEG,
        east: east + TILE_OVERLAP_DEG,
      });
    }
  }
  return tiles;
}

/** Cache/file key for a tile, e.g. "0-0". */
export function tileCacheKey(tile: { row: number; col: number }): string {
  return `${tile.row}-${tile.col}`;
}
