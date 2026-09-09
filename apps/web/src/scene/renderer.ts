import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { TimeOfDaySample } from "./time-of-day.ts";

/**
 * The Three.js "engine": renderer, camera, base lighting and ground, resize handling and the
 * requestAnimationFrame loop. Knows nothing about the network - roads/markings/labels are added
 * to `scene` by their own modules. Low-poly, no shadows, no post-processing (docs/DECISIONS.md D13).
 * Sky/light colours below are the "day" entry of time-of-day.ts's palette (`applyTimeOfDay`
 * overwrites them every frame once a sim time is known - docs/tasks/T-27 §3); they only show as
 * the very first paint, before that.
 */

const HEMI_SKY_COLOR = "#bcd6e8";
const HEMI_GROUND_COLOR = "#4a463e";
const SUN_COLOR = "#fff3e0";
const GROUND_COLOR = "#6b7060";
const BACKGROUND_COLOR = "#dfe6ea";
const GROUND_SIZE_M = 20000;
const MAX_DT_S = 0.1;
const MAX_PIXEL_RATIO = 2;

export interface Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Mutated by `applyTimeOfDay`; the same instance is always `scene.background`. */
  readonly skyColor: THREE.Color;
  readonly hemiLight: THREE.HemisphereLight;
  readonly sunLight: THREE.DirectionalLight;
  readonly groundMaterial: THREE.MeshLambertMaterial;
  /** Register a per-frame callback; returns a function that unregisters it. */
  onFrame(callback: (dtS: number) => void): () => void;
  dispose(): void;
}

export function createEngine(container: HTMLElement): Engine {
  const scene = new THREE.Scene();
  const skyColor = new THREE.Color(BACKGROUND_COLOR);
  scene.background = skyColor;

  // Near plane at 1 m, not 0.1: the scene spans kilometres, and a 0.1/5000 range leaves the depth
  // buffer with ~0.6 m of resolution a kilometre out - far coarser than the centimetre gaps between
  // road surface, markings and the heat-map overlay, so those layers flickered against each other
  // as the camera moved. The logarithmic depth buffer keeps that precision usable across the whole
  // range; the cost (no early-Z) is irrelevant for this low-overdraw, shadowless scene.
  const camera = new THREE.PerspectiveCamera(
    55,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    1,
    5000,
  );
  camera.position.set(0, 120, 200);

  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.shadowMap.enabled = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const hemiLight = new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, 1.0);
  scene.add(hemiLight);
  const sunLight = new THREE.DirectionalLight(SUN_COLOR, 1.3);
  sunLight.position.set(120, 200, 80);
  sunLight.castShadow = false;
  scene.add(sunLight);

  const groundMaterial = new THREE.MeshLambertMaterial({ color: GROUND_COLOR });
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE_M, GROUND_SIZE_M),
    groundMaterial,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.name = "ground";
  scene.add(ground);

  const frameCallbacks = new Set<(dtS: number) => void>();
  // Liveness counter for the Playwright smoke test (docs/tasks/T-30) - a fresh counter per mount
  // is fine, the test only asserts it keeps increasing after the page loads.
  window.__atl = { frames: 0 };
  let lastTimeMs = performance.now();
  let rafId = requestAnimationFrame(function animate() {
    rafId = requestAnimationFrame(animate);
    const nowMs = performance.now();
    const dtS = Math.min((nowMs - lastTimeMs) / 1000, MAX_DT_S);
    lastTimeMs = nowMs;
    for (const callback of frameCallbacks) callback(dtS);
    renderer.render(scene, camera);
    if (window.__atl) window.__atl.frames += 1;
  });

  const resize = (): void => {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  return {
    renderer,
    scene,
    camera,
    controls,
    skyColor,
    hemiLight,
    sunLight,
    groundMaterial,
    onFrame(callback) {
      frameCallbacks.add(callback);
      return () => frameCallbacks.delete(callback);
    },
    dispose() {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    },
  };
}

/** Applies a `time-of-day.ts` sample to the scene's sky/lights/ground (docs/tasks/T-27 §3). Cheap
 * enough (colour copies + two intensity assignments) to call every render frame. */
export function applyTimeOfDay(engine: Engine, sample: TimeOfDaySample): void {
  engine.skyColor.copy(sample.background);
  engine.hemiLight.color.copy(sample.hemiSky);
  engine.hemiLight.groundColor.copy(sample.hemiGround);
  engine.hemiLight.intensity = sample.hemiIntensity;
  engine.sunLight.color.copy(sample.sunColor);
  engine.sunLight.intensity = sample.sunIntensity;
  engine.groundMaterial.color.copy(sample.ground);
}
