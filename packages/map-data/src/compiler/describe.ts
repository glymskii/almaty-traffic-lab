import type { Network } from "@atl/contracts";
import { compassIndex, headingAtEnd, negate } from "../geometry/angles.ts";

/**
 * Where an approach comes from, in the genitive case, indexed by `compassIndex`
 * (0 = east ... 7 = south-east). UI-facing wording lives in `apps/web/src/i18n/ru.ts`; these
 * strings are part of the compiled description of the network itself (T-19, T-25).
 */
export const APPROACH_FROM_RU: readonly string[] = [
  "востока",
  "северо-востока",
  "севера",
  "северо-запада",
  "запада",
  "юго-запада",
  "юга",
  "юго-востока",
];

/** Compass sector an approach link arrives from: 0 = east, 2 = north, 4 = west, 6 = south. */
export function approachCompassIndex(net: Network, linkId: string): number {
  const link = net.links.find((l) => l.id === linkId);
  if (link === undefined) throw new Error(`describeApproach: no link ${linkId}`);
  return compassIndex(negate(headingAtEnd(link.geometry)));
}

/** Human-readable direction of an approach for the UI and the explanations: "подход с запада". */
export function describeApproach(net: Network, linkId: string): string {
  return `подход с ${APPROACH_FROM_RU[approachCompassIndex(net, linkId)] ?? ""}`;
}
