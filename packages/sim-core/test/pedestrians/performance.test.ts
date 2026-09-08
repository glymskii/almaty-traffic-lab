/**
 * T-15 acceptance: a step with 800 crosswalks adds under 0.5 ms. Extra crosswalks carry no
 * `connectorIds`, so no vehicle ever crosses them -- this isolates the O(crosswalkCount) arrival and
 * expiry work in `PedestrianRuntime.update` from the (much smaller, per-connector) obstacle lookup.
 */
import { defaultSimConfig, type Network, type SimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation } from "../../src/simulation.ts";
import { crossroads } from "../fixtures/builders.ts";

const EXTRA_CROSSWALKS = 800;
const BUDGET_MS = 0.5;

function withExtraCrosswalks(net: Network, count: number): Network {
  const nodeId = (net.nodes[0] as { id: string }).id;
  for (let i = 0; i < count; i++) {
    net.crosswalks.push({
      id: `perf.cw${i}`,
      nodeId,
      geometry: [
        [0, 0],
        [1, 0],
      ],
      lengthM: 1,
      connectorIds: [],
      provenance: {},
    });
  }
  return net;
}

/** Mean per-step time over `steps` steps, in ms, after `warmupS` seconds to reach a steady state. */
function meanStepMs(network: Network, config: SimConfig, warmupS: number, steps: number): number {
  const sim = createSimulation({ network, config });
  sim.runUntil(warmupS);
  const t0 = performance.now();
  for (let k = 0; k < steps; k++) sim.step();
  return (performance.now() - t0) / steps;
}

describe("pedestrian performance", () => {
  it(`${EXTRA_CROSSWALKS} crosswalks add under ${BUDGET_MS} ms per step`, () => {
    const net = withExtraCrosswalks(crossroads({ crosswalks: true }), EXTRA_CROSSWALKS);
    const config = defaultSimConfig({
      demand: { tripsPerHourPeak: 1200, warmupMinutes: 0, vehicleBudget: 500 },
      pedestrians: { hourlyRatePerCrosswalk: new Array(24).fill(600) },
    });
    const disabled: SimConfig = {
      ...config,
      pedestrians: { ...config.pedestrians, enabled: false },
    };

    const withMs = meanStepMs(net, config, 60, 200);
    const withoutMs = meanStepMs(net, disabled, 60, 200);
    expect(withMs - withoutMs).toBeLessThan(BUDGET_MS);
  });
});
