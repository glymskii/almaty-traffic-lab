import type { HighwayClass, Network } from "@atl/contracts";
import type * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { sampleAtS } from "../geometry/lane-geometry.ts";

/** Street name labels (CSS2D, so text stays crisp at any zoom) - per the task card, trunk/primary/secondary only. */
const LABELED_CLASSES: ReadonlySet<HighwayClass> = new Set(["trunk", "primary", "secondary"]);
const VISIBLE_DISTANCE_M = 500;
const LABEL_HEIGHT_M = 0.5;

export function createLabelRenderer(container: HTMLElement): CSS2DRenderer {
  const renderer = new CSS2DRenderer();
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.inset = "0";
  renderer.domElement.style.pointerEvents = "none";
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  return renderer;
}

export function resizeLabelRenderer(renderer: CSS2DRenderer, container: HTMLElement): void {
  renderer.setSize(container.clientWidth, container.clientHeight);
}

export interface StreetLabel {
  object: CSS2DObject;
}

/** One CSS2D label per named trunk/primary/secondary link, placed at its midpoint. Caller adds `.object` to the scene. */
export function buildStreetLabels(network: Network): StreetLabel[] {
  const labels: StreetLabel[] = [];
  for (const link of network.links) {
    if (!link.name || !LABELED_CLASSES.has(link.highwayClass)) continue;
    const mid = sampleAtS(link.geometry, link.lengthM / 2).point;
    const element = document.createElement("div");
    element.className = "street-label";
    element.textContent = link.name;
    const object = new CSS2DObject(element);
    object.position.set(mid[0], LABEL_HEIGHT_M, -mid[1]);
    labels.push({ object });
  }
  return labels;
}

/** Fade labels out once the camera is far enough away that they'd just clutter the view. */
export function updateLabelVisibility(camera: THREE.Camera, labels: readonly StreetLabel[]): void {
  for (const label of labels) {
    label.object.visible = camera.position.distanceTo(label.object.position) < VISIBLE_DISTANCE_M;
  }
}
