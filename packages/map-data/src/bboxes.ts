import type { BBox } from "@atl/contracts";

export interface BBoxPreset extends BBox {
  id: string;
  title: string;
  /** Overpass tiles per side used by the importer (bigger boxes need more, smaller tiles). */
  tilesPerSide: number;
}

/**
 * Two presets by decision D4/D9: a small square for tests and fast iteration,
 * the big one ("весь центр Алматы") as the default demo. Both run through the same pipeline.
 */
export const BBOXES: Record<string, BBoxPreset> = {
  small: {
    id: "almaty-abay-small",
    title: "Абая – Тимирязева × Ауэзова – Сейфуллина (тестовый квадрат)",
    south: 43.222,
    west: 76.898,
    north: 43.244,
    east: 76.938,
    tilesPerSide: 1,
  },
  big: {
    id: "almaty-center-big",
    title: "Райымбека – Аль-Фараби × Гагарина – Достык (центр Алматы)",
    south: 43.216,
    west: 76.872,
    north: 43.276,
    east: 76.962,
    tilesPerSide: 3,
  },
};

export function getBBox(key: string): BBoxPreset {
  const b = BBOXES[key];
  if (!b) throw new Error(`unknown bbox "${key}"; known: ${Object.keys(BBOXES).join(", ")}`);
  return b;
}

export function bboxCentre(b: BBox): { lat: number; lon: number } {
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}
