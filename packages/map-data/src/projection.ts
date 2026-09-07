import type { LonLat, Point2 } from "@atl/contracts";

const M_PER_DEG_LAT = 111_320;

/**
 * Equirectangular projection around the origin. Error over 7 km at 43°N is well under a metre,
 * which is far below the precision of anything else in this project.
 * Local frame: x = east (m), y = north (m). Three.js mapping: (x, y) -> (x, -z), up = +y (see docs/CONTRACTS.md).
 */
export interface Projection {
  origin: LonLat;
  toLocal(p: LonLat): Point2;
  toLonLat(p: Point2): LonLat;
}

export function createProjection(origin: LonLat): Projection {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    origin,
    toLocal: (p) => [(p.lon - origin.lon) * mPerDegLon, (p.lat - origin.lat) * M_PER_DEG_LAT],
    toLonLat: (p) => ({
      lon: origin.lon + p[0] / mPerDegLon,
      lat: origin.lat + p[1] / M_PER_DEG_LAT,
    }),
  };
}
