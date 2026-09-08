import { VEHICLE_CLASS_CODE, VehicleFlag } from "@atl/contracts";
import * as THREE from "three";
import type { RenderFrame } from "./interpolation.ts";
import { isBlinkOn } from "./interpolation.ts";
import { composeBoxMatrix, ZERO_SCALE_MATRIX } from "./util.ts";

/**
 * Instanced vehicle rendering (docs/tasks/T-13): one InstancedMesh per body part, capacity =
 * `InitStats.vehicleCapacity`, indexed directly by the vehicle's stable slot (`id % capacity`,
 * see interpolation.ts) rather than by a packed 0..count-1 counter - a slot holds at most one
 * vehicle at a time, so every part mesh can simply be sized `capacity` (poles and turn signals,
 * two per vehicle, use `capacity * 2`). Unused instances are hidden by zero-scaling them
 * (docs/tasks/T-13 "Скрытие неиспользуемых инстансов масштабом 0"), not by shrinking
 * `mesh.count` - `mesh.count` stays fixed at the mesh's full capacity for its whole life.
 */

const CAR_CODE = VEHICLE_CLASS_CODE.car;
const TAXI_CODE = VEHICLE_CLASS_CODE.taxi;
const BUS_CODE = VEHICLE_CLASS_CODE.bus;
const TROLLEYBUS_CODE = VEHICLE_CLASS_CODE.trolleybus;
/** Sentinel `lastCls` value meaning "this slot has never held a vehicle yet". */
const NO_CLASS = 255;

/** Muted 6-colour car palette (docs/tasks/T-13, D13 "процедурный low-poly"), keyed by `id % 6`. */
export const CAR_PALETTE: readonly THREE.Color[] = [
  new THREE.Color("#6b7280"), // slate
  new THREE.Color("#8a5a44"), // muted brick
  new THREE.Color("#4b6a5a"), // muted green
  new THREE.Color("#5a6b8a"), // muted blue
  new THREE.Color("#8a7a4b"), // muted olive
  new THREE.Color("#7a5a7a"), // muted plum
];
export const TAXI_COLOR: THREE.Color = new THREE.Color("#e8b93c");
export const BUS_COLOR: THREE.Color = new THREE.Color("#8a5a3c");
export const TROLLEYBUS_COLOR: THREE.Color = new THREE.Color("#3c6b8a");
const BRAKE_LIGHT_COLOR = "#e23b3b";
const BLINKER_COLOR = "#e2a13b";
const CABIN_COLOR = "#2b2f33";
const POLE_COLOR = "#33383d";

/** Car/taxi share the same two-box silhouette; bus/trolleybus share one long box. Approximate, for the low-poly renderer only - not read from SimConfig. */
interface ClassDims {
  lengthM: number;
  widthM: number;
  heightM: number;
}
const CLASS_DIMS: Record<number, ClassDims> = {
  [CAR_CODE]: { lengthM: 4.3, widthM: 1.8, heightM: 0.9 },
  [TAXI_CODE]: { lengthM: 4.3, widthM: 1.8, heightM: 0.9 },
  [BUS_CODE]: { lengthM: 11.5, widthM: 2.5, heightM: 2.6 },
  [TROLLEYBUS_CODE]: { lengthM: 11.5, widthM: 2.5, heightM: 2.6 },
};

const CABIN_LENGTH_M = 1.9;
const CABIN_WIDTH_FACTOR = 0.88;
const CABIN_HEIGHT_M = 0.55;
const CABIN_FORWARD_OFFSET_M = -0.15;

const POLE_LENGTH_M = 0.1;
const POLE_WIDTH_M = 0.1;
const POLE_HEIGHT_M = 1.3;
const POLE_LATERAL_OFFSET_M = 0.7;
const POLE_FORWARD_OFFSET_M = -3.5;

const BRAKE_HEIGHT_ABOVE_GROUND_M = 0.55;
const BRAKE_LENGTH_M = 0.12;
const BRAKE_HEIGHT_M = 0.18;
const BRAKE_WIDTH_FACTOR = 0.7;

const BLINKER_HEIGHT_ABOVE_GROUND_M = 0.6;
const BLINKER_SIZE_M = 0.22;
const BLINKER_HZ = 2;

/** Headlights (docs/tasks/T-27 §3): always positioned while a vehicle is active, glow controlled
 * globally by `setHeadlightIntensity` (driven by time-of-day.ts, not a per-vehicle flag - the
 * protocol's `flags` byte has no free bit left, see docs/tasks/T-27's notes on T-13/T-10). */
const HEADLIGHT_HEIGHT_ABOVE_GROUND_M = 0.5;
const HEADLIGHT_SIZE_M = 0.16;
const HEADLIGHT_WIDTH_FACTOR = 0.7;
const HEADLIGHT_COLOR = "#d8d3bd";
const HEADLIGHT_EMISSIVE_COLOR = "#fff2c2";

/** `carColorFor`/`isCarLike` are exported for direct unit tests of the palette rule. */
export function carColorFor(cls: number, id: number): THREE.Color {
  return cls === TAXI_CODE ? TAXI_COLOR : (CAR_PALETTE[id % CAR_PALETTE.length] as THREE.Color);
}

export function isCarLike(cls: number): boolean {
  return cls === CAR_CODE || cls === TAXI_CODE;
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

function makeInstancedMesh(
  capacity: number,
  color: string | THREE.Color,
  emissive?: string | THREE.Color,
): THREE.InstancedMesh {
  const material = new THREE.MeshLambertMaterial({ color });
  if (emissive !== undefined) {
    material.emissive = new THREE.Color(emissive);
    material.emissiveIntensity = 0; // day default - setHeadlightIntensity ramps this up after dark
  }
  const mesh = new THREE.InstancedMesh(UNIT_BOX, material, capacity);
  mesh.count = capacity;
  for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, ZERO_SCALE_MATRIX);
  return mesh;
}

export interface VehicleInstances {
  readonly object: THREE.Group;
  /** Draws every vehicle in `sample` (interpolation.ts's `sampleInterpolated` output) and hides everything else. */
  update(sample: RenderFrame): void;
  /** Headlight emissive strength, 0 (day, off) .. 1 (night, full glow) - see time-of-day.ts's `headlight`. */
  setHeadlightIntensity(intensity: number): void;
}

export function createVehicleInstances(capacity: number): VehicleInstances {
  // White base colour: MeshLambertMaterial multiplies its own `color` by the per-instance
  // `instanceColor` (see below), so body/bus must start neutral or the palette would be tinted.
  const bodyMesh = makeInstancedMesh(capacity, "#ffffff");
  const cabinMesh = makeInstancedMesh(capacity, CABIN_COLOR);
  const busMesh = makeInstancedMesh(capacity, "#ffffff");
  const poleMesh = makeInstancedMesh(capacity * 2, POLE_COLOR);
  const brakeMesh = makeInstancedMesh(capacity, BRAKE_LIGHT_COLOR);
  const blinkerMesh = makeInstancedMesh(capacity * 2, BLINKER_COLOR);
  const headlightMesh = makeInstancedMesh(capacity * 2, HEADLIGHT_COLOR, HEADLIGHT_EMISSIVE_COLOR);
  bodyMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  busMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  bodyMesh.name = "body";
  cabinMesh.name = "cabin";
  busMesh.name = "bus";
  poleMesh.name = "poles";
  brakeMesh.name = "brake";
  blinkerMesh.name = "blinkers";
  headlightMesh.name = "headlights";

  const group = new THREE.Group();
  group.name = "vehicles";
  group.add(bodyMesh, cabinMesh, busMesh, poleMesh, brakeMesh, blinkerMesh, headlightMesh);

  // Persistent per-slot bookkeeping, reused across calls to avoid per-frame allocation.
  const lastCls = new Uint8Array(capacity).fill(NO_CLASS);
  const wasActive = new Uint8Array(capacity);
  const prevActive = new Uint32Array(capacity);
  let prevCount = 0;
  const scratchMatrix = new THREE.Matrix4();

  function clearIdentityParts(slot: number): void {
    bodyMesh.setMatrixAt(slot, ZERO_SCALE_MATRIX);
    cabinMesh.setMatrixAt(slot, ZERO_SCALE_MATRIX);
    busMesh.setMatrixAt(slot, ZERO_SCALE_MATRIX);
    poleMesh.setMatrixAt(slot * 2, ZERO_SCALE_MATRIX);
    poleMesh.setMatrixAt(slot * 2 + 1, ZERO_SCALE_MATRIX);
  }

  function clearVehicle(slot: number): void {
    clearIdentityParts(slot);
    brakeMesh.setMatrixAt(slot, ZERO_SCALE_MATRIX);
    blinkerMesh.setMatrixAt(slot * 2, ZERO_SCALE_MATRIX);
    blinkerMesh.setMatrixAt(slot * 2 + 1, ZERO_SCALE_MATRIX);
    headlightMesh.setMatrixAt(slot * 2, ZERO_SCALE_MATRIX);
    headlightMesh.setMatrixAt(slot * 2 + 1, ZERO_SCALE_MATRIX);
    lastCls[slot] = NO_CLASS;
  }

  function writeCarLike(
    slot: number,
    cls: number,
    id: number,
    x: number,
    y: number,
    heading: number,
  ): void {
    const dims = CLASS_DIMS[cls] as ClassDims;
    composeBoxMatrix(
      scratchMatrix,
      x,
      y,
      heading,
      { forwardM: 0, upM: dims.heightM / 2, rightM: 0 },
      dims,
    );
    bodyMesh.setMatrixAt(slot, scratchMatrix);
    bodyMesh.setColorAt(slot, carColorFor(cls, id));
    composeBoxMatrix(
      scratchMatrix,
      x,
      y,
      heading,
      { forwardM: CABIN_FORWARD_OFFSET_M, upM: dims.heightM + CABIN_HEIGHT_M / 2, rightM: 0 },
      {
        lengthM: CABIN_LENGTH_M,
        heightM: CABIN_HEIGHT_M,
        widthM: dims.widthM * CABIN_WIDTH_FACTOR,
      },
    );
    cabinMesh.setMatrixAt(slot, scratchMatrix);
  }

  function writeBusLike(slot: number, cls: number, x: number, y: number, heading: number): void {
    const dims = CLASS_DIMS[cls] as ClassDims;
    composeBoxMatrix(
      scratchMatrix,
      x,
      y,
      heading,
      { forwardM: 0, upM: dims.heightM / 2, rightM: 0 },
      dims,
    );
    busMesh.setMatrixAt(slot, scratchMatrix);
    busMesh.setColorAt(slot, cls === BUS_CODE ? BUS_COLOR : TROLLEYBUS_COLOR);
    if (cls !== TROLLEYBUS_CODE) return;
    const poleSize = { lengthM: POLE_LENGTH_M, heightM: POLE_HEIGHT_M, widthM: POLE_WIDTH_M };
    composeBoxMatrix(
      scratchMatrix,
      x,
      y,
      heading,
      {
        forwardM: POLE_FORWARD_OFFSET_M,
        upM: dims.heightM + POLE_HEIGHT_M / 2,
        rightM: -POLE_LATERAL_OFFSET_M,
      },
      poleSize,
    );
    poleMesh.setMatrixAt(slot * 2, scratchMatrix);
    composeBoxMatrix(
      scratchMatrix,
      x,
      y,
      heading,
      {
        forwardM: POLE_FORWARD_OFFSET_M,
        upM: dims.heightM + POLE_HEIGHT_M / 2,
        rightM: POLE_LATERAL_OFFSET_M,
      },
      poleSize,
    );
    poleMesh.setMatrixAt(slot * 2 + 1, scratchMatrix);
  }

  function writeLights(
    slot: number,
    cls: number,
    flags: number,
    x: number,
    y: number,
    heading: number,
    simTimeS: number,
  ): void {
    const dims = CLASS_DIMS[cls] as ClassDims;
    if ((flags & VehicleFlag.BRAKING) !== 0) {
      composeBoxMatrix(
        scratchMatrix,
        x,
        y,
        heading,
        { forwardM: -dims.lengthM / 2, upM: BRAKE_HEIGHT_ABOVE_GROUND_M, rightM: 0 },
        {
          lengthM: BRAKE_LENGTH_M,
          heightM: BRAKE_HEIGHT_M,
          widthM: dims.widthM * BRAKE_WIDTH_FACTOR,
        },
      );
      brakeMesh.setMatrixAt(slot, scratchMatrix);
    } else {
      brakeMesh.setMatrixAt(slot, ZERO_SCALE_MATRIX);
    }

    const blinkOn = isBlinkOn(simTimeS, BLINKER_HZ);
    const blinkerSize = {
      lengthM: BLINKER_SIZE_M,
      heightM: BLINKER_SIZE_M,
      widthM: BLINKER_SIZE_M,
    };
    const showLeft = blinkOn && (flags & VehicleFlag.BLINKER_LEFT) !== 0;
    if (showLeft) {
      composeBoxMatrix(
        scratchMatrix,
        x,
        y,
        heading,
        {
          forwardM: dims.lengthM / 2,
          upM: BLINKER_HEIGHT_ABOVE_GROUND_M,
          rightM: -dims.widthM / 2,
        },
        blinkerSize,
      );
      blinkerMesh.setMatrixAt(slot * 2, scratchMatrix);
    } else {
      blinkerMesh.setMatrixAt(slot * 2, ZERO_SCALE_MATRIX);
    }
    const showRight = blinkOn && (flags & VehicleFlag.BLINKER_RIGHT) !== 0;
    if (showRight) {
      composeBoxMatrix(
        scratchMatrix,
        x,
        y,
        heading,
        { forwardM: dims.lengthM / 2, upM: BLINKER_HEIGHT_ABOVE_GROUND_M, rightM: dims.widthM / 2 },
        blinkerSize,
      );
      blinkerMesh.setMatrixAt(slot * 2 + 1, scratchMatrix);
    } else {
      blinkerMesh.setMatrixAt(slot * 2 + 1, ZERO_SCALE_MATRIX);
    }

    // Headlights: always present at the front while the vehicle is active - dark/light is a
    // material-level emissive strength (setHeadlightIntensity), not a per-instance flag.
    const headlightSize = {
      lengthM: HEADLIGHT_SIZE_M,
      heightM: HEADLIGHT_SIZE_M,
      widthM: HEADLIGHT_SIZE_M,
    };
    const headlightRightM = (dims.widthM / 2) * HEADLIGHT_WIDTH_FACTOR;
    composeBoxMatrix(
      scratchMatrix,
      x,
      y,
      heading,
      {
        forwardM: dims.lengthM / 2,
        upM: HEADLIGHT_HEIGHT_ABOVE_GROUND_M,
        rightM: -headlightRightM,
      },
      headlightSize,
    );
    headlightMesh.setMatrixAt(slot * 2, scratchMatrix);
    composeBoxMatrix(
      scratchMatrix,
      x,
      y,
      heading,
      { forwardM: dims.lengthM / 2, upM: HEADLIGHT_HEIGHT_ABOVE_GROUND_M, rightM: headlightRightM },
      headlightSize,
    );
    headlightMesh.setMatrixAt(slot * 2 + 1, scratchMatrix);
  }

  function update(sample: RenderFrame): void {
    // 1) slots active in `sample`.
    for (let k = 0; k < sample.count; k++) wasActive[sample.slot[k] as number] = 1;
    // 2) slots active last tick but not this one: hide fully.
    for (let i = 0; i < prevCount; i++) {
      const slot = prevActive[i] as number;
      if (wasActive[slot] === 0) clearVehicle(slot);
    }
    // 3) draw every currently active vehicle.
    for (let k = 0; k < sample.count; k++) {
      const slot = sample.slot[k] as number;
      const cls = sample.cls[k] as number;
      if ((lastCls[slot] as number) !== cls) {
        clearIdentityParts(slot);
        lastCls[slot] = cls;
      }
      const x = sample.x[k] as number;
      const y = sample.y[k] as number;
      const heading = sample.heading[k] as number;
      if (isCarLike(cls)) writeCarLike(slot, cls, sample.id[k] as number, x, y, heading);
      else writeBusLike(slot, cls, x, y, heading);
      writeLights(slot, cls, sample.flags[k] as number, x, y, heading, sample.simTimeS);
      prevActive[k] = slot;
    }
    // 4) reset the active-mask scratch for next call.
    for (let k = 0; k < sample.count; k++) wasActive[sample.slot[k] as number] = 0;
    prevCount = sample.count;

    for (const mesh of [
      bodyMesh,
      cabinMesh,
      busMesh,
      poleMesh,
      brakeMesh,
      blinkerMesh,
      headlightMesh,
    ]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
    if (busMesh.instanceColor) busMesh.instanceColor.needsUpdate = true;
  }

  function setHeadlightIntensity(intensity: number): void {
    (headlightMesh.material as THREE.MeshLambertMaterial).emissiveIntensity = intensity;
  }

  return { object: group, update, setHeadlightIntensity };
}
