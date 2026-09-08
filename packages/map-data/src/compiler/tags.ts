import type { HighwayClass } from "@atl/contracts";

export type Tags = Record<string, string>;
export type Warn = (message: string) => void;
export type TravelDirection = "forward" | "backward";

/** Everything a per-direction tag parser needs to know about the way it is looking at. */
export interface DirectionParseContext {
  wayId: number;
  highwayClass: HighwayClass;
  oneway: boolean;
  /** oneway=-1: travel runs against the way's node order, so `*:backward` tags describe travel "forward". */
  wayReversed: boolean;
  warn: Warn;
}

/** Direction in the way's own terms (OSM `:forward` / `:backward` suffixes) for a travel direction. */
export function wayDirectionOf(
  travel: TravelDirection,
  ctx: DirectionParseContext,
): TravelDirection {
  if (!ctx.wayReversed) return travel;
  return travel === "forward" ? "backward" : "forward";
}

/**
 * `<base>:<forward|backward>` for the travel direction; falls back to the plain `<base>` tag on
 * one-way streets and, when `plainOnTwoWay` is set, on two-way streets as well (maxspeed applies to
 * both directions, turn:lanes does not).
 */
export function directionalTag(
  tags: Tags,
  base: string,
  travel: TravelDirection,
  ctx: DirectionParseContext,
  plainOnTwoWay: boolean,
): string | undefined {
  const own = tags[`${base}:${wayDirectionOf(travel, ctx)}`];
  if (own !== undefined) return own;
  if (ctx.oneway || plainOnTwoWay) return tags[base];
  return undefined;
}

export function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*(\d+)\s*$/.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 ? n : undefined;
}

export function isTruthyTag(value: string | undefined): boolean {
  return value !== undefined && value !== "no" && value !== "false" && value !== "0";
}
