import type { HighwayClass, Provenance } from "@atl/contracts";
import {
  type DirectionParseContext,
  directionalTag,
  type Tags,
  type TravelDirection,
} from "./tags.ts";

/**
 * Speed limit when `maxspeed` is missing, km/h (provenance "default").
 * Card T-02: trunk 80, primary/secondary/tertiary 60, residential 40, living_street 20.
 * Not listed there and chosen here: unclassified 40, trunk_link 60, other *_link 40, service 20.
 */
export const DEFAULT_SPEED_KPH: Record<HighwayClass, number> = {
  trunk: 80,
  trunk_link: 60,
  primary: 60,
  primary_link: 40,
  secondary: 60,
  secondary_link: 40,
  tertiary: 60,
  tertiary_link: 40,
  residential: 40,
  unclassified: 40,
  living_street: 20,
  service: 20,
};

/** Named OSM speed values seen in Kazakhstan/Russia. */
const NAMED_SPEEDS: Record<string, number> = {
  "RU:urban": 60,
  "KZ:urban": 60,
  "RU:rural": 90,
  "KZ:rural": 90,
  "RU:living_street": 20,
  "KZ:living_street": 20,
  "RU:motorway": 110,
  "KZ:motorway": 110,
  walk: 5,
};

/** Parses a `maxspeed` value into km/h; undefined when it cannot be interpreted (`none`, `signals`, ...). */
export function parseMaxspeed(raw: string): number | undefined {
  const value = raw.trim();
  const named = NAMED_SPEEDS[value];
  if (named !== undefined) return named;
  const plain = /^(\d+(?:\.\d+)?)(?:\s*km\/h)?$/i.exec(value);
  if (plain) return Number(plain[1]);
  const mph = /^(\d+(?:\.\d+)?)\s*mph$/i.exec(value);
  if (mph) return Math.round(Number(mph[1]) * 1.609344);
  return undefined;
}

export interface SpeedResolution {
  kph: number;
  provenance: Provenance;
}

/** `maxspeed:<dir>` → `maxspeed` → class default. Unparseable values fall back to the default with a warning. */
export function resolveSpeed(
  tags: Tags,
  travel: TravelDirection,
  ctx: DirectionParseContext,
): SpeedResolution {
  const raw = directionalTag(tags, "maxspeed", travel, ctx, true);
  if (raw !== undefined) {
    const kph = parseMaxspeed(raw);
    if (kph !== undefined && kph > 0) return { kph, provenance: "osm" };
    ctx.warn(`way ${ctx.wayId}: cannot interpret maxspeed="${raw}"; using the class default`);
  }
  return { kph: DEFAULT_SPEED_KPH[ctx.highwayClass], provenance: "default" };
}
