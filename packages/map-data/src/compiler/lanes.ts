import type {
  HighwayClass,
  Lane,
  NodeKind,
  Provenance,
  ProvenanceMap,
  TurnKind,
  VehicleClass,
} from "@atl/contracts";
import { round } from "../geometry/polyline.ts";
import type { AssumptionCollector } from "./assumptions.ts";
import { resolveSpeed } from "./speeds.ts";
import {
  type DirectionParseContext,
  directionalTag,
  parsePositiveInt,
  type Tags,
  type TravelDirection,
  type Warn,
  wayDirectionOf,
} from "./tags.ts";

export const LANE_WIDTH_M = 3.5;

/**
 * Lanes per direction when `lanes` is missing (provenance "default").
 * Card T-02: trunk 3, primary 3, secondary 2, tertiary 2, residential 1, unclassified 1, living_street 1.
 * Chosen here: every *_link (ramp / slip road) 1, service 1.
 */
export const DEFAULT_LANES_PER_DIRECTION: Record<HighwayClass, number> = {
  trunk: 3,
  trunk_link: 1,
  primary: 3,
  primary_link: 1,
  secondary: 2,
  secondary_link: 1,
  tertiary: 2,
  tertiary_link: 1,
  residential: 1,
  unclassified: 1,
  living_street: 1,
  service: 1,
};

/** Pocket opened where `turn:lanes` says the leftmost lane is left-only. */
export const POCKET_TAGGED_LENGTH_M = 80;
export const POCKET_TAGGED_MIN_LINK_M = 200;
/** Short links: the pocket starts at this share of the link length instead. */
export const POCKET_TAGGED_SHORT_START_SHARE = 0.4;
/** Pocket assumed on approaches to signalized nodes without `turn:lanes`. */
export const POCKET_DEFAULT_LENGTH_M = 60;
export const POCKET_DEFAULT_MIN_LINK_M = 120;
export const POCKET_DEFAULT_MIN_LANES = 2;
export const POCKET_DEFAULT_CLASSES: ReadonlySet<HighwayClass> = new Set<HighwayClass>([
  "trunk",
  "primary",
  "secondary",
]);
export const BUS_LANE_RIGHT_TURN_ENTRY_M = 50;

const ALL_CLASSES: VehicleClass[] = ["car", "bus", "trolleybus", "taxi"];
const PT_CLASSES: VehicleClass[] = ["bus", "trolleybus"];
const TURN_ORDER: TurnKind[] = ["left", "through", "right", "uturn", "merge", "diverge"];

export type LaneCountSource = "lanes" | "turn_lanes" | "bus_lanes" | "default";

/** Everything the lane builder needs about one direction of travel, resolved from OSM tags. */
export interface DirectionAttrs {
  /** Total lanes including a bus lane. */
  laneCount: number;
  laneCountProvenance: Provenance;
  laneCountSource: LaneCountSource;
  speedKph: number;
  speedProvenance: Provenance;
  /** Parsed `turn:lanes` for this direction, leftmost first. Present only when consistent with laneCount. */
  turns?: TurnKind[][];
  /** Rightmost lane is a dedicated bus lane. */
  busLane: boolean;
  /** OSM designated a bus lane in a non-rightmost position; we still model it as the rightmost lane. */
  busLaneMisplaced: boolean;
}

// ---------------------------------------------------------------------------
// Tag parsing
// ---------------------------------------------------------------------------

const TURN_TOKENS: Record<string, TurnKind | "none"> = {
  left: "left",
  slight_left: "left",
  sharp_left: "left",
  through: "through",
  none: "none",
  "": "none",
  right: "right",
  slight_right: "right",
  sharp_right: "right",
  reverse: "uturn",
  merge_to_left: "merge",
  merge_to_right: "merge",
};

function canonicalTurns(set: ReadonlySet<TurnKind>): TurnKind[] {
  return TURN_ORDER.filter((t) => set.has(t));
}

/**
 * `turn:lanes` value → turns per lane, leftmost first. `left;through` → [left, through];
 * slight and sharp variants collapse to left/right, reverse → uturn, merge_to_left/right → merge,
 * none/empty → through.
 */
export function parseTurnLanes(raw: string, wayId: number, warn: Warn): TurnKind[][] {
  const out: TurnKind[][] = [];
  for (const laneRaw of raw.split("|")) {
    const set = new Set<TurnKind>();
    for (const tokenRaw of laneRaw.split(";")) {
      const token = tokenRaw.trim();
      const mapped = TURN_TOKENS[token];
      if (mapped === undefined) {
        warn(`way ${wayId}: unknown turn:lanes value "${token}" (treated as through)`);
        set.add("through");
      } else if (mapped !== "none") set.add(mapped);
    }
    if (set.size === 0) set.add("through");
    out.push(canonicalTurns(set));
  }
  return out;
}

/**
 * Turns when `turn:lanes` is missing: 1 lane [left, through, right]; 2 lanes [left, through] [through, right];
 * 3+ lanes [left, through] [through]... [through, right]. With a left pocket in front, the leftmost
 * general lane loses `left`.
 */
export function defaultTurns(laneCount: number, hasLeftPocket: boolean): TurnKind[][] {
  if (laneCount <= 1) return [hasLeftPocket ? ["through", "right"] : ["left", "through", "right"]];
  const out: TurnKind[][] = [];
  for (let i = 0; i < laneCount; i++) {
    if (i === 0) out.push(hasLeftPocket ? ["through"] : ["left", "through"]);
    else if (i === laneCount - 1) out.push(["through", "right"]);
    else out.push(["through"]);
  }
  return out;
}

interface LaneCountResolution {
  count: number;
  provenance: Provenance;
  source: LaneCountSource;
}

/**
 * `lanes:<dir>` → `lanes` (one-way: all; two-way: minus the other direction's explicit tag, else split
 * with the bigger half in the way's forward direction) → class default.
 */
function resolveLaneCount(
  tags: Tags,
  travel: TravelDirection,
  ctx: DirectionParseContext,
): LaneCountResolution {
  const wd = wayDirectionOf(travel, ctx);
  const own = tags[`lanes:${wd}`];
  if (own !== undefined) {
    const n = parsePositiveInt(own);
    if (n !== undefined) return { count: n, provenance: "osm", source: "lanes" };
    ctx.warn(`way ${ctx.wayId}: cannot parse lanes:${wd}="${own}"`);
  }
  const total = tags.lanes;
  if (total !== undefined) {
    const n = parsePositiveInt(total);
    if (n === undefined) {
      ctx.warn(`way ${ctx.wayId}: cannot parse lanes="${total}"`);
    } else if (ctx.oneway) {
      return { count: n, provenance: "osm", source: "lanes" };
    } else {
      const otherWd: TravelDirection = wd === "forward" ? "backward" : "forward";
      const other = parsePositiveInt(tags[`lanes:${otherWd}`]);
      if (other !== undefined) {
        if (n - other >= 1) return { count: n - other, provenance: "osm", source: "lanes" };
        ctx.warn(
          `way ${ctx.wayId}: lanes=${n} leaves no lane ${wd} after lanes:${otherWd}=${other}; using the class default`,
        );
      } else {
        const share = wd === "forward" ? Math.ceil(n / 2) : Math.floor(n / 2);
        if (share >= 1) return { count: share, provenance: "osm", source: "lanes" };
        ctx.warn(
          `way ${ctx.wayId}: lanes=${n} on a two-way street; assuming one lane ${wd} (default)`,
        );
      }
    }
  }
  return {
    count: DEFAULT_LANES_PER_DIRECTION[ctx.highwayClass],
    provenance: "default",
    source: "default",
  };
}

function resolveTurnLanes(
  tags: Tags,
  travel: TravelDirection,
  ctx: DirectionParseContext,
): TurnKind[][] | undefined {
  const raw = directionalTag(tags, "turn:lanes", travel, ctx, false);
  if (raw === undefined) {
    if (!ctx.oneway && travel === "forward" && tags["turn:lanes"] !== undefined)
      ctx.warn(
        `way ${ctx.wayId}: turn:lanes on a two-way street is ambiguous (use turn:lanes:forward/backward); ignored`,
      );
    return undefined;
  }
  return parseTurnLanes(raw, ctx.wayId, ctx.warn);
}

interface BusDesignation {
  designated: boolean;
  /** Number of per-lane entries in bus:lanes / psv:lanes (implies the lane count). */
  entries?: number;
  misplaced: boolean;
}

/**
 * Bus lane designation for one direction of travel, in priority order:
 * `bus:lanes` / `psv:lanes` (per lane, `designated`) → `lanes:bus` / `lanes:psv` (count) → `busway*=lane`.
 */
function resolveBusLane(
  tags: Tags,
  travel: TravelDirection,
  ctx: DirectionParseContext,
): BusDesignation {
  const wd = wayDirectionOf(travel, ctx);
  for (const base of ["bus:lanes", "psv:lanes"]) {
    const raw = directionalTag(tags, base, travel, ctx, false);
    if (raw === undefined) continue;
    const entries = raw.split("|").map((s) => s.trim());
    const designated: number[] = [];
    entries.forEach((v, i) => {
      if (v === "designated") designated.push(i);
    });
    if (designated.length === 0) continue;
    if (designated.length > 1)
      ctx.warn(
        `way ${ctx.wayId}: ${base} designates ${designated.length} lanes; only one bus lane per direction is modelled`,
      );
    const last = designated[designated.length - 1] as number;
    const misplaced = last !== entries.length - 1;
    if (misplaced)
      ctx.warn(
        `way ${ctx.wayId}: ${base} designates lane ${last + 1} of ${entries.length} (not the rightmost); modelled as the rightmost lane`,
      );
    return { designated: true, entries: entries.length, misplaced };
  }
  for (const base of ["lanes:bus", "lanes:psv"]) {
    const own = tags[`${base}:${wd}`];
    const raw = own ?? tags[base];
    if (raw === undefined) continue;
    const n = parsePositiveInt(raw);
    if (n === undefined) {
      if (raw.trim() !== "0") ctx.warn(`way ${ctx.wayId}: cannot parse ${base}="${raw}"`);
      continue;
    }
    if (own === undefined && !ctx.oneway)
      ctx.warn(
        `way ${ctx.wayId}: ${base}=${raw} on a two-way street without direction; assuming a bus lane in both directions`,
      );
    if (n > 1)
      ctx.warn(`way ${ctx.wayId}: ${base}=${n}; only one bus lane per direction is modelled`);
    return { designated: true, misplaced: false };
  }
  const check = (value: string | undefined, tag: string): boolean => {
    if (value === undefined || value === "no" || value === "none") return false;
    if (value === "lane") return true;
    ctx.warn(`way ${ctx.wayId}: ${tag}=${value} is not modelled (only busway=lane)`);
    return false;
  };
  if (check(tags["busway:both"], "busway:both") || check(tags.busway, "busway"))
    return { designated: true, misplaced: false };
  const sameSide = wd === "forward" ? "right" : "left";
  const otherSide = wd === "forward" ? "left" : "right";
  if (check(tags[`busway:${sameSide}`], `busway:${sameSide}`))
    return { designated: true, misplaced: false };
  if (ctx.oneway && check(tags[`busway:${otherSide}`], `busway:${otherSide}`)) {
    ctx.warn(
      `way ${ctx.wayId}: busway:${otherSide}=lane is on the left of travel; modelled as the rightmost lane`,
    );
    return { designated: true, misplaced: true };
  }
  return { designated: false, misplaced: false };
}

/** Resolves lane count, speed, turns and bus lane for one direction of travel of a way. */
export function parseDirectionAttrs(
  tags: Tags,
  travel: TravelDirection,
  ctx: DirectionParseContext,
): DirectionAttrs {
  const lc = resolveLaneCount(tags, travel, ctx);
  let laneCount = lc.count;
  let laneCountProvenance = lc.provenance;
  let laneCountSource = lc.source;

  let turns = resolveTurnLanes(tags, travel, ctx);
  if (turns !== undefined && laneCountSource === "default") {
    laneCount = turns.length;
    laneCountProvenance = "osm";
    laneCountSource = "turn_lanes";
  }

  const bus = resolveBusLane(tags, travel, ctx);
  if (bus.entries !== undefined) {
    if (laneCountSource === "default") {
      laneCount = bus.entries;
      laneCountProvenance = "osm";
      laneCountSource = "bus_lanes";
    } else if (bus.entries !== laneCount) {
      ctx.warn(
        `way ${ctx.wayId}: bus/psv:lanes has ${bus.entries} entries but the ${travel} direction has ${laneCount} lanes`,
      );
    }
  }
  if (bus.designated && (laneCountSource === "default" || laneCount === 1)) {
    // Class defaults count general lanes; a bus lane comes on top. A single tagged lane cannot be
    // bus-only either, or cars would have nowhere to drive.
    if (laneCountSource !== "default") {
      ctx.warn(
        `way ${ctx.wayId}: the only lane ${travel} is a bus lane; adding a general lane (default)`,
      );
      laneCountProvenance = "default";
    }
    laneCount += 1;
  }

  if (turns !== undefined && turns.length !== laneCount) {
    ctx.warn(
      `way ${ctx.wayId}: turn:lanes has ${turns.length} entries but the ${travel} direction has ${laneCount} lanes; turn:lanes ignored`,
    );
    turns = undefined;
  }

  const speed = resolveSpeed(tags, travel, ctx);
  return {
    laneCount,
    laneCountProvenance,
    laneCountSource,
    speedKph: speed.kph,
    speedProvenance: speed.provenance,
    ...(turns !== undefined ? { turns } : {}),
    busLane: bus.designated,
    busLaneMisplaced: bus.misplaced,
  };
}

// ---------------------------------------------------------------------------
// Lane objects for a link
// ---------------------------------------------------------------------------

export interface LaneBuildInput {
  linkId: string;
  lengthM: number;
  highwayClass: HighwayClass;
  dir: DirectionAttrs;
  toNodeKind: NodeKind;
  assumptions: AssumptionCollector;
}

/**
 * Lanes of one link, leftmost first. Applies the turn defaults, the left-pocket rules and the bus-lane
 * rule, and records every default in the assumption collector.
 */
export function buildLanes(input: LaneBuildInput): Lane[] {
  const { dir, lengthM, linkId } = input;
  const generalCount = dir.laneCount - (dir.busLane ? 1 : 0);

  let turns: TurnKind[][];
  let turnsProvenance: Provenance;
  let pocket: { startS: number; byRule: boolean } | undefined;
  if (dir.turns !== undefined) {
    turns = dir.turns;
    turnsProvenance = "osm";
    const leftmost = turns[0];
    if (dir.laneCount >= 2 && leftmost !== undefined && isLeftOnly(leftmost)) {
      const startS =
        lengthM >= POCKET_TAGGED_MIN_LINK_M
          ? lengthM - POCKET_TAGGED_LENGTH_M
          : lengthM * POCKET_TAGGED_SHORT_START_SHARE;
      pocket = { startS, byRule: false };
    }
  } else {
    const addPocket =
      input.toNodeKind === "signalized" &&
      generalCount >= POCKET_DEFAULT_MIN_LANES &&
      POCKET_DEFAULT_CLASSES.has(input.highwayClass) &&
      lengthM >= POCKET_DEFAULT_MIN_LINK_M;
    turns = defaultTurns(dir.laneCount, addPocket);
    turnsProvenance = "default";
    if (addPocket) {
      turns = [["left"], ...turns];
      pocket = { startS: lengthM - POCKET_DEFAULT_LENGTH_M, byRule: true };
    }
  }

  const laneCount = turns.length;
  const busIndex = dir.busLane ? laneCount - 1 : -1;
  const lanes: Lane[] = [];
  for (let i = 0; i < laneCount; i++) {
    const id = `${linkId}:${i}`;
    const isPocket = pocket !== undefined && i === 0;
    const isBus = i === busIndex;
    const provenance: ProvenanceMap = { turns: turnsProvenance };
    const lane: Lane = {
      id,
      linkId,
      index: i,
      widthM: LANE_WIDTH_M,
      startS: 0,
      endS: round(lengthM),
      kind: isPocket ? "turn_pocket" : isBus ? "bus" : "general",
      allowed: isBus ? [...PT_CLASSES] : [...ALL_CLASSES],
      turns: [...(turns[i] ?? ["through"])],
      provenance,
    };
    if (turnsProvenance === "default") input.assumptions.add("turns_default", id);
    if (isPocket && pocket !== undefined) {
      lane.startS = round(Math.max(0.1, pocket.startS), 1);
      provenance.startS = "default";
      input.assumptions.add(pocket.byRule ? "left_pocket_default" : "pocket_length_default", id);
    }
    if (isBus) {
      lane.busLane = {
        allowed: [...PT_CLASSES],
        activeFromMin: 0,
        activeToMin: 1440,
        carsMayEnterForRightTurnWithinM: BUS_LANE_RIGHT_TURN_ENTRY_M,
      };
      provenance.busLane = "osm";
      provenance.busLaneHours = "default";
      input.assumptions.add("bus_lane_hours_default", id);
      if (dir.busLaneMisplaced) input.assumptions.add("bus_lane_position_assumed", id);
    }
    lanes.push(lane);
  }
  return lanes;
}

function isLeftOnly(turns: readonly TurnKind[]): boolean {
  return turns.length === 1 && turns[0] === "left";
}
