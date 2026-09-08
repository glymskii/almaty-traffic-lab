import { describe, expect, it } from "vitest";
import {
  createInterpolationBuffer,
  createRenderFrame,
  type FrameSample,
  ingestFrame,
  isBlinkOn,
  lerpAngle,
  sampleInterpolated,
} from "../src/scene/interpolation.ts";

function frame(
  simTimeS: number,
  vehicles: { id: number; x: number; y: number; heading: number }[],
): FrameSample {
  const n = vehicles.length;
  const id = new Uint32Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const heading = new Float32Array(n);
  vehicles.forEach((v, i) => {
    id[i] = v.id;
    x[i] = v.x;
    y[i] = v.y;
    heading[i] = v.heading;
  });
  return {
    count: n,
    simTimeS,
    id,
    x,
    y,
    heading,
    speed: new Float32Array(n),
    cls: new Uint8Array(n),
    flags: new Uint8Array(n),
    cause: new Uint8Array(n),
  };
}

describe("lerpAngle", () => {
  it("interpolates linearly when there's no wraparound", () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4);
  });

  it("takes the shortest arc across the +-PI seam", () => {
    // from just past +PI to just before -PI: the short way is forward through the seam, not
    // backward across the whole circle.
    const from = Math.PI - 0.1;
    const to = -Math.PI + 0.1;
    const mid = lerpAngle(from, to, 0.5);
    // the shortest-arc midpoint is exactly PI (== -PI), whichever sign normalization picks.
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(1e-6);
  });

  it("t=0 and t=1 return the endpoints (as an equivalent angle, mod 2*PI)", () => {
    expect(lerpAngle(1.2, 1.8, 0)).toBeCloseTo(1.2);
    expect(lerpAngle(1.2, 1.8, 1)).toBeCloseTo(1.8);
    // 1.2 -> -2.5 crosses the +-PI seam the short way, so t=1 lands on -2.5's *equivalent*
    // angle (-2.5 + 2*PI), not the literal input value - both point the same direction.
    const atEnd = lerpAngle(1.2, -2.5, 1);
    expect(Math.sin(atEnd)).toBeCloseTo(Math.sin(-2.5));
    expect(Math.cos(atEnd)).toBeCloseTo(Math.cos(-2.5));
  });
});

describe("isBlinkOn", () => {
  it("alternates on/off every half period at the given frequency", () => {
    // 2 Hz: 0.5s period, 0.25s on, 0.25s off.
    expect(isBlinkOn(0, 2)).toBe(true);
    expect(isBlinkOn(0.24, 2)).toBe(true);
    expect(isBlinkOn(0.26, 2)).toBe(false);
    expect(isBlinkOn(0.49, 2)).toBe(false);
    expect(isBlinkOn(0.51, 2)).toBe(true);
  });
});

describe("ingestFrame + sampleInterpolated", () => {
  it("snaps to the pose on the very first frame a vehicle appears in (no predecessor to lerp from)", () => {
    const buf = createInterpolationBuffer(16);
    ingestFrame(buf, frame(10, [{ id: 5, x: 100, y: 0, heading: 0 }]));
    const out = createRenderFrame(16);
    sampleInterpolated(buf, 10, out);
    expect(out.count).toBe(1);
    expect(out.x[0]).toBeCloseTo(100);
    expect(out.slot[0]).toBe(5 % 16);
  });

  it("lerps position and heading between the two most recently ingested frames", () => {
    const buf = createInterpolationBuffer(16);
    ingestFrame(buf, frame(10, [{ id: 5, x: 0, y: 0, heading: 0 }]));
    ingestFrame(buf, frame(11, [{ id: 5, x: 10, y: 20, heading: Math.PI / 2 }]));
    const out = createRenderFrame(16);

    sampleInterpolated(buf, 10.5, out);
    expect(out.x[0]).toBeCloseTo(5);
    expect(out.y[0]).toBeCloseTo(10);
    expect(out.heading[0]).toBeCloseTo(Math.PI / 4);

    sampleInterpolated(buf, 11, out);
    expect(out.x[0]).toBeCloseTo(10);
    expect(out.y[0]).toBeCloseTo(20);
  });

  it("clamps alpha instead of extrapolating past the sample times", () => {
    const buf = createInterpolationBuffer(16);
    ingestFrame(buf, frame(10, [{ id: 5, x: 0, y: 0, heading: 0 }]));
    ingestFrame(buf, frame(11, [{ id: 5, x: 10, y: 0, heading: 0 }]));
    const out = createRenderFrame(16);

    sampleInterpolated(buf, 5, out); // before the "from" sample
    expect(out.x[0]).toBeCloseTo(0);

    sampleInterpolated(buf, 50, out); // long after the "to" sample
    expect(out.x[0]).toBeCloseTo(10);
  });

  it("snaps instead of lerping when a slot's occupant changes (respawn, not motion)", () => {
    const capacity = 4;
    const buf = createInterpolationBuffer(capacity);
    // vehicle id=1 (slot 1) drives far away, then leaves; a new vehicle id=5 (also slot 1,
    // 5 % 4 === 1) spawns at a completely different point on the very next frame.
    ingestFrame(buf, frame(10, [{ id: 1, x: 500, y: 500, heading: 0 }]));
    ingestFrame(buf, frame(11, [{ id: 5, x: 0, y: 0, heading: 0 }]));
    const out = createRenderFrame(capacity);

    // Halfway between the two frames should still show the NEW vehicle at its own spawn point,
    // not a lerp toward the old vehicle's far-away position.
    sampleInterpolated(buf, 10.5, out);
    expect(out.x[0]).toBeCloseTo(0);
    expect(out.y[0]).toBeCloseTo(0);
    expect(out.id[0]).toBe(5);
  });

  it("drops a slot from the active list once its vehicle stops appearing in frames", () => {
    const buf = createInterpolationBuffer(16);
    ingestFrame(buf, frame(10, [{ id: 5, x: 0, y: 0, heading: 0 }]));
    ingestFrame(buf, frame(11, [])); // vehicle 5 despawned
    const out = createRenderFrame(16);
    sampleInterpolated(buf, 11, out);
    expect(out.count).toBe(0);
  });
});
