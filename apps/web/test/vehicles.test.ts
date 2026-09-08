import { VEHICLE_CLASS_CODE, VehicleFlag } from "@atl/contracts";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createRenderFrame, type RenderFrame } from "../src/scene/interpolation.ts";
import {
  CAR_PALETTE,
  carColorFor,
  createVehicleInstances,
  isCarLike,
  TAXI_COLOR,
} from "../src/scene/vehicles.ts";

const CAR = VEHICLE_CLASS_CODE.car;
const TAXI = VEHICLE_CLASS_CODE.taxi;
const BUS = VEHICLE_CLASS_CODE.bus;
const TROLLEYBUS = VEHICLE_CLASS_CODE.trolleybus;

/** sRGB 0..1 channel from a hex pair - `Color.r/g/b` are in the linear working colour space (Three's colour management), not the sRGB values the hex literal was written in. */
function srgbChannel(hexPair: string): number {
  return Number.parseInt(hexPair, 16) / 255;
}

describe("CAR_PALETTE", () => {
  it("has 6 muted colours (docs/tasks/T-13: 'палитра легковых из 6 приглушённых цветов')", () => {
    expect(CAR_PALETTE.length).toBe(6);
    for (const color of CAR_PALETTE) {
      const hex = color.getHexString();
      // "приглушённых" (muted): no channel at either extreme.
      for (const pair of [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)]) {
        expect(srgbChannel(pair)).toBeGreaterThan(0.1);
        expect(srgbChannel(pair)).toBeLessThan(0.9);
      }
    }
  });

  it("has no duplicate colours", () => {
    const hexes = new Set(CAR_PALETTE.map((c) => c.getHexString()));
    expect(hexes.size).toBe(CAR_PALETTE.length);
  });
});

describe("carColorFor", () => {
  it("keys the car palette by id % 6", () => {
    for (let id = 0; id < 18; id++) {
      const expected = CAR_PALETTE[id % 6];
      expect(carColorFor(CAR, id).getHex()).toBe(expected?.getHex());
    }
  });

  it("gives the same id the same colour every time (stable across frames)", () => {
    expect(carColorFor(CAR, 42).getHex()).toBe(carColorFor(CAR, 42).getHex());
  });

  it("two ids 6 apart share a colour, consecutive ids differ", () => {
    expect(carColorFor(CAR, 3).getHex()).toBe(carColorFor(CAR, 9).getHex());
    expect(carColorFor(CAR, 3).getHex()).not.toBe(carColorFor(CAR, 4).getHex());
  });

  it("always colours a taxi the fixed taxi yellow, ignoring the palette and id", () => {
    for (const id of [0, 1, 6, 41]) {
      expect(carColorFor(TAXI, id).getHex()).toBe(TAXI_COLOR.getHex());
    }
  });
});

describe("isCarLike", () => {
  it("is true for car and taxi, false for bus and trolleybus", () => {
    expect(isCarLike(CAR)).toBe(true);
    expect(isCarLike(TAXI)).toBe(true);
    expect(isCarLike(BUS)).toBe(false);
    expect(isCarLike(TROLLEYBUS)).toBe(false);
  });
});

function findMesh(group: THREE.Group, name: string): THREE.InstancedMesh {
  const mesh = group.children.find((child) => child.name === name);
  if (!(mesh instanceof THREE.InstancedMesh)) throw new Error(`mesh ${name} not found`);
  return mesh;
}

/**
 * True scale magnitude of instance `index`'s first basis column - rotation preserves vector
 * length, so this equals |scale.x| for any instance this codebase ever writes, without going
 * through `Matrix4.decompose`, which (Three.js `Matrix4.decompose`, "det === 0") reports a
 * genuinely zero-scale matrix as scale (1,1,1) instead of (0,0,0) to avoid a singular rotation.
 */
function instanceScale(mesh: THREE.InstancedMesh, index: number): number {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const e = matrix.elements;
  return Math.hypot(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0);
}

function oneVehicleFrame(capacity: number, overrides: Partial<RenderFrame> = {}): RenderFrame {
  const frame = createRenderFrame(capacity);
  frame.count = 1;
  frame.simTimeS = overrides.simTimeS ?? 0;
  frame.id[0] = 7;
  frame.slot[0] = 7 % capacity;
  frame.x[0] = 10;
  frame.y[0] = 20;
  frame.heading[0] = 0;
  frame.cls[0] = CAR;
  frame.flags[0] = 0;
  return frame;
}

describe("createVehicleInstances / update", () => {
  it("draws the body of an active car and leaves its brake/blinker instances hidden", () => {
    const vehicles = createVehicleInstances(16);
    const frame = oneVehicleFrame(16);
    vehicles.update(frame);

    const slot = frame.slot[0] as number;
    expect(instanceScale(findMesh(vehicles.object, "body"), slot)).toBeGreaterThan(0);
    expect(instanceScale(findMesh(vehicles.object, "brake"), slot)).toBe(0);
    expect(instanceScale(findMesh(vehicles.object, "blinkers"), slot * 2)).toBe(0);
    expect(instanceScale(findMesh(vehicles.object, "blinkers"), slot * 2 + 1)).toBe(0);
  });

  it("shows the brake instance while BRAKING is set (docs/tasks/T-13 acceptance: стоп-сигналы видны)", () => {
    const vehicles = createVehicleInstances(16);
    const frame = oneVehicleFrame(16);
    frame.flags[0] = VehicleFlag.BRAKING;
    vehicles.update(frame);

    const slot = frame.slot[0] as number;
    expect(instanceScale(findMesh(vehicles.object, "brake"), slot)).toBeGreaterThan(0);
  });

  it("blinks the turn signal at 2 Hz instead of holding it on solid", () => {
    const vehicles = createVehicleInstances(16);
    const onFrame = oneVehicleFrame(16, { simTimeS: 0 });
    onFrame.flags[0] = VehicleFlag.BLINKER_LEFT;
    onFrame.simTimeS = 0; // on-phase (isBlinkOn(0, 2) === true)
    vehicles.update(onFrame);
    const slot = onFrame.slot[0] as number;
    expect(instanceScale(findMesh(vehicles.object, "blinkers"), slot * 2)).toBeGreaterThan(0);

    const offFrame = oneVehicleFrame(16, { simTimeS: 0.3 });
    offFrame.flags[0] = VehicleFlag.BLINKER_LEFT;
    offFrame.simTimeS = 0.3; // off-phase
    vehicles.update(offFrame);
    expect(instanceScale(findMesh(vehicles.object, "blinkers"), slot * 2)).toBe(0);
  });

  it("hides the body (scale 0) once a vehicle stops appearing in the sampled frames", () => {
    const vehicles = createVehicleInstances(16);
    const frame = oneVehicleFrame(16);
    vehicles.update(frame);
    const slot = frame.slot[0] as number;
    expect(instanceScale(findMesh(vehicles.object, "body"), slot)).toBeGreaterThan(0);

    const empty = createRenderFrame(16);
    empty.count = 0;
    vehicles.update(empty);
    expect(instanceScale(findMesh(vehicles.object, "body"), slot)).toBe(0);
  });

  it("clears the previous occupant's parts when a slot is immediately reused by a different vehicle class (no gap frame)", () => {
    const vehicles = createVehicleInstances(16);
    const busFrame = createRenderFrame(16);
    busFrame.count = 1;
    busFrame.id[0] = 3; // slot 3 % 16 === 3
    busFrame.slot[0] = 3;
    busFrame.x[0] = 0;
    busFrame.y[0] = 0;
    busFrame.heading[0] = 0;
    busFrame.cls[0] = TROLLEYBUS;
    vehicles.update(busFrame);
    expect(instanceScale(findMesh(vehicles.object, "poles"), 3 * 2)).toBeGreaterThan(0);

    const carFrame = createRenderFrame(16);
    carFrame.count = 1;
    carFrame.id[0] = 19; // a different vehicle: 19 % 16 === 3, same slot, next frame, no gap
    carFrame.slot[0] = 3;
    carFrame.cls[0] = CAR;
    vehicles.update(carFrame);
    // the slot stayed "active" across both calls (never hit the despawn path), so only the
    // class-transition check inside `update` can be responsible for clearing the old poles.
    expect(instanceScale(findMesh(vehicles.object, "poles"), 3 * 2)).toBe(0);
    expect(instanceScale(findMesh(vehicles.object, "body"), 3)).toBeGreaterThan(0);
  });
});
