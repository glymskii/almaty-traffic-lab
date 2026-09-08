/**
 * Nuance tests N23-N24: metrics in people and the detector. Closed by T-18, T-19.
 */
import { CAUSE_COUNT, causeCode, defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier } from "../fixtures/builders.ts";

const CAUSE_POCKET_SPILLBACK = causeCode("pocket_spillback");
const WARMUP_MIN = 3;
const RUN_MIN = 10;
/** Share of the north demand that turns left, forced through the kernel (as in N09). */
const LEFT_SHARE = 0.4;

describe("N23 person metrics", () => {
  it.todo(
    "bus-lane scenario with frequent buses: person-delay lower while vehicle-delay higher than baseline",
  );
});

describe("N24 detector root cause", () => {
  it.todo(
    "on a fixture with a known cause the top-1 item is the expected approach and its dominant cause matches",
  );

  it("queue members inherit the root cause of the queue head (root-cause propagation)", () => {
    // N09's fixture: a 40 m pocket against 40 % left-turning demand overflows, and the left-turners
    // that no longer fit stop in the through lane. Only the one vehicle at the mouth of the pocket
    // reports `pocket_spillback` itself -- everybody queued behind it says "the car in front". The
    // whole point of root-cause propagation is that the delay still lands on the pocket.
    const network = crossroads({ leftPocketM: 40, leftTurnMode: "protected" });
    const config = defaultSimConfig({
      seed: 1,
      demand: {
        multiplier: saturationMultiplier(network) * 1.2,
        warmupMinutes: WARMUP_MIN,
        vehicleBudget: 4000,
      },
    });
    const sim = createSimulation({ network, config });
    for (const dir of ["N", "E", "S", "W"]) {
      kernelOf(sim).setTurnShares(`${dir}.in`, { left: LEFT_SHARE, through: 1 - LEFT_SHARE });
    }
    sim.runUntil((WARMUP_MIN + RUN_MIN) * 60);

    const metrics = sim.writeMetrics();
    let bestShare = 0;
    let bestDelayS = 0;
    let approachSegments = 0;
    for (const seg of sim.segments()) {
      if (seg.linkId !== "N.in") continue;
      approachSegments++;
      const delay = metrics.delayVehS[seg.index] as number;
      if (delay <= 0) continue;
      const share = metrics.causeShare[seg.index * CAUSE_COUNT + CAUSE_POCKET_SPILLBACK] as number;
      if (share > bestShare) {
        bestShare = share;
        bestDelayS = delay;
      }
    }
    expect(approachSegments).toBeGreaterThan(0);
    // The through lane just upstream of the pocket is where the inherited cause piles up.
    expect(bestShare).toBeGreaterThanOrEqual(0.8);
    expect(bestDelayS).toBeGreaterThan(0);
  });
});
