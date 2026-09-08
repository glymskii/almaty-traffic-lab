import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ru } from "../src/i18n/ru.ts";
import { useStore } from "../src/state/store.ts";
import { TimeBar } from "../src/ui/TimeBar.tsx";

/** Smoke test (docs/tasks/T-23 п.8): the time-control bar renders and its buttons drive the store. */

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState(initialState, true);
  // Play/speed controls are disabled until the sim is ready (see TimeBar's `controlsDisabled`).
  useStore.setState({ status: "ready" });
});

afterEach(() => {
  cleanup();
});

describe("TimeBar", () => {
  it("shows the clock and the pause label while playing (default state)", () => {
    render(<TimeBar />);
    expect(screen.getByText(`${ru.clockLabel}: 08:00`)).toBeTruthy();
    expect(screen.getByText(ru.pause)).toBeTruthy();
  });

  it("toggles play/pause through the store", () => {
    render(<TimeBar />);
    fireEvent.click(screen.getByText(ru.pause));
    expect(useStore.getState().playing).toBe(false);
    expect(screen.getByText(ru.play)).toBeTruthy();
  });

  it("switches the speed factor on click", () => {
    render(<TimeBar />);
    fireEvent.click(screen.getByText(ru.speedFactorLabel(5)));
    expect(useStore.getState().speedFactor).toBe(5);
  });

  it("applies a time-of-day preset and requests a restart", () => {
    render(<TimeBar />);
    const tokenBefore = useStore.getState().restartToken;
    fireEvent.click(screen.getByText(ru.presetEvening));
    const state = useStore.getState();
    expect(state.startTimeMin).toBe(18 * 60 + 30);
    expect(state.restartToken).toBe(tokenBefore + 1);
  });

  it("disables play/speed controls while the sim isn't ready", () => {
    useStore.setState({ status: "warming-up", warmupProgress: 0.4 });
    render(<TimeBar />);
    expect(screen.getByText(ru.pause)).toHaveProperty("disabled", true);
    expect(screen.getByText(/40%/)).toBeTruthy();
  });
});
