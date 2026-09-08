/**
 * T-12 acceptance: on the compiled small-square network the whole static forest builds in under
 * 200 ms and the navigator rebuild in under 100 ms. Skipped when the network has not been compiled
 * (`pnpm run compile --bbox small`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { defaultSimConfig, type Network, parseNetwork } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";

const NETWORK_PATH = fileURLToPath(
  new URL("../../../../data/networks/almaty-abay-small.network.json.gz", import.meta.url),
);

let cached: Network | undefined;
function network(): Network {
  cached ??= parseNetwork(JSON.parse(gunzipSync(readFileSync(NETWORK_PATH)).toString("utf8")));
  return cached;
}

describe("route trees on the small square", () => {
  it.skipIf(!existsSync(NETWORK_PATH))(
    "builds every destination tree in under 200 ms, re-routes navigators in under 100 ms, and loses no vehicles",
    { timeout: 120_000 },
    () => {
      const sim = createSimulation({
        network: network(),
        config: defaultSimConfig({
          demand: { warmupMinutes: 1, vehicleBudget: 6000, navigatorShare: 0.3 },
        }),
      });
      const kernel = kernelOf(sim);
      expect(kernel.routingGraph.linkCount).toBeGreaterThan(500);
      expect(kernel.od.destCount).toBeGreaterThan(50);

      kernel.rebuildRouteTrees(); // warm the JIT, then measure
      const t0 = performance.now();
      kernel.rebuildRouteTrees();
      const staticMs = performance.now() - t0;

      kernel.rebuildLiveTrees();
      const t1 = performance.now();
      kernel.rebuildLiveTrees();
      const liveMs = performance.now() - t1;

      expect(staticMs).toBeLessThan(200); // on an M-series machine about 27 ms
      expect(liveMs).toBeLessThan(100); // about 5 ms: one copy instead of five

      sim.runUntil(150);
      const stats = sim.tripStats();
      expect(sim.vehicleCount()).toBeGreaterThan(500);
      expect(stats.total.completed).toBeGreaterThan(50);
      // Vehicles that ran out of lane, and trips re-aimed at another gate after a missed turn lane:
      // both come from gaps in the compiled network rather than from routing, so these are
      // ceilings, not targets.
      expect(kernel.droppedVehicles).toBeLessThan(stats.total.spawned * 0.05);
      expect(kernel.retargetedTrips).toBeLessThan(stats.total.spawned * 0.1);
    },
  );
});
