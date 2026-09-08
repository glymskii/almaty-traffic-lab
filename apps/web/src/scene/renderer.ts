import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * The Three.js "engine": renderer, camera, base lighting and ground, resize handling and the
 * requestAnimationFrame loop. Knows nothing about the network - roads/markings/labels are added
 * to `scene` by their own modules. Low-poly, no shadows, no post-processing (docs/DECISIONS.md D13).
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
  /** Register a per-frame callback; returns a function that unregisters it. */
  onFrame(callback: (dtS: number) => void): () => void;
  dispose(): void;
}

export function createEngine(container: HTMLElement): Engine {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND_COLOR);

  const camera = new THREE.PerspectiveCamera(
    55,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    0.1,
    5000,
  );
  camera.position.set(0, 120, 200);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, 1.0));
  const sun = new THREE.DirectionalLight(SUN_COLOR, 1.3);
  sun.position.set(120, 200, 80);
  sun.castShadow = false;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE_M, GROUND_SIZE_M),
    new THREE.MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.name = "ground";
  scene.add(ground);

  const frameCallbacks = new Set<(dtS: number) => void>();
  let lastTimeMs = performance.now();
  let rafId = requestAnimationFrame(function animate() {
    rafId = requestAnimationFrame(animate);
    const nowMs = performance.now();
    const dtS = Math.min((nowMs - lastTimeMs) / 1000, MAX_DT_S);
    lastTimeMs = nowMs;
    for (const callback of frameCallbacks) callback(dtS);
    renderer.render(scene, camera);
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
