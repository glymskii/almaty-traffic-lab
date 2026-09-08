/**
 * Kernel-level test of the yellow dilemma zone (T-09, docs/tasks/T-09-signals-runtime.md item 2):
 * a vehicle that cannot stop comfortably (decel <= comfortDecel * 1.5) proceeds through a stale
 * green instead of braking hard; one that can, stops. Mirrors the entryBlockedCause manipulation
 * pattern from test/kernel/simulation.test.ts's T-04 stop-line test, adding entryBlockedYellow.
 */
import { causeCode, defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { twoLinkRoad } from "../kernel/networks.ts";

const RED = causeCode("signal_red");
const STOP_LINE_S = 500; // trackEndS of lane l0:0 in twoLinkRoad()
const CONNECTOR_TRACK = 2; // laneCount(2) + connector index 0

function placeSingleVehicle() {
  const sim = createSimulation({
    network: twoLinkRoad(),
    config: defaultSimConfig({ demand: { tripsPerHourPeak: 200, warmupMinutes: 0 } }),
  });
  const { pool, entryBlockedCause, entryBlockedYellow } = kernelOf(sim);
  entryBlockedCause[CONNECTOR_TRACK] = RED;
  entryBlockedYellow[CONNECTOR_TRACK] = 1;
  let guard = 0;
  while (pool.activeCount === 0) {
    sim.step();
    if (++guard > 1000) throw new Error("fixture: vehicle never spawned");
  }
  const i = pool.trackHead[0] as number;
  expect(i).toBeGreaterThanOrEqual(0);
  return { sim, pool, i };
}

describe("N06 yellow dilemma zone", () => {
  it("proceeds when 5 m from the stop line at 50 km/h (cannot stop comfortably)", () => {
    const { sim, pool, i } = placeSingleVehicle();
    pool.v[i] = 50 / 3.6;
    pool.s[i] = STOP_LINE_S - 5;
    pool.a[i] = 0;
    sim.step();
    expect(pool.cause[i]).not.toBe(RED);
    expect(pool.a[i] as number).toBeGreaterThan(-1);
  });

  it("stops when 60 m from the stop line at 50 km/h (can stop comfortably)", () => {
    const { sim, pool, i } = placeSingleVehicle();
    pool.v[i] = 50 / 3.6;
    pool.s[i] = STOP_LINE_S - 60;
    pool.a[i] = 0;
    sim.step();
    expect(pool.cause[i]).toBe(RED);
    expect(pool.a[i] as number).toBeLessThan(-1);
  });
});

describe("performance", () => {
  it("400 controllers add well under 0.3 ms to a step", () => {
    const groups = [
      {
        id: "gA",
        kind: "vehicle" as const,
        section: "main" as const,
        connectorIds: [],
        crosswalkIds: [],
      },
      {
        id: "gB",
        kind: "vehicle" as const,
        section: "main" as const,
        connectorIds: [],
        crosswalkIds: [],
      },
    ];
    const phases = [
      { id: "pA", greenGroupIds: ["gA"], greenS: 20, yellowS: 3, allRedS: 2 },
      { id: "pB", greenGroupIds: ["gB"], greenS: 20, yellowS: 3, allRedS: 2 },
    ];
    const controllers = Array.from({ length: 400 }, (_, k) => ({
      id: `c${k}`,
      nodeId: `n${k}`,
      offsetS: 0,
      groups,
      phases,
      leftTurnModes: {},
      pedestrianPhase: true,
      provenance: {},
    }));

    const sim = createSimulation({
      network: { ...twoLinkRoad(), signalControllers: controllers },
      // Zero demand: isolate the signals subsystem's own cost from spawn/IDM overhead.
      config: defaultSimConfig({ demand: { multiplier: 0, warmupMinutes: 0 } }),
    });
    // Warm up (JIT, first-call costs) before timing.
    for (let k = 0; k < 20; k++) sim.step();
    const steps = 200;
    const t0 = performance.now();
    for (let k = 0; k < steps; k++) sim.step();
    const perStepMs = (performance.now() - t0) / steps;
    expect(perStepMs).toBeLessThan(0.3);
  });
});
