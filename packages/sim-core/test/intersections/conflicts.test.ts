/**
 * Conflict-point table (T-11): the flat, track-indexed view of `Connector.conflicts` that the hot
 * loop uses. Fixtures: tJunction (unsignalized, real `this`/`other` right of way), crossroads.
 */
import { describe, expect, it } from "vitest";
import { ConflictTable, PriorityCode } from "../../src/runtime/conflicts.ts";
import { RuntimeNetwork } from "../../src/runtime/network.ts";
import { crossroads, tJunction } from "../fixtures/builders.ts";

const SEGMENT_M = 25;

describe("ConflictTable", () => {
  const net = tJunction();
  const rt = new RuntimeNetwork(net, SEGMENT_M);
  const table = new ConflictTable(net, rt);
  const trackOf = (id: string): number => {
    const c = rt.connectorIndex.get(id);
    if (c === undefined) throw new Error(`fixture: connector ${id} missing`);
    return rt.laneCount + c;
  };

  it("stores every conflict of every connector and nothing for lanes", () => {
    let expected = 0;
    for (const c of net.connectors) expected += c.conflicts.length;
    expect(table.pairCount).toBe(expected);
    expect(expected).toBeGreaterThan(0);
    for (let lane = 0; lane < rt.laneCount; lane++) expect(table.conflictCount[lane]).toBe(0);
  });

  it("indexes the other movement by track and keeps both distances", () => {
    const t = trackOf("S.in:0>W.out:0");
    const start = table.conflictStart[t] as number;
    const count = table.conflictCount[t] as number;
    expect(count).toBeGreaterThan(0);
    for (let k = start; k < start + count; k++) {
      const other = table.conflictOther[k] as number;
      expect(other).toBeGreaterThanOrEqual(rt.laneCount);
      const otherId = rt.connectorIds[other - rt.laneCount] as string;
      const declared = net.connectors
        .find((c) => c.id === "S.in:0>W.out:0")
        ?.conflicts.find((cp) => cp.otherConnectorId === otherId);
      expect(declared).toBeDefined();
      expect(table.conflictSThis[k]).toBeCloseTo(declared?.sThisM as number, 9);
      expect(table.conflictSOther[k]).toBeCloseTo(declared?.sOtherM as number, 9);
    }
  });

  it("sorts the points of one movement by distance along it", () => {
    for (let t = rt.laneCount; t < rt.trackCount; t++) {
      const start = table.conflictStart[t] as number;
      const count = table.conflictCount[t] as number;
      for (let k = start + 1; k < start + count; k++) {
        expect(table.conflictSThis[k] as number).toBeGreaterThanOrEqual(
          table.conflictSThis[k - 1] as number,
        );
      }
    }
  });

  it("keeps a crossing symmetric: each side sees the other with the mirrored right of way", () => {
    const mirror = {
      [PriorityCode.this]: PriorityCode.other,
      [PriorityCode.other]: PriorityCode.this,
      [PriorityCode.signal]: PriorityCode.signal,
    };
    for (let t = rt.laneCount; t < rt.trackCount; t++) {
      const start = table.conflictStart[t] as number;
      const count = table.conflictCount[t] as number;
      for (let k = start; k < start + count; k++) {
        const other = table.conflictOther[k] as number;
        const os = table.conflictStart[other] as number;
        const oc = table.conflictCount[other] as number;
        let found = false;
        for (let m = os; m < os + oc; m++) {
          if ((table.conflictOther[m] as number) !== t) continue;
          if (
            Math.abs((table.conflictSThis[m] as number) - (table.conflictSOther[k] as number)) >
            1e-9
          )
            continue;
          found = true;
          expect(table.conflictSOther[m]).toBeCloseTo(table.conflictSThis[k] as number, 9);
          expect(table.conflictPriority[m]).toBe(
            mirror[table.conflictPriority[k] as keyof typeof mirror],
          );
        }
        expect(found).toBe(true);
      }
    }
  });

  it("takes right of way from the conflict point, not from the connector's protection", () => {
    // Both main-road movements of the T-junction are `priority`, yet the main left gives way to the
    // opposing main through: the pair carries this/other, and only that decides (docs/CONTRACTS.md).
    const left = trackOf("E.in:0>S.out:0");
    const through = trackOf("W.in:0>E.out:0");
    const leftStart = table.conflictStart[left] as number;
    const leftCount = table.conflictCount[left] as number;
    let seen = 0;
    for (let k = leftStart; k < leftStart + leftCount; k++) {
      if ((table.conflictOther[k] as number) !== through) continue;
      expect(table.conflictPriority[k]).toBe(PriorityCode.other);
      seen++;
    }
    expect(seen).toBe(1);
  });

  it("marks a signalized junction's crossings as resolved by the controller", () => {
    const signalized = crossroads({ leftPocketM: 0, leftTurnMode: "permissive" });
    const srt = new RuntimeNetwork(signalized, SEGMENT_M);
    const stable = new ConflictTable(signalized, srt);
    expect(stable.pairCount).toBeGreaterThan(0);
    for (let k = 0; k < stable.pairCount; k++) {
      expect(stable.conflictPriority[k]).toBe(PriorityCode.signal);
    }
  });
});
