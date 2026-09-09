import { describe, expect, it } from "vitest";
import {
  AB_SYNC_LAG_S,
  type AbClock,
  type AbSyncState,
  createAbSyncState,
  stepAbSync,
} from "../src/sim/abRunner.ts";

/**
 * docs/tasks/T-26 п.5: "синхронизация времени на фейковых клиентах" - `stepAbSync` is pure apart
 * from the play()/pause() calls it makes on the clocks it's given, so these fakes just record what
 * happened instead of running a real worker.
 */

function fakeClock(simTimeS: number): AbClock & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    simTimeS: () => simTimeS,
    play: (factor) => calls.push(`play(${factor})`),
    pause: () => calls.push("pause"),
  };
}

describe("stepAbSync", () => {
  it("does nothing while the transport controls are globally paused", () => {
    const a = fakeClock(100);
    const b = fakeClock(0);
    const state = stepAbSync({ a, b }, createAbSyncState(), false, 1);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
    expect(state).toEqual(createAbSyncState());
  });

  it("does nothing while both sides are within the lag threshold", () => {
    const a = fakeClock(100);
    const b = fakeClock(100 - AB_SYNC_LAG_S);
    const state = stepAbSync({ a, b }, createAbSyncState(), true, 1);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
    expect(state.pausedSide).toBeUndefined();
  });

  it("pauses A once it is more than the lag threshold ahead of B (docs/tasks/T-26 п.1)", () => {
    const a = fakeClock(100);
    const b = fakeClock(100 - AB_SYNC_LAG_S - 1);
    const state = stepAbSync({ a, b }, createAbSyncState(), true, 2);
    expect(a.calls).toEqual(["pause"]);
    expect(b.calls).toEqual([]);
    expect(state.pausedSide).toBe("a");
  });

  it("pauses B once it is more than the lag threshold ahead of A", () => {
    const a = fakeClock(0);
    const b = fakeClock(AB_SYNC_LAG_S + 5);
    const state = stepAbSync({ a, b }, createAbSyncState(), true, 1);
    expect(b.calls).toEqual(["pause"]);
    expect(a.calls).toEqual([]);
    expect(state.pausedSide).toBe("b");
  });

  it("keeps A paused while B is still catching up", () => {
    const a = fakeClock(100);
    const b = fakeClock(50);
    const paused: AbSyncState = { pausedSide: "a" };
    const state = stepAbSync({ a, b }, paused, true, 1);
    expect(a.calls).toEqual([]); // no further play/pause calls - already paused
    expect(state.pausedSide).toBe("a");
  });

  it("resumes A with the current speed factor once B has caught back up within the threshold", () => {
    const a = fakeClock(100);
    const b = fakeClock(100 - AB_SYNC_LAG_S); // exactly at the threshold - close enough
    const paused: AbSyncState = { pausedSide: "a" };
    const state = stepAbSync({ a, b }, paused, true, 5);
    expect(a.calls).toEqual(["play(5)"]);
    expect(state.pausedSide).toBeUndefined();
  });

  it("resumes B once it has caught back up, mirroring the A case", () => {
    const a = fakeClock(0);
    const b = fakeClock(AB_SYNC_LAG_S);
    const paused: AbSyncState = { pausedSide: "b" };
    const state = stepAbSync({ a, b }, paused, true, 3);
    expect(b.calls).toEqual(["play(3)"]);
    expect(state.pausedSide).toBeUndefined();
  });

  it("a fresh B far behind a long-running A converges over successive steps without ever pausing B", () => {
    // Mirrors the real scenario docs/tasks/T-26 п.1 describes: B just finished its own warm-up at
    // t=0 while A has already been playing for a while - A gets paused, B (unpaused) plays until it
    // closes the gap, then A resumes.
    let state = createAbSyncState();
    const a = fakeClock(900);
    let bTime = 0;
    const b: AbClock = {
      simTimeS: () => bTime,
      play: () => {},
      pause: () => {
        throw new Error("B should never be paused while it is the one catching up");
      },
    };
    state = stepAbSync({ a, b }, state, true, 1);
    expect(state.pausedSide).toBe("a");
    // B advances every tick (as if playing) while A sits paused; a real worker would drive this,
    // the test just fast-forwards B's clock to model several ticks passing.
    bTime = 894;
    state = stepAbSync({ a, b }, state, true, 1);
    expect(state.pausedSide).toBe("a"); // still 6s behind - over the 5s threshold
    bTime = 896;
    state = stepAbSync({ a, b }, state, true, 1);
    expect(state.pausedSide).toBeUndefined(); // 4s behind - within the threshold, A resumes
  });
});
