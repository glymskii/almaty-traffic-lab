/**
 * Pure, THREE-free helpers turning a stream of `FrameBuffers` (arriving at `frameRateHz`, see
 * sim-worker's protocol) into a smooth per-render-tick vehicle pose, plus tiny time-based helpers
 * (angle lerp, blink phase) shared by vehicles.ts and signals.ts.
 *
 * `FrameBuffers` are dense: `x[0..count)` etc, one slot per *currently active* vehicle, re-packed
 * every frame. A vehicle's `id` is stable for its lifetime, but its position in that dense array
 * is not - so we cannot lerp `x[i]` between two frames by index `i`. Instead every id is scattered
 * into a fixed `capacity`-sized "slot" via `id % capacity` (docs/tasks/T-13: ids are assigned as
 * `slot + generation * capacity`, so this recovers the same slot across a vehicle's whole life and
 * a new occupant of a reused slot gets a different id). Each slot remembers the last two samples
 * written to it ("from"/"to"); a slot whose owning id changed between frames means a different
 * vehicle now occupies it, so we snap instead of lerping across the respawn.
 */

const TWO_PI = Math.PI * 2;

/** Wrap `a` into (-PI, PI]. */
function normalizeAngle(a: number): number {
  let x = a % TWO_PI;
  if (x <= -Math.PI) x += TWO_PI;
  else if (x > Math.PI) x -= TWO_PI;
  return x;
}

/** Interpolate an angle (radians) from `a` to `b` by the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + normalizeAngle(b - a) * t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * True for the "on" half of a `hz`-cycle-per-second square wave starting on at `tS = 0`. Used for
 * turn signals (2 Hz) and the flashing-green signal phase.
 */
export function isBlinkOn(tS: number, hz: number): boolean {
  const period = 1 / hz;
  const phase = tS - Math.floor(tS / period) * period;
  return phase < period / 2;
}

/** The subset of FrameBuffers this module reads; lets tests build plain objects instead of allocateFrameBuffers(). */
export interface FrameSample {
  count: number;
  simTimeS: number;
  id: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  heading: ArrayLike<number>;
  speed: ArrayLike<number>;
  cls: ArrayLike<number>;
  flags: ArrayLike<number>;
  cause: ArrayLike<number>;
}

/** Interpolated, dense (0..count) render-ready vehicle pose for one tick, capacity-sized storage reused every call. */
export interface RenderFrame {
  readonly capacity: number;
  count: number;
  simTimeS: number;
  readonly id: Uint32Array;
  readonly slot: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly heading: Float32Array;
  readonly speed: Float32Array;
  readonly cls: Uint8Array;
  readonly flags: Uint8Array;
  readonly cause: Uint8Array;
}

export function createRenderFrame(capacity: number): RenderFrame {
  return {
    capacity,
    count: 0,
    simTimeS: 0,
    id: new Uint32Array(capacity),
    slot: new Uint32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    heading: new Float32Array(capacity),
    speed: new Float32Array(capacity),
    cls: new Uint8Array(capacity),
    flags: new Uint8Array(capacity),
    cause: new Uint8Array(capacity),
  };
}

/** Per-slot "from"/"to" samples, keyed by `id % capacity`. Owned by the caller (one per SimClient). */
export interface InterpolationBuffer {
  readonly capacity: number;
  /** Id currently occupying each slot, or -1 if the slot has never been written. */
  readonly ownerId: Int32Array;
  readonly fromX: Float32Array;
  readonly fromY: Float32Array;
  readonly fromHeading: Float32Array;
  readonly fromTimeS: Float32Array;
  readonly toX: Float32Array;
  readonly toY: Float32Array;
  readonly toHeading: Float32Array;
  readonly toTimeS: Float32Array;
  readonly toSpeed: Float32Array;
  readonly toCls: Uint8Array;
  readonly toFlags: Uint8Array;
  readonly toCause: Uint8Array;
  /** Dense list of slots touched by the most recently ingested frame. */
  readonly activeSlots: Uint32Array;
  activeCount: number;
}

export function createInterpolationBuffer(capacity: number): InterpolationBuffer {
  const ownerId = new Int32Array(capacity);
  ownerId.fill(-1);
  return {
    capacity,
    ownerId,
    fromX: new Float32Array(capacity),
    fromY: new Float32Array(capacity),
    fromHeading: new Float32Array(capacity),
    fromTimeS: new Float32Array(capacity),
    toX: new Float32Array(capacity),
    toY: new Float32Array(capacity),
    toHeading: new Float32Array(capacity),
    toTimeS: new Float32Array(capacity),
    toSpeed: new Float32Array(capacity),
    toCls: new Uint8Array(capacity),
    toFlags: new Uint8Array(capacity),
    toCause: new Uint8Array(capacity),
    activeSlots: new Uint32Array(capacity),
    activeCount: 0,
  };
}

/**
 * Records a newly arrived frame into `buf`. Must be called synchronously inside the worker's
 * `onFrame` callback (docs/tasks/T-13: the frame buffer is detached right after the callback
 * returns) - this only reads `frame`, it never keeps a reference to it.
 */
export function ingestFrame(buf: InterpolationBuffer, frame: FrameSample): void {
  const capacity = buf.capacity;
  const n = Math.min(frame.count, capacity);
  for (let i = 0; i < n; i++) {
    const id = frame.id[i] as number;
    const slot = id % capacity;
    const sameVehicle = buf.ownerId[slot] === id;
    if (sameVehicle) {
      buf.fromX[slot] = buf.toX[slot] as number;
      buf.fromY[slot] = buf.toY[slot] as number;
      buf.fromHeading[slot] = buf.toHeading[slot] as number;
      buf.fromTimeS[slot] = buf.toTimeS[slot] as number;
    } else {
      // A different vehicle now owns this slot (or it was never written): snap, don't lerp
      // across the respawn. fromTimeS = frame.simTimeS makes the span below zero, so
      // sampleInterpolated always resolves alpha = 1 (the "to" pose) for this slot until the
      // next frame gives it a real predecessor.
      buf.fromX[slot] = frame.x[i] as number;
      buf.fromY[slot] = frame.y[i] as number;
      buf.fromHeading[slot] = frame.heading[i] as number;
      buf.fromTimeS[slot] = frame.simTimeS;
    }
    buf.toX[slot] = frame.x[i] as number;
    buf.toY[slot] = frame.y[i] as number;
    buf.toHeading[slot] = frame.heading[i] as number;
    buf.toTimeS[slot] = frame.simTimeS;
    buf.toSpeed[slot] = frame.speed[i] as number;
    buf.toCls[slot] = frame.cls[i] as number;
    buf.toFlags[slot] = frame.flags[i] as number;
    buf.toCause[slot] = frame.cause[i] as number;
    buf.ownerId[slot] = id;
    buf.activeSlots[i] = slot;
  }
  buf.activeCount = n;
}

/** Fills `out` with the pose of every active slot in `buf`, lerped to `atSimTimeS`. */
export function sampleInterpolated(
  buf: InterpolationBuffer,
  atSimTimeS: number,
  out: RenderFrame,
): void {
  const n = Math.min(buf.activeCount, out.capacity);
  for (let k = 0; k < n; k++) {
    const slot = buf.activeSlots[k] as number;
    const fromTimeS = buf.fromTimeS[slot] as number;
    const span = (buf.toTimeS[slot] as number) - fromTimeS;
    const alpha = span > 1e-6 ? Math.min(1, Math.max(0, (atSimTimeS - fromTimeS) / span)) : 1;
    out.id[k] = buf.ownerId[slot] as number;
    out.slot[k] = slot;
    out.x[k] = lerp(buf.fromX[slot] as number, buf.toX[slot] as number, alpha);
    out.y[k] = lerp(buf.fromY[slot] as number, buf.toY[slot] as number, alpha);
    out.heading[k] = lerpAngle(
      buf.fromHeading[slot] as number,
      buf.toHeading[slot] as number,
      alpha,
    );
    out.speed[k] = buf.toSpeed[slot] as number;
    out.cls[k] = buf.toCls[slot] as number;
    out.flags[k] = buf.toFlags[slot] as number;
    out.cause[k] = buf.toCause[slot] as number;
  }
  out.count = n;
  out.simTimeS = atSimTimeS;
}
