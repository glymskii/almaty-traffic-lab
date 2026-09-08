import type { Network } from "@atl/contracts";
import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * Camera presets and free movement on top of OrbitControls (which renderer.ts owns and creates).
 * `update(dt)` must be called once per frame - it drives WASD panning, an in-flight `focus()`
 * animation and `controls.update()` itself, in that order.
 */

const MIN_POLAR_ANGLE = 0.08;
const MAX_POLAR_ANGLE = 1.45;
const WASD_SPEED_M_S = 60;
const DEFAULT_FOCUS_DURATION_S = 1.2;
const MIN_OVERVIEW_SPAN_M = 40;
const PAN_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

interface Flight {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  elapsedS: number;
  durationS: number;
}

function smoothstep(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

export class CameraRig {
  private readonly pressed = new Set<string>();
  private flight: Flight | null = null;
  // Scratch vectors reused every WASD frame instead of allocated - applyWasd runs on every frame a pan key is held.
  private readonly wasdForward = new THREE.Vector3();
  private readonly wasdRight = new THREE.Vector3();
  private readonly wasdMove = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
  ) {
    controls.minPolarAngle = MIN_POLAR_ANGLE;
    controls.maxPolarAngle = MAX_POLAR_ANGLE;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (PAN_KEYS.has(event.code)) this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  /**
   * Frame the whole network from above at an angle. Falls back to a fixed-size view for an empty
   * network. `immediate` snaps instead of flying - use it for the first show, where a fly-in from
   * the engine's arbitrary default position would just look like a glitch.
   */
  overview(network: Network, options?: { immediate?: boolean }): void {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of network.nodes) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    }
    const hasNodes = Number.isFinite(minX);
    const centerX = hasNodes ? (minX + maxX) / 2 : 0;
    const centerY = hasNodes ? (minY + maxY) / 2 : 0;
    const span = hasNodes ? Math.max(maxX - minX, maxY - minY, MIN_OVERVIEW_SPAN_M) : 300;
    const distance = span * 0.9;

    const toTarget = new THREE.Vector3(centerX, 0, -centerY);
    const toPos = new THREE.Vector3(centerX, distance * 0.75, -centerY + distance);
    if (options?.immediate) {
      this.flight = null;
      this.controls.target.copy(toTarget);
      this.camera.position.copy(toPos);
      this.controls.update();
      return;
    }
    this.startFlight(toPos, toTarget, DEFAULT_FOCUS_DURATION_S);
  }

  /** Smoothly fly to look at local map point (x, y) from a distance proportional to `radiusM`. */
  focus(x: number, y: number, radiusM: number, durationS = DEFAULT_FOCUS_DURATION_S): void {
    const toTarget = new THREE.Vector3(x, 0, -y);
    const distance = Math.max(radiusM * 2.2, 15);
    const toPos = toTarget.clone().add(new THREE.Vector3(0, distance * 0.6, distance));
    this.startFlight(toPos, toTarget, durationS);
  }

  private startFlight(toPos: THREE.Vector3, toTarget: THREE.Vector3, durationS: number): void {
    this.flight = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
      elapsedS: 0,
      durationS,
    };
  }

  /** Advance WASD panning and any active flight, then `controls.update()`. Call once per frame. */
  update(dtS: number): void {
    if (this.flight) {
      this.advanceFlight(this.flight, dtS);
    } else if (this.pressed.size > 0) {
      this.applyWasd(dtS);
    }
    this.controls.update();
  }

  private advanceFlight(flight: Flight, dtS: number): void {
    flight.elapsedS += dtS;
    const t = smoothstep(flight.elapsedS / flight.durationS);
    this.camera.position.lerpVectors(flight.fromPos, flight.toPos, t);
    this.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, t);
    if (t >= 1) this.flight = null;
  }

  private applyWasd(dtS: number): void {
    const forward = this.wasdForward;
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = this.wasdRight.crossVectors(forward, this.camera.up).normalize();

    const move = this.wasdMove.set(0, 0, 0);
    if (this.pressed.has("KeyW")) move.add(forward);
    if (this.pressed.has("KeyS")) move.sub(forward);
    if (this.pressed.has("KeyD")) move.add(right);
    if (this.pressed.has("KeyA")) move.sub(right);
    if (move.lengthSq() === 0) return;

    move.normalize().multiplyScalar(WASD_SPEED_M_S * dtS);
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }
}
