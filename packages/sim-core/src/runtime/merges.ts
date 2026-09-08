import { type CauseCode, causeCode } from "@atl/contracts";
import { TurnCode } from "./turns.ts";

/**
 * Merge-specific constants (T-16, N20). A `merge` connector (an on-ramp joining a carriageway
 * without an intersection, `NodeKind.merge`) is not a separate code path: it reuses the generic
 * yield / gap-acceptance machinery of `IntersectionRuntime` (mandatory conflict priority `this`/
 * `other`, `mustYield`, `threatTimeS`, `pointOccupied`/`pointJammed`) and the mandatory-lane-change
 * machinery of `changeLanes`/`mandatoryBias` (an acceleration lane, `endS < link.lengthM` with
 * `turns: ["merge"]`, is just a lane a vehicle must leave before it runs out, the same as a turn
 * pocket or a dropped lane). This module holds the two things that genuinely are specific to the
 * manoeuvre: which cause a yielding movement reports, and its routing penalty.
 */

const GAP_LEFT_TURN = causeCode("gap_left_turn");
const MERGE_YIELD = causeCode("merge_yield");
const YIELD_PRIORITY = causeCode("yield_priority");

/**
 * Binding-constraint cause of a movement waiting at an unsignalized yield conflict point, by the
 * movement's own turn kind: a permissive/unsignalized left waiting for a gap in opposing traffic
 * reports `gap_left_turn`, a ramp waiting to join the carriageway it merges into reports
 * `merge_yield`, everything else that merely yields right of way (a minor-road through/right at a
 * priority junction) reports the generic `yield_priority`.
 */
export function yieldCauseByTurn(turn: number): CauseCode {
  if (turn === TurnCode.left) return GAP_LEFT_TURN;
  if (turn === TurnCode.merge) return MERGE_YIELD;
  return YIELD_PRIORITY;
}

/**
 * Manoeuvre penalty of a `merge` edge in the routing graph (T-12), seconds: joining a fast
 * carriageway from a ramp costs a driver time even on the shortest path, the same way a left turn
 * or a u-turn does (`routing/graph.ts`, `TURN_PENALTY_S`).
 */
export const MERGE_ROUTING_PENALTY_S = 5;
