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
/** Links shorter than that: the pocket takes this share of the link (continuous at 200 m: 0.4 · 200 = 80). */
export const POCKET_TAGGED_SHORT_LENGTH_SHARE = 0.4;
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
function turnLaneEntries(value: string | undefined): number | undefined {
  return value === undefined ? undefined : value.split("|").length;
}

function resolveLaneCount(
  tags: Tags,
  travel: TravelDirection,
  ctx: DirectionParseContext,
): LaneCountResolution {
  const osm = (count: number): LaneCountResolution => ({
    count,
    provenance: "osm",
    source: "lanes",
  });
  const wd = wayDirectionOf(travel, ctx);
  const otherWd: TravelDirection = wd === "forward" ? "backward" : "forward";
  const own = tags[`lanes:${wd}`];
  if (own !== undefined) {
    const n = parsePositiveInt(own);
    if (n !== undefined) return osm(n);
    ctx.warn(`way ${ctx.wayId}: cannot parse lanes:${wd}="${own}"`);
  }
  const totalRaw = tags.lanes;
  const total = parsePositiveInt(totalRaw);
  if (totalRaw !== undefined && total === undefined)
    ctx.warn(`way ${ctx.wayId}: cannot parse lanes="${totalRaw}"`);
  if (total !== undefined) {
    const other = parsePositiveInt(tags[`lanes:${otherWd}`]);
    if (other !== undefined) {
      // `lanes` minus the other direction's explicit count; one-way streets sometimes carry a stale
      // lanes:backward, in which case `lanes` alone wins.
      if (total - other >= 1) return osm(total - other);
      if (ctx.oneway) return osm(total);
      ctx.warn(
        `way ${ctx.wayId}: lanes=${total} leaves no lane ${wd} after lanes:${otherWd}=${other}; using the class default`,
      );
    } else if (ctx.oneway) {
      return osm(total);
    } else {
      // Per-lane tags reveal how the total splits between the directions.
      const ownTurns = turnLaneEntries(tags[`turn:lanes:${wd}`]);
      const otherTurns = turnLaneEntries(tags[`turn:lanes:${otherWd}`]);
      if (ownTurns !== undefined && otherTurns !== undefined && ownTurns + otherTurns === total)
        return osm(ownTurns);
      if (ownTurns !== undefined && otherTurns === undefined && ownTurns <= total - 1)
        return osm(ownTurns);
      if (ownTurns === undefined && otherTurns !== undefined && total - otherTurns >= 1)
        return osm(total - otherTurns);
      const share = wd === "forward" ? Math.ceil(total / 2) : Math.floor(total / 2);
      if (share >= 1) return osm(share);
      ctx.warn(
        `way ${ctx.wayId}: lanes=${total} on a two-way street; assuming one lane ${wd} (default)`,
      );
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
    let perDirection = n;
    if (own === undefined && !ctx.oneway) {
      // An undirected count on a two-way street covers both directions; a single lane is ambiguous.
      if (n === 1)
        ctx.warn(
          `way ${ctx.wayId}: ${base}=1 on a two-way street without direction; assuming a bus lane in both directions`,
        );
      perDirection = Math.ceil(n / 2);
    }
    if (perDirection > 1)
      ctx.warn(
        `way ${ctx.wayId}: ${base}=${n} means ${perDirection} bus lanes ${travel}; only one is modelled`,
      );
    return { designated: true, misplaced: false };
  }
  const check = (value: string | undefined, tag: string): boolean => {
    if (value === undefined || value === "no" || value === "none") return false;
    // Almaty mappers write busway:left=yes as often as =lane.
    if (value === "lane" || value === "yes") return true;
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
  if (turns !== undefined) {
    const contradiction = ctx.oneway && laneCountSource === "lanes" && turns.length !== laneCount;
    if (contradiction)
      ctx.warn(
        `way ${ctx.wayId}: lanes=${laneCount} contradicts turn:lanes with ${turns.length} entries on a one-way street; using turn:lanes`,
      );
    if (laneCountSource === "default" || contradiction) {
      // Per-lane tags are the more deliberate statement; on one-way streets a stale `lanes` loses to them.
      laneCount = turns.length;
      laneCountProvenance = "osm";
      laneCountSource = "turn_lanes";
    }
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
// Lane plan and lane objects for a link
// ---------------------------------------------------------------------------

export interface LanePlanInput {
  dir: DirectionAttrs;
  highwayClass: HighwayClass;
  toNodeKind: NodeKind;
  /** Centreline length; the pocket rules need it before the offset geometry exists. */
  lengthM: number;
}

/** Decided before the geometry: the lane count sets the carriageway width and therefore the offset. */
export interface LanePlan {
  /** Turns per lane, leftmost first, including a pocket lane added by rule. */
  turns: TurnKind[][];
  turnsProvenance: Provenance;
  /** Leftmost lane is a left-turn pocket; `byRule` when the generator added it (not in OSM). */
  pocket?: { byRule: boolean };
  /** = turns.length */
  laneCount: number;
  /** Index of the bus lane, -1 when none. */
  busIndex: number;
}

/** Applies the turn defaults and both left-pocket rules; see README "Правила дефолтов". */
export function planLanes(input: LanePlanInput): LanePlan {
  const { dir, lengthM } = input;
  const generalCount = dir.laneCount - (dir.busLane ? 1 : 0);
  if (dir.turns !== undefined) {
    const leftmost = dir.turns[0];
    const pocket = dir.laneCount >= 2 && leftmost !== undefined && isLeftOnly(leftmost);
    return {
      turns: dir.turns,
      turnsProvenance: "osm",
      ...(pocket ? { pocket: { byRule: false } } : {}),
      laneCount: dir.turns.length,
      busIndex: dir.busLane ? dir.turns.length - 1 : -1,
    };
  }
  const addPocket =
    input.toNodeKind === "signalized" &&
    generalCount >= POCKET_DEFAULT_MIN_LANES &&
    POCKET_DEFAULT_CLASSES.has(input.highwayClass) &&
    lengthM >= POCKET_DEFAULT_MIN_LINK_M;
  const turns = defaultTurns(dir.laneCount, addPocket);
  if (addPocket) turns.unshift(["left"]);
  return {
    turns,
    turnsProvenance: "default",
    ...(addPocket ? { pocket: { byRule: true } } : {}),
    laneCount: turns.length,
    busIndex: dir.busLane ? turns.length - 1 : -1,
  };
}

/** Where a pocket opens: 80 m before the end (links ≥ 200 m), 40 % of the link otherwise; 60 m for rule pockets. */
export function pocketStartS(lengthM: number, byRule: boolean): number {
  if (byRule) return lengthM - POCKET_DEFAULT_LENGTH_M;
  if (lengthM >= POCKET_TAGGED_MIN_LINK_M) return lengthM - POCKET_TAGGED_LENGTH_M;
  return lengthM * (1 - POCKET_TAGGED_SHORT_LENGTH_SHARE);
}

export interface LaneBuildInput {
  linkId: string;
  /** Final link length (offset geometry). */
  lengthM: number;
  plan: LanePlan;
  dir: DirectionAttrs;
  assumptions: AssumptionCollector;
}

/** Lane objects for one link, leftmost first, with provenance; records every default in the collector. */
export function buildLanes(input: LaneBuildInput): Lane[] {
  const { plan, dir, lengthM, linkId } = input;
  const lanes: Lane[] = [];
  for (let i = 0; i < plan.laneCount; i++) {
    const id = `${linkId}:${i}`;
    const isPocket = plan.pocket !== undefined && i === 0;
    const isBus = i === plan.busIndex;
    const provenance: ProvenanceMap = { turns: plan.turnsProvenance };
    const lane: Lane = {
      id,
      linkId,
      index: i,
      widthM: LANE_WIDTH_M,
      startS: 0,
      endS: round(lengthM),
      kind: isPocket ? "turn_pocket" : isBus ? "bus" : "general",
      allowed: isBus ? [...PT_CLASSES] : [...ALL_CLASSES],
      turns: [...(plan.turns[i] ?? ["through"])],
      provenance,
    };
    if (plan.turnsProvenance === "default") input.assumptions.add("turns_default", id);
    if (isPocket && plan.pocket !== undefined) {
      lane.startS = round(Math.max(0.1, pocketStartS(lengthM, plan.pocket.byRule)), 1);
      provenance.startS = "default";
      input.assumptions.add(
        plan.pocket.byRule ? "left_pocket_default" : "pocket_length_default",
        id,
      );
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
