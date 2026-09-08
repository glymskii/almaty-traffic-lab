import * as THREE from "three";

/** Fail fast on a broken cross-reference. Networks are contracts-validated upstream (see data/loadNetwork.ts); this guards internal invariants, not user input. */
export function mustGet<T>(map: ReadonlyMap<string, T>, id: string, what: string): T {
  const value = map.get(id);
  if (!value) throw new Error(`${what} ${id} not found`);
  return value;
}

interface MapHolder {
  map?: THREE.Texture | null;
}

/**
 * Free every mesh's geometry, material(s) and any texture map under `root` - JS garbage collection
 * doesn't release the GPU-side buffers Three.js allocated for them. Needed wherever a scene branch
 * can be torn down and rebuilt (component unmount, HMR, future re-routing), which is exactly what
 * Viewport.tsx's cleanup does for the road/markings/connector groups.
 */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      (material as MapHolder).map?.dispose();
      material.dispose();
    }
  });
}

/**
 * Model matrix for one box- or sphere-shaped instance in vehicles.ts/signals.ts: local +X is
 * "forward", +Z is "right", +Y is "up" (derived in docs/tasks/T-13 from `THREE.Matrix4.makeRotationY`,
 * chosen so that `headingRad` - CCW from +x, CLAUDE.md - can be handed straight to
 * `Quaternion.setFromAxisAngle(Y, headingRad)`). `local` is the instance's centre in that frame
 * (metres, relative to the vehicle/pole's own map point); `sizeM` scales a unit (1x1x1) box or
 * (radius 1) sphere geometry to its real dimensions. Mirrors ribbon.ts's `toVec3`: map (x, y) ->
 * THREE (x, height, -y).
 */
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();

export function composeBoxMatrix(
  out: THREE.Matrix4,
  mapX: number,
  mapY: number,
  headingRad: number,
  local: { forwardM: number; upM: number; rightM: number },
  sizeM: { lengthM: number; heightM: number; widthM: number },
): THREE.Matrix4 {
  const cos = Math.cos(headingRad);
  const sin = Math.sin(headingRad);
  scratchPosition.set(
    mapX + local.forwardM * cos + local.rightM * sin,
    local.upM,
    -mapY + (-local.forwardM * sin + local.rightM * cos),
  );
  scratchQuaternion.setFromAxisAngle(Y_AXIS, headingRad);
  scratchScale.set(sizeM.lengthM, sizeM.heightM, sizeM.widthM);
  return out.compose(scratchPosition, scratchQuaternion, scratchScale);
}

/** Shared "hide this instance" matrix for InstancedMesh.setMatrixAt - never mutated, safe to reuse everywhere. */
export const ZERO_SCALE_MATRIX: THREE.Matrix4 = new THREE.Matrix4().makeScale(0, 0, 0);
