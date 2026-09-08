/**
 * Nuance tests N18-N20: pedestrians, gridlock, merges. Fixtures: crossroads, mergeRamp. Closed by T-15 (N18), T-11 + T-21 (N19), T-16 (N20).
 */
import { CAUSE_COUNT, causeCode, defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { TurnCode } from "../../src/runtime/turns.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads } from "../fixtures/builders.ts";

const TRIPS_PER_HOUR = 2400;
const WARMUP_S = 120;
const END_S = 720;

/**
 * Throughput of the north-south through movements (the cross direction) over the measurement
 * window, plus the causes every vehicle in the network reported while it ran.
 *
 * `blockedExit` chokes the east exit down to a 60 m stub behind an all-but-permanently red signal,
 * so the east-bound traffic backs up out of the stub and into the junction box. Everything goes
 * straight ahead, so the only thing that can stop the cross direction is a car standing in the box.
 */
function crossFlow(opts: { blockedExit: boolean; gridlockDiscipline: number }) {
  const network = crossroads({
    leftTurnMode: "protected",
    ...(opts.blockedExit ? { blockedExit: { dir: "E" as const, lengthM: 60 } } : {}),
  });
  const config = defaultSimConfig({
    seed: 1,
    behavior: { gridlockDiscipline: opts.gridlockDiscipline },
    demand: { tripsPerHourPeak: TRIPS_PER_HOUR, warmupMinutes: 2, vehicleBudget: 3000 },
  });
  const sim = createSimulation({ network, config });
  const { runtime, pool } = kernelOf(sim);
  for (const dir of ["N", "E", "S", "W"]) kernelOf(sim).setTurnShares(`${dir}.in`, { through: 1 });

  const cross: number[] = [];
  for (let c = 0; c < runtime.connectorCount; c++) {
    const t = runtime.laneCount + c;
    const id = runtime.connectorIds[c] as string;
    const northSouth = id.startsWith("N.in:") || id.startsWith("S.in:");
    if (northSouth && (runtime.connTurn[t] as number) === TurnCode.through) cross.push(t);
  }
  expect(cross.length).toBeGreaterThan(0);

  const seen = new Set<number>();
  const causes = new Float64Array(CAUSE_COUNT);
  sim.runUntil(WARMUP_S);
  while (sim.simTimeS < END_S) {
    sim.step();
    for (const t of cross) {
      for (let i = pool.trackTail[t] as number; i >= 0; i = pool.ahead[i] as number) {
        seen.add(pool.id[i] as number);
      }
    }
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      const code = pool.cause[i] as number;
      causes[code] = (causes[code] as number) + 1;
    }
  }
  expect(kernelOf(sim).droppedVehicles).toBe(0);
  return { crossFlow: seen.size, causes };
}

describe("N18 pedestrian yield", () => {
  it.todo(
    "crosswalks with pedestrian flow lower right-turn throughput; cause pedestrian_yield present",
  );
  it.todo("pedestrians.enabled = false restores right-turn throughput");
});

describe("N19 gridlock", () => {
  const free = crossFlow({ blockedExit: false, gridlockDiscipline: 0 });
  const undisciplined = crossFlow({ blockedExit: true, gridlockDiscipline: 0 });
  const disciplined = crossFlow({ blockedExit: true, gridlockDiscipline: 1 });

  it("gridlockDiscipline 0 with a blocked exit lets cars stop inside the intersection; cross flow drops, cause gridlock", () => {
    expect(free.crossFlow).toBeGreaterThan(100); // the reference junction really moves traffic
    expect(undisciplined.crossFlow).toBeLessThan(free.crossFlow * 0.5);
    expect(undisciplined.causes[causeCode("gridlock")] as number).toBeGreaterThan(0);
    expect(free.causes[causeCode("gridlock")] as number).toBe(0);
  }, 60000);

  it("gridlockDiscipline 1 keeps the intersection clear; cross flow unaffected", () => {
    expect(disciplined.crossFlow).toBeGreaterThanOrEqual(free.crossFlow * 0.95);
    expect(disciplined.causes[causeCode("gridlock")] as number).toBe(0);
    // Discipline is what keeps the box clear: the drivers wait in front of the full exit instead.
    expect(disciplined.causes[causeCode("downstream_spillback")] as number).toBeGreaterThan(0);
  }, 60000);
});

describe("N20 merge yield", () => {
  it.todo(
    "high ramp flow lowers mainline speed near the merge; cause merge_yield on the ramp, downstream_spillback/leader upstream",
  );
});
