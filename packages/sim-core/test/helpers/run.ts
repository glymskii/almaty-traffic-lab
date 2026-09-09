/**
 * Shared measurement helpers for nuance tests (docs/NUANCES.md, T-22). Every nuance test built its
 * own little inline measurement before this: this file gives the common shapes -- "run past
 * warm-up", "delay of an approach", "flow of an approach", "bus trip time", "stops per vehicle" -- a
 * single implementation so new nuance tests do not reinvent them, and so a change to what "delay" or
 * "flow" means only has one place to fix.
 *
 * These are convenience wrappers over `Simulation.writeMetrics()` / `segments()` / `tripStats()`
 * (packages/sim-core/src/simulation.ts) -- they read no private state and add no new capability.
 */
import type { Network, SimConfig } from "@atl/contracts";
import { createSimulation, type Simulation } from "../../src/simulation.ts";

/**
 * Creates a simulation and steps it past `config.demand.warmupMinutes` of warm-up plus `minutes` of
 * measurement window -- the "warm-up 3 min, measure 10 min" convention every nuance test in
 * docs/NUANCES.md follows unless it says otherwise. Returns the simulation positioned at the end of
 * that window, ready for `writeMetrics()`, `report()` or `tripStats()`.
 */
export function runFor(network: Network, config: SimConfig, minutes: number): Simulation {
  const sim = createSimulation({ network, config });
  sim.runUntil((config.demand.warmupMinutes + minutes) * 60);
  return sim;
}

/**
 * Vehicle-seconds of delay accumulated in the metrics window across every segment of `linkId`
 * (every lane, the full approach length) -- the same "sum delayVehS over the link's segments"
 * measurement N07 and N24 already used inline.
 */
export function approachDelay(sim: Simulation, linkId: string): number {
  const metrics = sim.writeMetrics();
  let delayS = 0;
  for (const seg of sim.segments()) {
    if (seg.linkId === linkId) delayS += metrics.delayVehS[seg.index] as number;
  }
  return delayS;
}

/**
 * Total approach flow of `linkId`, veh/h: the window-mean flow of the segment closest to the node in
 * every lane of the link (`SegmentDescriptor.approachNodeId` marks it), summed across lanes. Interior
 * segments are skipped -- in steady state they carry the same flow as the approach segment, counting
 * them too would just multiply it by the segment count.
 */
export function flowOf(sim: Simulation, linkId: string): number {
  const metrics = sim.writeMetrics();
  let flowVehH = 0;
  for (const seg of sim.segments()) {
    if (seg.linkId === linkId && seg.approachNodeId !== undefined) {
      flowVehH += metrics.flow[seg.index] as number;
    }
  }
  return flowVehH;
}

/** Mean trip time of bus trips completed since the end of warm-up, seconds (0 with no completion yet). */
export function busTripTime(sim: Simulation): number {
  return sim.tripStats().byClass.bus.meanTripTimeS;
}

/**
 * Mean stops per completed trip since the end of warm-up, across every vehicle class (a stop is `v`
 * crossing `metrics.stoppedSpeedMps` downward, docs/NUANCES.md "Как считать").
 */
export function stopsPerVehicle(sim: Simulation): number {
  return sim.tripStats().total.meanStops;
}
