/**
 * Nuance tests N09-N13: left turns, pockets, additional sections. Fixture: crossroads. Closed by T-10, T-11, T-12, T-22.
 */
import { defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { TurnCode } from "../../src/runtime/turns.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier } from "../fixtures/builders.ts";

const WARMUP_MIN = 3;
const RUN_MIN = 10;
/** Share of the approach demand that turns left, forced through the kernel until routing (T-12). */
const LEFT_SHARE = 0.4;

/**
 * Vehicles that crossed the intersection on a through movement from the north approach over the
 * measurement window. Counting occupants of the through connectors is the pre-metrics (T-18) way to
 * measure a movement's throughput.
 */
function throughFlowFromNorth(leftPocketM: number): number {
  const network = crossroads({ leftPocketM });
  const config = defaultSimConfig({
    seed: 1,
    demand: {
      multiplier: saturationMultiplier(network) * 1.2,
      warmupMinutes: WARMUP_MIN,
      vehicleBudget: 4000,
    },
  });
  const sim = createSimulation({ network, config });
  const { runtime, pool } = kernelOf(sim);
  for (const dir of ["N", "E", "S", "W"]) {
    kernelOf(sim).setTurnShares(`${dir}.in`, { left: LEFT_SHARE, through: 1 - LEFT_SHARE });
  }
  const throughTracks: number[] = [];
  for (let c = 0; c < runtime.connectorCount; c++) {
    const track = runtime.laneCount + c;
    const id = runtime.connectorIds[c] as string;
    if (id.startsWith("N.in:") && (runtime.connTurn[track] as number) === TurnCode.through) {
      throughTracks.push(track);
    }
  }
  expect(throughTracks.length).toBeGreaterThan(0);

  const seen = new Set<number>();
  sim.runUntil(WARMUP_MIN * 60);
  while (sim.simTimeS < (WARMUP_MIN + RUN_MIN) * 60) {
    sim.step();
    for (const track of throughTracks) {
      let i = pool.trackTail[track] as number;
      while (i >= 0) {
        seen.add(pool.id[i] as number);
        i = pool.ahead[i] as number;
      }
    }
  }
  expect(kernelOf(sim).droppedVehicles).toBe(0);
  return seen.size;
}

describe("N09 pocket spillback", () => {
  it("with high left demand a 40 m pocket yields lower through throughput than a 120 m pocket", () => {
    const short = throughFlowFromNorth(40);
    const long = throughFlowFromNorth(120);
    expect(short).toBeGreaterThan(50); // both configurations really move traffic
    expect(long).toBeGreaterThan(50);
    // The short pocket overflows: left-turners wait in the through lane and hold it up.
    expect(short).toBeLessThan(long * 0.95);
  });

  it.todo("root cause pocket_spillback share on the affected approach > 20% (needs T-18 metrics)");
});

describe("N10 permissive left without pocket", () => {
  it.todo(
    "left-turners waiting for gaps block the leftmost through lane; dominant cause gap_left_turn",
  );
});

describe("N11 protected arrow", () => {
  it.todo("protected mode gives lower left-turn delay than permissive at the same demand");
  it.todo("protected mode does not increase opposing through delay at low left demand");
});

describe("N12 arrow off = prohibited", () => {
  it.todo(
    "during main green with the arrow OFF no left-turn vehicle enters the intersection; cause arrow_off appears",
  );
});

describe("N13 prohibited left", () => {
  it.todo("no vehicle uses a left connector; routing sends left-bound trips around the block");
});
