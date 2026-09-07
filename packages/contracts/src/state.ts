import type { VehicleClass } from "./common.ts";

/**
 * Per-frame vehicle state as structure-of-arrays typed arrays.
 * Produced by the worker at render rate (or lower), ping-ponged with the main thread:
 * main thread renders a frame, then sends it back via `returnFrame` so the worker can reuse the buffers.
 * No SharedArrayBuffer by decision (see docs/DECISIONS.md, D7).
 */

export const SignalState = {
  RED: 0,
  RED_YELLOW: 1,
  GREEN: 2,
  FLASHING_GREEN: 3,
  YELLOW: 4,
  /** Additional (arrow) sections are off, not red, when not permitted. */
  OFF: 5,
} as const;
export type SignalStateCode = (typeof SignalState)[keyof typeof SignalState];

/** Bit flags in FrameBuffers.flags. */
export const VehicleFlag = {
  BRAKING: 1,
  BLINKER_LEFT: 2,
  BLINKER_RIGHT: 4,
  STOPPED: 8,
  IN_INTERSECTION: 16,
  BUS_LANE_VIOLATOR: 32,
  NAVIGATOR: 64,
  DWELLING: 128,
} as const;

export const VEHICLE_CLASS_CODE: Record<VehicleClass, number> = {
  car: 0,
  bus: 1,
  trolleybus: 2,
  taxi: 3,
};
export const VEHICLE_CLASS_BY_CODE: readonly VehicleClass[] = ["car", "bus", "trolleybus", "taxi"];

export interface FrameBuffers {
  capacity: number;
  /** Number of valid vehicle entries (<= capacity). */
  count: number;
  simTimeS: number;
  /** Stable vehicle id for the life of the vehicle (used for interpolation between frames). */
  id: Uint32Array;
  x: Float32Array;
  y: Float32Array;
  /** Radians, counter-clockwise from +x (east). */
  heading: Float32Array;
  /** m/s */
  speed: Float32Array;
  cls: Uint8Array;
  flags: Uint8Array;
  /** Immediate binding constraint, CauseCode. */
  cause: Uint8Array;
  /** Signal group states indexed by global group index (controllers in network order, groups in controller order). */
  signalStates: Uint8Array;
  /** Pedestrians currently on each crosswalk, indexed by crosswalk order in the network. */
  crosswalkPeds: Uint8Array;
}

export function allocateFrameBuffers(
  capacity: number,
  signalGroupCount: number,
  crosswalkCount: number,
): FrameBuffers {
  return {
    capacity,
    count: 0,
    simTimeS: 0,
    id: new Uint32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    heading: new Float32Array(capacity),
    speed: new Float32Array(capacity),
    cls: new Uint8Array(capacity),
    flags: new Uint8Array(capacity),
    cause: new Uint8Array(capacity),
    signalStates: new Uint8Array(signalGroupCount),
    crosswalkPeds: new Uint8Array(crosswalkCount),
  };
}

export function frameTransferList(f: FrameBuffers): ArrayBuffer[] {
  return [
    f.id.buffer as ArrayBuffer,
    f.x.buffer as ArrayBuffer,
    f.y.buffer as ArrayBuffer,
    f.heading.buffer as ArrayBuffer,
    f.speed.buffer as ArrayBuffer,
    f.cls.buffer as ArrayBuffer,
    f.flags.buffer as ArrayBuffer,
    f.cause.buffer as ArrayBuffer,
    f.signalStates.buffer as ArrayBuffer,
    f.crosswalkPeds.buffer as ArrayBuffer,
  ];
}
