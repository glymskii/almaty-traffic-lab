import { type Crosswalk, type Network, polylineLength } from "@atl/contracts";
import * as THREE from "three";
import { sampleAtS } from "../geometry/lane-geometry.ts";
import { composeBoxMatrix, ZERO_SCALE_MATRIX } from "./util.ts";

/**
 * Pedestrians (docs/tasks/T-13): `crosswalkPeds[i]` dots per crosswalk, spread evenly along the
 * crossing's own geometry ("across the carriageway", network.ts) - not along the direction of
 * travel, so the dots read as people standing shoulder to shoulder on the zebra. `i` is the
 * crosswalk's own index in `network.crosswalks` (docs/tasks/T-13: matches
 * `FrameBuffers.crosswalkPeds`, same order sim-core's `crosswalkIds()` uses).
 */

/** Generous visual cap per crossing - `crosswalkPeds` is a live headcount, not itself bounded. */
export const MAX_PEDS_PER_CROSSWALK = 24;
const PED_RADIUS_M = 0.3;
const PED_HEIGHT_M = 0.9;
const PED_COLOR = "#d9cba8";

export interface PedestrianInstances {
  readonly object: THREE.Object3D;
  /** `crosswalkPeds` = FrameBuffers.crosswalkPeds. */
  update(crosswalkPeds: Uint8Array): void;
}

export function createPedestrianInstances(network: Network): PedestrianInstances {
  const crosswalks = network.crosswalks;
  const capacity = Math.max(crosswalks.length * MAX_PEDS_PER_CROSSWALK, 1);

  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 8, 6),
    new THREE.MeshLambertMaterial({ color: PED_COLOR }),
    capacity,
  );
  mesh.count = capacity;
  mesh.name = "pedestrians";
  for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, ZERO_SCALE_MATRIX);
  // Same stale-bounding-sphere trap as vehicles.ts: the cached sphere would be a point at the
  // origin, culling every pedestrian as soon as the origin leaves the view.
  mesh.frustumCulled = false;

  const scratch = new THREE.Matrix4();
  const pedSize = { lengthM: PED_RADIUS_M, heightM: PED_RADIUS_M, widthM: PED_RADIUS_M };

  function update(crosswalkPeds: Uint8Array): void {
    let slot = 0;
    for (let c = 0; c < crosswalks.length; c++) {
      const crosswalk = crosswalks[c] as Crosswalk;
      const count = Math.max(0, Math.min(crosswalkPeds[c] ?? 0, MAX_PEDS_PER_CROSSWALK));
      const totalM = polylineLength(crosswalk.geometry);
      for (let p = 0; p < MAX_PEDS_PER_CROSSWALK; p++, slot++) {
        if (p >= count) {
          mesh.setMatrixAt(slot, ZERO_SCALE_MATRIX);
          continue;
        }
        const s = totalM * ((p + 0.5) / count);
        const { point } = sampleAtS(crosswalk.geometry, s);
        composeBoxMatrix(
          scratch,
          point[0],
          point[1],
          0,
          { forwardM: 0, upM: PED_HEIGHT_M, rightM: 0 },
          pedSize,
        );
        mesh.setMatrixAt(slot, scratch);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  return { object: mesh, update };
}
