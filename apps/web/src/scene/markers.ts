import type { BottleneckItem, Los } from "@atl/contracts";
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

/**
 * CSS2D rank markers over each bottleneck's `focus` point (docs/tasks/T-25 п.3). Reuses the CSS2D
 * layer `scene/labels.ts` already sets up for street labels - `Viewport.tsx`'s per-frame
 * `labelRenderer.render(engine.scene, engine.camera)` renders every `CSS2DObject` under the scene
 * graph, so a marker group added to `engine.scene` from outside `Viewport` (see `ui/BottlenecksTab.tsx`)
 * shows up with no extra plumbing.
 */

const MARKER_HEIGHT_M = 6;

/** LOS -> marker chip colour, continuing the heat-map's muted green..red palette (docs/DECISIONS.md D11). */
const LOS_COLORS: Record<Los, string> = {
  A: "#4f8f5c",
  B: "#7fa04a",
  C: "#c7b23f",
  D: "#c98a3f",
  E: "#c96a3f",
  F: "#b0473f",
};

export interface BottleneckMarkers {
  readonly group: THREE.Group;
  /** Rebuilds one marker per item at `item.focus`; `selectedId` gets the "selected" CSS class. */
  update(items: readonly BottleneckItem[], selectedId: string | undefined): void;
  dispose(): void;
}

interface MountedMarker {
  object: CSS2DObject;
  element: HTMLDivElement;
  onClick: () => void;
}

/** `onSelect` fires with the clicked item; the caller (BottlenecksTab) selects its row and flies the camera to it. */
export function buildBottleneckMarkers(
  onSelect: (item: BottleneckItem) => void,
): BottleneckMarkers {
  const group = new THREE.Group();
  group.name = "bottleneck-markers";
  let mounted: MountedMarker[] = [];

  function clear(): void {
    for (const m of mounted) {
      m.element.removeEventListener("click", m.onClick);
      group.remove(m.object);
    }
    mounted = [];
  }

  return {
    group,
    update(items, selectedId) {
      clear();
      for (const item of items) {
        const element = document.createElement("div");
        element.className =
          item.id === selectedId ? "bottleneck-marker selected" : "bottleneck-marker";
        element.style.setProperty("--marker-color", LOS_COLORS[item.los]);
        element.textContent = `${item.rank}`;
        const onClick = (): void => onSelect(item);
        element.addEventListener("click", onClick);
        const object = new CSS2DObject(element);
        object.position.set(item.focus[0], MARKER_HEIGHT_M, -item.focus[1]);
        group.add(object);
        mounted.push({ object, element, onClick });
      }
    },
    dispose() {
      clear();
    },
  };
}
