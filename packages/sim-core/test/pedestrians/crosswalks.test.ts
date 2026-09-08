/**
 * Pedestrian crosswalk flow (T-15), unit level: `PedestrianRuntime` is driven directly, the same way
 * `test/intersections/gap-acceptance.test.ts` drives `IntersectionRuntime`. The end-to-end vehicle
 * yield behaviour lives in the nuance tests (N18, `test/nuances/05-...`).
 */
import { defaultSimConfig, type PedestrianConfig, SignalState } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { PedestrianRuntime } from "../../src/pedestrians/crosswalks.ts";
import { Rng } from "../../src/rng.ts";
import { RuntimeNetwork } from "../../src/runtime/network.ts";
import { crossroads, tJunction } from "../fixtures/builders.ts";

const DT_S = 0.1;
const SEGMENT_M = 25;
const NO_SIGNALS = new Uint8Array(0);

function pedConfig(patch: Partial<PedestrianConfig> = {}): PedestrianConfig {
  return defaultSimConfig({ pedestrians: patch }).pedestrians;
}

/** Advances `pr` by `steps` steps of `dt`, calling `update` with the given (constant) group state. */
function advance(
  pr: PedestrianRuntime,
  steps: number,
  now: { t: number },
  groupState: Uint8Array,
  rng: Rng,
  hourOfDay = 8,
): void {
  for (let n = 0; n < steps; n++) {
    now.t += DT_S;
    pr.update(DT_S, now.t, hourOfDay, groupState, rng);
  }
}

function mustIndexOf(ids: readonly string[], id: string): number {
  const idx = ids.indexOf(id);
  if (idx < 0) throw new Error(`fixture: ${id} missing`);
  return idx;
}

describe("unregulated crosswalk (no signalGroupId)", () => {
  const net = tJunction({ crosswalkOnDir: "S" });
  const rt = new RuntimeNetwork(net, SEGMENT_M);
  const cw = mustIndexOf(rt.crosswalkIds, "cw.S");
  const lengthM = net.crosswalks[0]?.lengthM as number;

  it("starts crossing immediately and finishes after lengthM / walkSpeedMps", () => {
    const walkSpeedMps = 1.5;
    // Hour 8 has a rate high enough that an arrival within the first second is near-certain; hour 9
    // is silent, so once switched to it no *new* pedestrian can mask the first one finishing.
    const hourlyRatePerCrosswalk = new Array(24).fill(0);
    hourlyRatePerCrosswalk[8] = 3600; // 1/s
    const cfg = pedConfig({ enabled: true, walkSpeedMps, hourlyRatePerCrosswalk });
    const pr = new PedestrianRuntime(net, rt, cfg, new Rng(1));
    const rng = new Rng(1);
    const now = { t: 0 };
    let startedAt = -1;
    for (let n = 0; n < 20 && startedAt < 0; n++) {
      advance(pr, 1, now, NO_SIGNALS, rng, 8);
      if (pr.activeCount(cw) > 0) startedAt = now.t;
    }
    expect(startedAt).toBeGreaterThan(0);
    expect(pr.waitingCount(cw)).toBe(0); // unregulated: nobody stays queued once it can start

    const durationS = lengthM / walkSpeedMps;
    // From here on, hour 9 (rate 0): no new arrival can extend the count past the first batch's finish.
    advance(pr, Math.round((durationS - 0.5) / DT_S), now, NO_SIGNALS, rng, 9);
    expect(pr.activeCount(cw)).toBeGreaterThan(0); // still walking, well short of the crossing time
    advance(pr, Math.round(1.0 / DT_S), now, NO_SIGNALS, rng, 9); // safely past startedAt + durationS
    expect(now.t).toBeGreaterThan(startedAt + durationS);
    expect(pr.activeCount(cw)).toBe(0);
  });

  it("threatTimeS is 0 while occupied, otherwise the arrival process's own estimate", () => {
    const cfg = pedConfig({
      enabled: true,
      hourlyRatePerCrosswalk: new Array(24).fill(360), // 0.1/s: a real but not immediate threat
    });
    const pr = new PedestrianRuntime(net, rt, cfg, new Rng(2));
    const now = { t: 0 };
    advance(pr, 1, now, NO_SIGNALS, new Rng(2)); // single call: one fresh stream is fine here
    if (pr.activeCount(cw) === 0) {
      const t = pr.threatTimeS(cw);
      expect(t).toBeGreaterThan(0);
      expect(Number.isFinite(t)).toBe(true);
    } else {
      expect(pr.threatTimeS(cw)).toBe(0);
    }
  });

  it("disabled module never produces a walker, a waiter, or a finite threat", () => {
    const cfg = pedConfig({ enabled: false, hourlyRatePerCrosswalk: new Array(24).fill(3600) });
    const pr = new PedestrianRuntime(net, rt, cfg, new Rng(3));
    const now = { t: 0 };
    advance(pr, 200, now, NO_SIGNALS, new Rng(3));
    expect(pr.activeCount(cw)).toBe(0);
    expect(pr.waitingCount(cw)).toBe(0);
    expect(pr.threatTimeS(cw)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("regulated crosswalk (signalGroupId set)", () => {
  const net = crossroads({ crosswalks: true });
  const rt = new RuntimeNetwork(net, SEGMENT_M);
  const cw = mustIndexOf(rt.crosswalkIds, "cw.N");
  const pedGroupIdx = rt.signalGroupIndex.get("sg.N.ped");
  if (pedGroupIdx === undefined) throw new Error("fixture: sg.N.ped missing");

  function groupState(state: number): Uint8Array {
    const g = new Uint8Array(rt.signalGroupIds.length);
    g[pedGroupIdx as number] = state;
    return g;
  }

  it("queues arrivals at red and only starts crossing at green/flashing green", () => {
    const cfg = pedConfig({
      enabled: true,
      hourlyRatePerCrosswalk: new Array(24).fill(3600),
    });
    const pr = new PedestrianRuntime(net, rt, cfg, new Rng(4));
    const rng = new Rng(4);
    const now = { t: 0 };
    advance(pr, 30, now, groupState(SignalState.RED), rng); // 3s at red: several arrivals queue up
    expect(pr.activeCount(cw)).toBe(0);
    expect(pr.waitingCount(cw)).toBeGreaterThan(0);
    expect(pr.threatTimeS(cw)).toBe(Number.POSITIVE_INFINITY); // red: no imminent threat to traffic

    advance(pr, 1, now, groupState(SignalState.GREEN), rng);
    expect(pr.activeCount(cw)).toBeGreaterThan(0);
    expect(pr.waitingCount(cw)).toBe(0); // the whole backlog was released at once

    // A pedestrian who started on green keeps walking even once the signal turns red again.
    advance(pr, 1, now, groupState(SignalState.RED), rng);
    expect(pr.activeCount(cw)).toBeGreaterThan(0);
  });

  it("does not grow the waiting queue without bound under sustained demand", () => {
    const cfg = pedConfig({
      enabled: true,
      hourlyRatePerCrosswalk: new Array(24).fill(3600), // 1/s: heavy for one crosswalk
    });
    const pr = new PedestrianRuntime(net, rt, cfg, new Rng(5));
    const now = { t: 0 };
    // 10 minutes at red would queue 600 arrivals with no cap; the horizon cap must hold it far below that.
    advance(pr, Math.round(600 / DT_S), now, groupState(SignalState.RED), new Rng(5));
    expect(pr.waitingCount(cw)).toBeLessThan(300);
  });
});
