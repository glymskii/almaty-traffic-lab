/**
 * Nuance tests N21-N22: routing and demand. Fixtures: corridor(parallelStreet), crossroads. Closed by T-12, T-19.
 */
import { defaultSimConfig, type Network } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { corridor, crossroads } from "../fixtures/builders.ts";

/**
 * The corridor with its parallel residential street, with only the two ends of the arterial
 * generating traffic: every trip wants to cross the whole corridor, so anything measured on the
 * parallel street is a detour and nothing else. (With the cross-street gates active the residential
 * street also carries its own local traffic, which drowns the signal we are after.)
 */
function throughCorridor(): Network {
  const base = corridor({ parallelStreet: true });
  return {
    ...base,
    gates: base.gates.map((g) =>
      g.id === "corridor.W.g" || g.id === "corridor.E.g" ? g : { ...g, weightIn: 0, weightOut: 0 },
    ),
  };
}

const NETWORK = throughCorridor();
const WARMUP_MIN = 3;
const RUN_MIN = 8;

/** Distinct vehicles seen on the parallel street over the measurement window. */
function parallelStreetFlow(navigatorShare: number) {
  const sim = createSimulation({
    network: NETWORK,
    config: defaultSimConfig({
      seed: 1,
      demand: {
        tripsPerHourPeak: 4000,
        warmupMinutes: WARMUP_MIN,
        vehicleBudget: 4000,
        navigatorShare,
        rerouteIntervalS: 60,
      },
    }),
  });
  const { runtime, pool } = kernelOf(sim);
  const parallelLanes = new Set<number>();
  for (let lane = 0; lane < runtime.laneCount; lane++) {
    const id = runtime.linkIds[runtime.trackLink[lane] as number] as string;
    if (id.startsWith("res")) parallelLanes.add(lane);
  }
  expect(parallelLanes.size).toBeGreaterThan(0);

  const seen = new Set<number>();
  sim.runUntil(WARMUP_MIN * 60);
  while (sim.simTimeS < (WARMUP_MIN + RUN_MIN) * 60) {
    sim.step();
    for (let i = 0; i < pool.highWater; i++) {
      const t = pool.track[i] as number;
      if (t >= 0 && parallelLanes.has(t)) seen.add(pool.id[i] as number);
    }
  }
  expect(kernelOf(sim).droppedVehicles).toBe(0);
  return { flow: seen.size, stats: sim.tripStats() };
}

describe("N21 navigator re-routing", () => {
  it("with the arterial saturated, navigatorShare 0.5 sends more flow to the parallel street than navigatorShare 0", {
    timeout: 60_000,
  }, () => {
    const without = parallelStreetFlow(0);
    const half = parallelStreetFlow(0.5);

    // The arterial really is the bottleneck: trips take minutes longer than free flow.
    expect(without.stats.total.meanTripDelayS).toBeGreaterThan(100);
    // Static costs alone almost never prefer the detour (it is longer and slower); live travel
    // times do, and half the drivers follow them.
    expect(half.flow).toBeGreaterThan(without.flow * 3);
    expect(half.flow).toBeGreaterThan(30);
    // The detour is a re-route, not extra demand: at least as many trips finish.
    expect(half.stats.total.completed).toBeGreaterThanOrEqual(without.stats.total.completed);
  });
});

/**
 * A crossroads whose north approach is the one under pressure: half of its demand turns left,
 * permissively and without a pocket, while the other three arms only go straight. The north-south
 * street holds 70 % of the green, so a red light is not what limits the north approach -- the gaps
 * in the opposing through flow are.
 */
const TIPPING_NETWORK = crossroads({
  leftPocketM: 0,
  leftTurnMode: "permissive",
  greenSplitNS: 0.7,
});
const TIPPING_TRIPS_PER_HOUR = 2000;
const TIPPING_WARMUP_MIN = 3;
const TIPPING_RUN_MIN = 10;

function reportAtMultiplier(multiplier: number) {
  const sim = createSimulation({
    network: TIPPING_NETWORK,
    config: defaultSimConfig({
      seed: 1,
      demand: {
        tripsPerHourPeak: TIPPING_TRIPS_PER_HOUR,
        multiplier,
        warmupMinutes: TIPPING_WARMUP_MIN,
        vehicleBudget: 4000,
      },
    }),
  });
  kernelOf(sim).setTurnShares("N.in", { left: 0.5, through: 0.5 });
  for (const dir of ["E", "S", "W"]) kernelOf(sim).setTurnShares(`${dir}.in`, { through: 1 });
  sim.runUntil((TIPPING_WARMUP_MIN + TIPPING_RUN_MIN) * 60);
  return sim.report();
}

describe("N22 demand tipping point", () => {
  it("demand multiplier 0.5 produces no bottleneck; 1.5 produces one on the expected approach", {
    timeout: 120_000,
  }, () => {
    const light = reportAtMultiplier(0.5);
    // Traffic is not free -- a signal always costs something -- but nothing passes all three
    // conditions of D11 at half the demand.
    expect(light.totals.delayVehH).toBeGreaterThan(0);
    expect(light.items).toEqual([]);

    const heavy = reportAtMultiplier(1.5);
    expect(heavy.items.length).toBeGreaterThan(0);
    const top = heavy.items[0];
    expect(top?.id).toBe("N.in:center");
    expect(top?.nodeId).toBe("center");
    expect(top?.title).toBe("center, подход с севера");
    // Three times the demand of the light run buys much more than three times the delay.
    expect(heavy.totals.delayVehH).toBeGreaterThan(light.totals.delayVehH * 3);
  });
});
