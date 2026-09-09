/**
 * Audit tests (T-21): every distribution in `DriverParams` (contracts/src/sim-config.ts) is actually
 * sampled per driver (`models/driver.ts`) *and* measurably changes the simulated trajectory once its
 * spread is non-zero -- as opposed to being sampled into a pool array that nothing downstream reads.
 * `desiredSpeedFactor` already has its own nuance test (N03, test/nuances/01-longitudinal.test.ts);
 * this file covers the other seven fields, each on a scenario that actually exercises the mechanism
 * the field feeds (car-following, discretionary lane changes, a permissive left turn, an unsignalized
 * merge, pedestrian yield). See the sim-core README ("Параметр -> где используется") for the full
 * parameter -> code-site map this audit is checking against.
 *
 * Same method throughout: run the identical seed/network/demand twice, touching only the one field
 * under test -- zero spread vs the schema's own default spread, same mean/min/max both times -- and
 * compare `trajectoryHash()`. `Rng.sample` always draws the same number of underlying floats
 * regardless of `sd` (see `rng.ts`: `normal()` never short-circuits on `sd`), so every other random
 * stream stays in lockstep between the two runs and any divergence is this field's doing.
 */
import { defaultSimConfig, type SimConfigPatch, type TurnKind } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, mergeRamp, straightRoad } from "../fixtures/builders.ts";

type TurnShares = [linkId: string, shares: Partial<Record<TurnKind, number>>];

function hashAfter(
  network: ReturnType<typeof straightRoad>,
  patch: SimConfigPatch,
  seconds: number,
  turnShares: TurnShares[] = [],
): string {
  const sim = createSimulation({ network, config: defaultSimConfig(patch) });
  for (const [linkId, shares] of turnShares) kernelOf(sim).setTurnShares(linkId, shares);
  sim.runUntil(seconds);
  return sim.trajectoryHash();
}

describe("driver heterogeneity audit", () => {
  it("timeHeadwayS: sd = 0 vs default sd changes the trajectory", () => {
    const network = crossroads();
    const demand = { tripsPerHourPeak: 1800, warmupMinutes: 1, vehicleBudget: 1500 };
    const withNoise = hashAfter(network, { seed: 5, demand }, 300);
    const zeroSd = hashAfter(
      network,
      { seed: 5, demand, driver: { timeHeadwayS: { mean: 1.2, sd: 0, min: 0.6, max: 2.5 } } },
      300,
    );
    expect(zeroSd).not.toBe(withNoise);
  });

  it("minGapM: sd = 0 vs default sd changes the trajectory", () => {
    const network = crossroads();
    const demand = { tripsPerHourPeak: 1800, warmupMinutes: 1, vehicleBudget: 1500 };
    const withNoise = hashAfter(network, { seed: 5, demand }, 300);
    const zeroSd = hashAfter(
      network,
      { seed: 5, demand, driver: { minGapM: { mean: 2.0, sd: 0, min: 1.0, max: 4.0 } } },
      300,
    );
    expect(zeroSd).not.toBe(withNoise);
  });

  // Discretionary lane changes need a scenario with no mandatory turn requirement: a straight road
  // gives every lane choice bias = 0 (mandatoryBias), so politeness and the switching threshold are
  // what decides whether an overtake happens, not a forced turn-lane manoeuvre (models/mobil.ts).
  it("politeness: sd = 0 vs default sd changes the trajectory", () => {
    const network = straightRoad({ lanes: 2 });
    const demand = { tripsPerHourPeak: 2400, warmupMinutes: 1, vehicleBudget: 1500 };
    const withNoise = hashAfter(network, { seed: 3, demand }, 300);
    const zeroSd = hashAfter(
      network,
      { seed: 3, demand, driver: { politeness: { mean: 0.3, sd: 0, min: 0.0, max: 1.0 } } },
      300,
    );
    expect(zeroSd).not.toBe(withNoise);
  });

  it("laneChangeThresholdMps2: sd = 0 vs default sd changes the trajectory", () => {
    const network = straightRoad({ lanes: 2 });
    const demand = { tripsPerHourPeak: 2400, warmupMinutes: 1, vehicleBudget: 1500 };
    const withNoise = hashAfter(network, { seed: 3, demand }, 300);
    const zeroSd = hashAfter(
      network,
      {
        seed: 3,
        demand,
        driver: { laneChangeThresholdMps2: { mean: 0.2, sd: 0, min: 0.05, max: 0.5 } },
      },
      300,
    );
    expect(zeroSd).not.toBe(withNoise);
  });

  // Forces every N/S trip to turn left across the permissive opposing through stream, so the
  // critical-gap draw for a permissive left turn (simulation.ts) fires on essentially every arrival.
  it("criticalGapLeftTurnS: sd = 0 vs default sd changes the trajectory", () => {
    const network = crossroads({ leftPocketM: 0, leftTurnMode: "permissive" });
    const demand = { tripsPerHourPeak: 1800, warmupMinutes: 1, vehicleBudget: 1500 };
    const shares: TurnShares[] = [
      ["N.in", { left: 1 }],
      ["S.in", { left: 1 }],
    ];
    const withNoise = hashAfter(network, { seed: 5, demand }, 300, shares);
    const zeroSd = hashAfter(
      network,
      {
        seed: 5,
        demand,
        driver: { criticalGapLeftTurnS: { mean: 5.0, sd: 0, min: 3.5, max: 7.5 } },
      },
      300,
      shares,
    );
    expect(zeroSd).not.toBe(withNoise);
  });

  /**
   * High ramp flow onto the mainline, bare yield (N20's setup): `pool.gapMerge` (this field) is read
   * on every ramp arrival's conflict check (simulation.ts's `conflictStopDistance`).
   *
   * Deliberately NOT the schema's own default range here (mean 3.5, [2.5, 5.0]) -- a calibration gap
   * found while writing this test, worth recording: the mainline in `mergeRamp()` runs at 80 km/h
   * (22.2 m/s) and the feeding-lane threat scan is capped at `APPROACH_SCAN_M = 40` m
   * (runtime/intersections.ts), so the largest threat time that scan can ever report is
   * 40 / 22.2 = 1.8 s -- below the whole default range once the connector's own fixed margin
   * (`CONFLICT_STOP_MARGIN_M + CONFLICT_ZONE_M + length) / CONFLICT_CROSSING_MPS` = 1.8 s is added
   * (simulation.ts). Every value in [2.5, 5.0] therefore yields the identical "always yield when
   * anyone is in range" decision on this fixture -- confirmed by sweeping seed/demand/gate-weight
   * combinations, all bit-identical trajectories. Root cause is the same `APPROACH_SCAN_M` constant
   * T-11 already flagged as too short for a reliable critical-gap decision at `crossroads()` (a
   * different symptom there: real safety-margin violations, docs/NUANCES.md N19's notes) -- fixing
   * it is a calibration task, out of this task's scope (see the README audit table and the task
   * report). The range below demonstrates the field is genuinely wired and load-bearing once it
   * lands inside the reachable window.
   */
  it("criticalGapMergeS: sd = 0 vs sd > 0 changes the trajectory", () => {
    const network = mergeRamp();
    for (const gate of network.gates) {
      if (gate.id === "g.ramp") gate.weightIn = 4;
      if (gate.id === "g.w") gate.weightIn = 1;
    }
    const demand = { tripsPerHourPeak: 1800, warmupMinutes: 2, vehicleBudget: 1500 };
    const withNoise = hashAfter(
      network,
      {
        seed: 4,
        demand,
        driver: { criticalGapMergeS: { mean: 1.0, sd: 0.5, min: 0.1, max: 2.5 } },
      },
      900,
    );
    const zeroSd = hashAfter(
      network,
      { seed: 4, demand, driver: { criticalGapMergeS: { mean: 1.0, sd: 0, min: 0.1, max: 2.5 } } },
      900,
    );
    expect(zeroSd).not.toBe(withNoise);
  });

  // Right turns from N/S share their outgoing arm's crosswalk with a busy pedestrian flow (N18's
  // setup): the yield critical-gap draw fires on most crossings.
  it("criticalGapPedestrianS: sd = 0 vs default sd changes the trajectory", () => {
    const network = crossroads({ crosswalks: true, leftTurnMode: "protected" });
    const busyPedestrianProfile = new Array(24).fill(900);
    const demand = { tripsPerHourPeak: 1800, warmupMinutes: 1, vehicleBudget: 1500 };
    const pedestrians = { enabled: true, hourlyRatePerCrosswalk: busyPedestrianProfile };
    const shares: TurnShares[] = [
      ["N.in", { right: 1 }],
      ["S.in", { right: 1 }],
    ];
    const withNoise = hashAfter(network, { seed: 6, demand, pedestrians }, 300, shares);
    const zeroSd = hashAfter(
      network,
      {
        seed: 6,
        demand,
        pedestrians,
        driver: { criticalGapPedestrianS: { mean: 4.0, sd: 0, min: 2.5, max: 6.0 } },
      },
      300,
      shares,
    );
    expect(zeroSd).not.toBe(withNoise);
  });
});
