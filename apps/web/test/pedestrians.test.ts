import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { sampleAtS } from "../src/geometry/lane-geometry.ts";
import { createPedestrianInstances, MAX_PEDS_PER_CROSSWALK } from "../src/scene/pedestrians.ts";
import { buildSignalizedJunction } from "./fixtures.ts";

function positionAt(mesh: THREE.InstancedMesh, index: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const position = new THREE.Vector3();
  matrix.decompose(position, new THREE.Quaternion(), new THREE.Vector3());
  return position;
}

/**
 * True scale magnitude of instance `index`'s first basis column (see vehicles.test.ts for why:
 * `Matrix4.decompose` reports a genuinely zero-scale matrix as (1,1,1), not (0,0,0)).
 */
function instanceScale(mesh: THREE.InstancedMesh, index: number): number {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const e = matrix.elements;
  return Math.hypot(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0);
}

describe("createPedestrianInstances", () => {
  const network = buildSignalizedJunction(); // 2 crosswalks: cw_signalized (index 0), cw_zebra (index 1)

  it("draws exactly crosswalkPeds[i] visible dots for crosswalk i, the rest hidden", () => {
    const pedestrians = createPedestrianInstances(network);
    const mesh = pedestrians.object as THREE.InstancedMesh;
    pedestrians.update(new Uint8Array([3, 0]));

    let visibleForFirstCrosswalk = 0;
    // The first MAX_PEDS_PER_CROSSWALK slots belong to crosswalk 0 (see pedestrians.ts).
    for (let i = 0; i < MAX_PEDS_PER_CROSSWALK; i++) {
      if (instanceScale(mesh, i) > 0) visibleForFirstCrosswalk++;
    }
    expect(visibleForFirstCrosswalk).toBe(3);

    let visibleForSecondCrosswalk = 0;
    for (let i = MAX_PEDS_PER_CROSSWALK; i < MAX_PEDS_PER_CROSSWALK * 2; i++) {
      if (instanceScale(mesh, i) > 0) visibleForSecondCrosswalk++;
    }
    expect(visibleForSecondCrosswalk).toBe(0);
  });

  it("spreads the dots evenly along the crosswalk's own geometry", () => {
    const pedestrians = createPedestrianInstances(network);
    const mesh = pedestrians.object as THREE.InstancedMesh;
    pedestrians.update(new Uint8Array([2, 0]));

    const crosswalk = network.crosswalks[0];
    if (!crosswalk) throw new Error("fixture has no crosswalks");
    const totalM = 16; // cw_signalized.lengthM
    const expectedFirst = sampleAtS(crosswalk.geometry, totalM * (0.5 / 2)).point;
    const expectedSecond = sampleAtS(crosswalk.geometry, totalM * (1.5 / 2)).point;

    const first = positionAt(mesh, 0);
    const second = positionAt(mesh, 1);
    expect(first.x).toBeCloseTo(expectedFirst[0]);
    expect(first.z).toBeCloseTo(-expectedFirst[1]);
    expect(second.x).toBeCloseTo(expectedSecond[0]);
    expect(second.z).toBeCloseTo(-expectedSecond[1]);
  });

  it("clamps a headcount above the visual cap instead of throwing or overflowing into the next crosswalk", () => {
    const pedestrians = createPedestrianInstances(network);
    const mesh = pedestrians.object as THREE.InstancedMesh;
    expect(() => pedestrians.update(new Uint8Array([255, 0]))).not.toThrow();
    // every slot for crosswalk 0 is visible, and crosswalk 1's slots are untouched (still hidden).
    for (let i = 0; i < MAX_PEDS_PER_CROSSWALK; i++)
      expect(instanceScale(mesh, i)).toBeGreaterThan(0);
    for (let i = MAX_PEDS_PER_CROSSWALK; i < MAX_PEDS_PER_CROSSWALK * 2; i++)
      expect(instanceScale(mesh, i)).toBe(0);
  });
});

describe("frustum culling", () => {
  it("disables per-object culling so pedestrians never vanish with the origin", () => {
    const network = buildSignalizedJunction();
    const instances = createPedestrianInstances(network);
    const mesh = instances.object as unknown as THREE.InstancedMesh;
    expect(mesh.isInstancedMesh).toBe(true);
    expect(mesh.frustumCulled).toBe(false);
  });
});
