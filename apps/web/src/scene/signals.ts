import { type Connector, type Network, SignalState, type SignalStateCode } from "@atl/contracts";
import * as THREE from "three";
import {
  addPoints,
  laneAxis,
  rotateVector,
  sampleAtS,
  scalePoint,
} from "../geometry/lane-geometry.ts";
import { isBlinkOn } from "./interpolation.ts";
import { mergeRibbons } from "./ribbon.ts";
import { composeBoxMatrix, mustGet } from "./util.ts";

/**
 * Signal heads (docs/tasks/T-13): one pole + housing per signal group, built once as static
 * geometry (like markings.ts), plus the actual coloured lamps as two small InstancedMeshes
 * (spheres for the 3-lamp main section, boxes for the single arrow-section lamp) whose colour is
 * updated every frame from `FrameBuffers.signalStates`.
 *
 * `signalStates` is indexed by "global group index": controllers in `network.signalControllers`
 * order, groups in `controller.groups` order (state.ts) - including pedestrian-kind groups, which
 * this module does not render a head for but must still count to keep later indices aligned.
 */

const HEAD_LATERAL_OFFSET_M = 2; // docs/tasks/T-13: "смещение вправо на 2 м"

const POLE_HEIGHT_M = 3.2;
const POLE_THICKNESS_M = 0.12;
const MAIN_HOUSING_SIZE: [number, number, number] = [0.42, 1.1, 0.3];
const ARROW_HOUSING_SIZE: [number, number, number] = [0.34, 0.42, 0.26];
const MAIN_LAMP_RADIUS_M = 0.14;
const ARROW_LAMP_SIZE_M = 0.22;
const LAMP_ROW_GAP_M = 0.34;
const LAMP_FORWARD_OFFSET_M = -0.2; // pokes slightly toward the approaching driver, out of the housing face
const FLASH_HZ = 1;

const POLE_COLOR = new THREE.Color("#4a4d52");
const HOUSING_COLOR = new THREE.Color("#2f3236");
const OFF_LAMP_COLOR = new THREE.Color("#2a2a2a");
const RED_LAMP_COLOR = new THREE.Color("#e2453b");
const YELLOW_LAMP_COLOR = new THREE.Color("#e2c23b");
const GREEN_LAMP_COLOR = new THREE.Color("#3be26b");

export type SignalHeadKind = "main" | "arrow";

export interface SignalHeadLayout {
  /** Index into FrameBuffers.signalStates. */
  groupIndex: number;
  groupId: string;
  kind: SignalHeadKind;
  side?: "left" | "right";
  x: number;
  y: number;
  /** Radians, CCW from +x - the approach's direction of travel at the stop line (CLAUDE.md). */
  heading: number;
}

/** One lane-end position per rendered signal group (main and arrow_left/right; pedestrian groups are skipped). */
export function buildSignalHeadLayouts(network: Network): SignalHeadLayout[] {
  const linksById = new Map(network.links.map((l) => [l.id, l]));
  const lanesById = new Map(network.lanes.map((l) => [l.id, l]));
  const connectorsById = new Map(network.connectors.map((c) => [c.id, c]));

  const layouts: SignalHeadLayout[] = [];
  let groupIndex = 0;
  for (const controller of network.signalControllers) {
    for (const group of controller.groups) {
      const index = groupIndex;
      groupIndex++;
      if (group.kind !== "vehicle") continue;

      const firstConnectorId = group.connectorIds[0];
      if (!firstConnectorId) throw new Error(`signal group ${group.id}: no connectors`);
      const connector = mustGet<Connector>(connectorsById, firstConnectorId, "connector");
      const lane = mustGet(lanesById, connector.fromLaneId, "lane");
      const link = mustGet(linksById, lane.linkId, "link");
      const axis = laneAxis(link.geometry, lane.index, link.laneIds.length, lane.widthM);
      const { point, heading } = sampleAtS(axis, lane.endS);
      const right = rotateVector(heading, -Math.PI / 2);
      const headPoint = addPoints(point, scalePoint(right, HEAD_LATERAL_OFFSET_M));
      const headingRad = Math.atan2(heading[1], heading[0]);

      if (group.section === "main") {
        layouts.push({
          groupIndex: index,
          groupId: group.id,
          kind: "main",
          x: headPoint[0],
          y: headPoint[1],
          heading: headingRad,
        });
      } else {
        layouts.push({
          groupIndex: index,
          groupId: group.id,
          kind: "arrow",
          side: group.section === "arrow_left" ? "left" : "right",
          x: headPoint[0],
          y: headPoint[1],
          heading: headingRad,
        });
      }
    }
  }
  return layouts;
}

function housingHeightM(layout: SignalHeadLayout): number {
  return layout.kind === "main" ? MAIN_HOUSING_SIZE[1] : ARROW_HOUSING_SIZE[1];
}

/** Flat-tints every vertex of `geometry` with `color`, for merging heterogeneous boxes into one vertex-coloured mesh (mirrors ribbon.ts's own private helper). */
function paintColor(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) colors.set([color.r, color.g, color.b], i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Static pole + housing box geometry for one head, baked to its world position (no instancing - a network has at most a few hundred heads). */
function buildPoleAndHousing(layout: SignalHeadLayout): THREE.BufferGeometry[] {
  const scratch = new THREE.Matrix4();
  const pole = new THREE.BoxGeometry(1, 1, 1);
  composeBoxMatrix(
    scratch,
    layout.x,
    layout.y,
    layout.heading,
    { forwardM: 0, upM: POLE_HEIGHT_M / 2, rightM: 0 },
    { lengthM: POLE_THICKNESS_M, heightM: POLE_HEIGHT_M, widthM: POLE_THICKNESS_M },
  );
  pole.applyMatrix4(scratch);
  paintColor(pole, POLE_COLOR);

  const [housingW, housingH, housingD] =
    layout.kind === "main" ? MAIN_HOUSING_SIZE : ARROW_HOUSING_SIZE;
  const housing = new THREE.BoxGeometry(1, 1, 1);
  composeBoxMatrix(
    scratch,
    layout.x,
    layout.y,
    layout.heading,
    { forwardM: 0, upM: POLE_HEIGHT_M + housingH / 2, rightM: 0 },
    { lengthM: housingD, heightM: housingH, widthM: housingW },
  );
  housing.applyMatrix4(scratch);
  paintColor(housing, HOUSING_COLOR);
  return [pole, housing];
}

function mainLampColors(
  state: SignalStateCode,
  simTimeS: number,
): [THREE.Color, THREE.Color, THREE.Color] {
  switch (state) {
    case SignalState.RED:
      return [RED_LAMP_COLOR, OFF_LAMP_COLOR, OFF_LAMP_COLOR];
    case SignalState.RED_YELLOW:
      return [RED_LAMP_COLOR, YELLOW_LAMP_COLOR, OFF_LAMP_COLOR];
    case SignalState.GREEN:
      return [OFF_LAMP_COLOR, OFF_LAMP_COLOR, GREEN_LAMP_COLOR];
    case SignalState.FLASHING_GREEN:
      return [
        OFF_LAMP_COLOR,
        OFF_LAMP_COLOR,
        isBlinkOn(simTimeS, FLASH_HZ) ? GREEN_LAMP_COLOR : OFF_LAMP_COLOR,
      ];
    case SignalState.YELLOW:
      return [OFF_LAMP_COLOR, YELLOW_LAMP_COLOR, OFF_LAMP_COLOR];
    default:
      return [OFF_LAMP_COLOR, OFF_LAMP_COLOR, OFF_LAMP_COLOR];
  }
}

/** Arrow (доп.секция) heads have no physical red/yellow bulb (network.ts: "OFF, not red, when not permitted"). */
function arrowLampColor(state: SignalStateCode, simTimeS: number): THREE.Color {
  if (state === SignalState.GREEN) return GREEN_LAMP_COLOR;
  if (state === SignalState.FLASHING_GREEN) {
    return isBlinkOn(simTimeS, FLASH_HZ) ? GREEN_LAMP_COLOR : OFF_LAMP_COLOR;
  }
  return OFF_LAMP_COLOR;
}

export interface SignalInstances {
  readonly object: THREE.Group;
  /** `signalStates` = FrameBuffers.signalStates (global group order, see module docstring). */
  update(signalStates: Uint8Array, simTimeS: number): void;
}

export function createSignalInstances(network: Network): SignalInstances {
  const layouts = buildSignalHeadLayouts(network);
  const mainLayouts = layouts.filter(
    (l): l is SignalHeadLayout & { kind: "main" } => l.kind === "main",
  );
  const arrowLayouts = layouts.filter(
    (l): l is SignalHeadLayout & { kind: "arrow" } => l.kind === "arrow",
  );

  const group = new THREE.Group();
  group.name = "signals";

  const staticGeometries = layouts.flatMap(buildPoleAndHousing);
  const staticMerged = mergeRibbons(staticGeometries);
  if (staticMerged) {
    const mesh = new THREE.Mesh(
      staticMerged,
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    mesh.name = "signal-poles";
    group.add(mesh);
  }

  const mainLampMaterial = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const mainLampMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 8),
    mainLampMaterial,
    Math.max(mainLayouts.length * 3, 1),
  );
  mainLampMesh.count = mainLayouts.length * 3;
  mainLampMesh.name = "main-lamps";
  mainLampMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(mainLayouts.length * 3, 1) * 3),
    3,
  );

  const arrowLampMaterial = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const arrowLampMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    arrowLampMaterial,
    Math.max(arrowLayouts.length, 1),
  );
  arrowLampMesh.count = arrowLayouts.length;
  arrowLampMesh.name = "arrow-lamps";
  arrowLampMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(arrowLayouts.length, 1) * 3),
    3,
  );

  group.add(mainLampMesh, arrowLampMesh);

  const scratch = new THREE.Matrix4();
  const mainLampLocalUpM = mainLayouts.map(
    (l) => POLE_HEIGHT_M + housingHeightM(l) - MAIN_LAMP_RADIUS_M * 1.3,
  );
  for (let i = 0; i < mainLayouts.length; i++) {
    const layout = mainLayouts[i] as SignalHeadLayout;
    const topUpM = mainLampLocalUpM[i] as number;
    for (let row = 0; row < 3; row++) {
      composeBoxMatrix(
        scratch,
        layout.x,
        layout.y,
        layout.heading,
        { forwardM: LAMP_FORWARD_OFFSET_M, upM: topUpM - row * LAMP_ROW_GAP_M, rightM: 0 },
        { lengthM: MAIN_LAMP_RADIUS_M, heightM: MAIN_LAMP_RADIUS_M, widthM: MAIN_LAMP_RADIUS_M },
      );
      mainLampMesh.setMatrixAt(i * 3 + row, scratch);
    }
  }
  for (let i = 0; i < arrowLayouts.length; i++) {
    const layout = arrowLayouts[i] as SignalHeadLayout;
    composeBoxMatrix(
      scratch,
      layout.x,
      layout.y,
      layout.heading,
      {
        forwardM: LAMP_FORWARD_OFFSET_M,
        upM: POLE_HEIGHT_M + housingHeightM(layout) / 2,
        rightM: 0,
      },
      { lengthM: ARROW_LAMP_SIZE_M, heightM: ARROW_LAMP_SIZE_M, widthM: ARROW_LAMP_SIZE_M },
    );
    arrowLampMesh.setMatrixAt(i, scratch);
  }
  mainLampMesh.instanceMatrix.needsUpdate = true;
  arrowLampMesh.instanceMatrix.needsUpdate = true;

  function update(signalStates: Uint8Array, simTimeS: number): void {
    for (let i = 0; i < mainLayouts.length; i++) {
      const layout = mainLayouts[i] as SignalHeadLayout;
      const state = (signalStates[layout.groupIndex] ?? SignalState.OFF) as SignalStateCode;
      const [red, yellow, green] = mainLampColors(state, simTimeS);
      mainLampMesh.setColorAt(i * 3, red);
      mainLampMesh.setColorAt(i * 3 + 1, yellow);
      mainLampMesh.setColorAt(i * 3 + 2, green);
    }
    for (let i = 0; i < arrowLayouts.length; i++) {
      const layout = arrowLayouts[i] as SignalHeadLayout;
      const state = (signalStates[layout.groupIndex] ?? SignalState.OFF) as SignalStateCode;
      arrowLampMesh.setColorAt(i, arrowLampColor(state, simTimeS));
    }
    if (mainLampMesh.instanceColor) mainLampMesh.instanceColor.needsUpdate = true;
    if (arrowLampMesh.instanceColor) arrowLampMesh.instanceColor.needsUpdate = true;
  }

  return { object: group, update };
}
