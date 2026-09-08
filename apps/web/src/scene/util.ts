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
