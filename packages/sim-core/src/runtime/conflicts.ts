import type { Network } from "@atl/contracts";
import type { RuntimeNetwork } from "./network.ts";

/** `ConflictPoint.priority`, see contracts/src/network.ts. `signal` = the controller resolves it. */
export const PriorityCode = {
  this: 0,
  other: 1,
  signal: 2,
} as const;

/**
 * Flat table of the conflict points of every connector (T-11). `Connector.conflicts` is a list of
 * string ids, which the hot loop cannot use: this is the same information indexed by track, in one
 * CSR block per connector track (lanes keep an empty range).
 *
 * A crossing is stored twice, once on each side, exactly as the network holds it: entry `k` of
 * track `t` says "my path meets `conflictOther[k]` at `conflictSThis[k]` along me and at
 * `conflictSOther[k]` along it". Entries of one track are sorted by `conflictSThis` ascending (ties
 * broken by the other track's index), so a vehicle can stop at the first point it may not cross and
 * the traversal order never depends on the network's own ordering.
 *
 * Right of way comes from `conflictPriority` only, never from `Connector.protection`: two `priority`
 * movements of an unsignalized T-junction do cross, and the pair carries `this`/`other` for them
 * (docs/CONTRACTS.md, "Право проезда").
 */
export class ConflictTable {
  /** Number of stored (connector, conflict point) entries. */
  readonly pairCount: number;
  /** CSR: first entry of a track, and how many it has (0 for lanes). */
  readonly conflictStart: Int32Array;
  readonly conflictCount: Int32Array;
  /** Track index of the other connector. */
  readonly conflictOther: Int32Array;
  /** Distance to the point along this connector, metres. */
  readonly conflictSThis: Float64Array;
  /** Distance to the same point along the other connector, metres. */
  readonly conflictSOther: Float64Array;
  /** See PriorityCode. */
  readonly conflictPriority: Uint8Array;

  constructor(net: Network, rt: RuntimeNetwork) {
    const trackCount = rt.trackCount;
    this.conflictStart = new Int32Array(trackCount);
    this.conflictCount = new Int32Array(trackCount);

    // Pass 1: count the entries that resolve to a known connector.
    let total = 0;
    for (let c = 0; c < rt.connectorCount; c++) {
      const conn = net.connectors[c];
      if (!conn) continue;
      let count = 0;
      for (const cp of conn.conflicts) {
        if (rt.connectorIndex.get(cp.otherConnectorId) !== undefined) count++;
      }
      this.conflictCount[rt.laneCount + c] = count;
      total += count;
    }
    this.pairCount = total;
    let cursor = 0;
    for (let t = 0; t < trackCount; t++) {
      this.conflictStart[t] = cursor;
      cursor += this.conflictCount[t] as number;
    }

    this.conflictOther = new Int32Array(total);
    this.conflictSThis = new Float64Array(total);
    this.conflictSOther = new Float64Array(total);
    this.conflictPriority = new Uint8Array(total);

    // Pass 2: fill each block, sorted by distance along this connector.
    const scratch: { other: number; sThis: number; sOther: number; priority: number }[] = [];
    for (let c = 0; c < rt.connectorCount; c++) {
      const conn = net.connectors[c];
      if (!conn) continue;
      const t = rt.laneCount + c;
      scratch.length = 0;
      for (const cp of conn.conflicts) {
        const otherIdx = rt.connectorIndex.get(cp.otherConnectorId);
        if (otherIdx === undefined) continue;
        scratch.push({
          other: rt.laneCount + otherIdx,
          sThis: cp.sThisM,
          sOther: cp.sOtherM,
          priority: PriorityCode[cp.priority],
        });
      }
      scratch.sort((a, b) => (a.sThis !== b.sThis ? a.sThis - b.sThis : a.other - b.other));
      const start = this.conflictStart[t] as number;
      for (let k = 0; k < scratch.length; k++) {
        const e = scratch[k] as (typeof scratch)[number];
        this.conflictOther[start + k] = e.other;
        this.conflictSThis[start + k] = e.sThis;
        this.conflictSOther[start + k] = e.sOther;
        this.conflictPriority[start + k] = e.priority;
      }
    }
  }
}
