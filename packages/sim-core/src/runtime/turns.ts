import type { TurnKind } from "@atl/contracts";

/**
 * Integer codes for `TurnKind` (contracts/src/common.ts), used in typed arrays and bit masks.
 * Stable and append-only, like the cause codes.
 */
export const TurnCode: Record<TurnKind, number> = {
  through: 0,
  left: 1,
  right: 2,
  uturn: 3,
  merge: 4,
  diverge: 5,
};

export const TURN_COUNT = 6;
export const TURN_KIND_BY_CODE: readonly TurnKind[] = [
  "through",
  "left",
  "right",
  "uturn",
  "merge",
  "diverge",
];

/** Bit of a turn inside a turn mask. */
export function turnBit(code: number): number {
  return 1 << code;
}
