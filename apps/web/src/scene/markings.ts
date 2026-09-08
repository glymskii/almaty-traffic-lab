import {
  type Lane,
  type Network,
  type Point2,
  polylineLength,
  type TurnKind,
} from "@atl/contracts";
import * as THREE from "three";
import {
  addPoints,
  laneAxis,
  laneEdgeOffsetM,
  offsetPolyline,
  rotateVector,
  sampleAtS,
  scalePoint,
  slicePolyline,
} from "../geometry/lane-geometry.ts";
import {
  buildQuadGeometry,
  buildRibbonGeometry,
  buildTriangleGeometry,
  mergeRibbons,
} from "./ribbon.ts";
import { mustGet } from "./util.ts";

/**
 * Painted road markings: dashed/solid lane dividers, stop lines before signalized nodes, zebra
 * crosswalks, turn arrows and the bus-lane "A" letter. All geometry sits a few centimetres above
 * the pavement built in roads.ts to avoid z-fighting.
 */

const LINE_HEIGHT_M = 0.03;
const STOP_LINE_HEIGHT_M = 0.032;
const CROSSWALK_HEIGHT_M = 0.028;
const ARROW_HEIGHT_M = 0.034;
const LETTER_HEIGHT_M = 0.034;

const LINE_WIDTH_M = 0.15;
const DASH_M = 3;
const GAP_M = 3;
const STOP_LINE_DEPTH_M = 0.4;
const CROSSWALK_STRIPE_LEN_M = 0.5;
const CROSSWALK_STRIPE_GAP_M = 0.5;
const CROSSWALK_STRIPE_SPAN_M = 3;
const ARROW_ZONE_M = 20;
const ARROW_MIN_ZONE_M = 4;
const ARROW_STEM_LEN_M = 2.2;
const ARROW_STEM_WIDTH_M = 0.5;
const ARROW_HEAD_LEN_M = 1.3;
const ARROW_HEAD_WIDTH_M = 1.1;
const LETTER_SPACING_M = 15;
const LETTER_SIZE_FACTOR = 0.6;

const MARKING_WHITE = new THREE.Color("#e8e6df");

const TURN_ROTATIONS: Partial<Record<TurnKind, number>> = {
  through: 0,
  left: Math.PI / 2,
  right: -Math.PI / 2,
  uturn: Math.PI,
};

type Range = [number, number];

function intersectRange(a: Range, b: Range): Range | null {
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return start < end ? [start, end] : null;
}

/** `range` minus `remove` (0, 1 or 2 sub-intervals, since both are single contiguous spans). */
function subtractRange(range: Range, remove: Range | null): Range[] {
  if (!remove) return [range];
  const out: Range[] = [];
  if (range[0] < remove[0]) out.push([range[0], Math.min(range[1], remove[0])]);
  if (range[1] > remove[1]) out.push([Math.max(range[0], remove[1]), range[1]]);
  return out.filter(([start, end]) => end - start > 1e-6);
}

function dashSegments(centerline: readonly Point2[], color: THREE.Color): THREE.BufferGeometry[] {
  const total = polylineLength(centerline);
  const out: THREE.BufferGeometry[] = [];
  for (let s = 0; s < total; s += DASH_M + GAP_M) {
    const dash = slicePolyline(centerline, s, Math.min(s + DASH_M, total));
    out.push(buildRibbonGeometry(dash, LINE_WIDTH_M, LINE_HEIGHT_M, color));
  }
  return out;
}

/** Dashed dividers between general/pocket lanes, solid dividers around bus lanes and along the outer road edges. */
export function buildLaneDividers(network: Network): THREE.BufferGeometry[] {
  const lanesById = new Map(network.lanes.map((lane) => [lane.id, lane]));
  const out: THREE.BufferGeometry[] = [];

  const addStripe = (
    linkGeometry: readonly Point2[],
    laneCount: number,
    index: number,
    widthM: number,
    side: "left" | "right",
    range: Range,
    solid: boolean,
  ) => {
    const axis = offsetPolyline(linkGeometry, laneEdgeOffsetM(index, laneCount, widthM, side));
    const segment = slicePolyline(axis, range[0], range[1]);
    if (solid) out.push(buildRibbonGeometry(segment, LINE_WIDTH_M, LINE_HEIGHT_M, MARKING_WHITE));
    else out.push(...dashSegments(segment, MARKING_WHITE));
  };

  for (const link of network.links) {
    const laneCount = link.laneIds.length;
    const lanes = link.laneIds.map((id) => mustGet(lanesById, id, "lane"));
    for (let i = 0; i < laneCount; i++) {
      const lane = lanes[i] as Lane;
      const range: Range = [lane.startS, lane.endS];

      if (i === 0) {
        addStripe(link.geometry, laneCount, i, lane.widthM, "left", range, true);
      } else {
        const leftNeighbor = lanes[i - 1] as Lane;
        const overlap = intersectRange(range, [leftNeighbor.startS, leftNeighbor.endS]);
        if (overlap) {
          const solid = lane.kind === "bus" || leftNeighbor.kind === "bus";
          addStripe(link.geometry, laneCount, i, lane.widthM, "left", overlap, solid);
        }
        for (const exposed of subtractRange(range, overlap)) {
          addStripe(link.geometry, laneCount, i, lane.widthM, "left", exposed, true);
        }
      }

      if (i === laneCount - 1) {
        addStripe(link.geometry, laneCount, i, lane.widthM, "right", range, true);
      } else {
        const rightNeighbor = lanes[i + 1] as Lane;
        const overlap = intersectRange(range, [rightNeighbor.startS, rightNeighbor.endS]);
        for (const exposed of subtractRange(range, overlap)) {
          addStripe(link.geometry, laneCount, i, lane.widthM, "right", exposed, true);
        }
      }
    }
  }
  return out;
}

/** One stop line per lane whose link ends at a signalized node, at the lane's own end (skips lanes that end early). */
export function buildStopLines(network: Network): THREE.BufferGeometry[] {
  const nodesById = new Map(network.nodes.map((node) => [node.id, node]));
  const lanesById = new Map(network.lanes.map((lane) => [lane.id, lane]));
  const out: THREE.BufferGeometry[] = [];
  const EPS_M = 0.5;

  for (const link of network.links) {
    const toNode = mustGet(nodesById, link.toNodeId, "node");
    if (toNode.kind !== "signalized") continue;
    const laneCount = link.laneIds.length;
    for (let index = 0; index < laneCount; index++) {
      const laneId = link.laneIds[index] as string;
      const lane = mustGet(lanesById, laneId, "lane");
      if (lane.endS < link.lengthM - EPS_M) continue;
      const axis = laneAxis(link.geometry, index, laneCount, lane.widthM);
      const { point, heading } = sampleAtS(axis, lane.endS);
      out.push(
        buildQuadGeometry(
          point,
          lane.widthM * 0.9,
          STOP_LINE_DEPTH_M,
          heading,
          STOP_LINE_HEIGHT_M,
          MARKING_WHITE,
        ),
      );
    }
  }
  return out;
}

/** Zebra stripes across every crosswalk, painted along the crossing's own geometry. */
export function buildCrosswalks(network: Network): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const crosswalk of network.crosswalks) {
    const total = polylineLength(crosswalk.geometry);
    for (
      let s = CROSSWALK_STRIPE_LEN_M / 2;
      s < total;
      s += CROSSWALK_STRIPE_LEN_M + CROSSWALK_STRIPE_GAP_M
    ) {
      const { point, heading } = sampleAtS(crosswalk.geometry, s);
      out.push(
        buildQuadGeometry(
          point,
          CROSSWALK_STRIPE_SPAN_M,
          CROSSWALK_STRIPE_LEN_M,
          heading,
          CROSSWALK_HEIGHT_M,
          MARKING_WHITE,
        ),
      );
    }
  }
  return out;
}

function buildArrow(center: Point2, forward: Point2): THREE.BufferGeometry[] {
  const totalLen = ARROW_STEM_LEN_M + ARROW_HEAD_LEN_M;
  const stemCenter = addPoints(center, scalePoint(forward, -totalLen / 2 + ARROW_STEM_LEN_M / 2));
  const headCenter = addPoints(center, scalePoint(forward, totalLen / 2 - ARROW_HEAD_LEN_M / 2));
  return [
    buildQuadGeometry(
      stemCenter,
      ARROW_STEM_WIDTH_M,
      ARROW_STEM_LEN_M,
      forward,
      ARROW_HEIGHT_M,
      MARKING_WHITE,
    ),
    buildTriangleGeometry(
      headCenter,
      ARROW_HEAD_WIDTH_M,
      ARROW_HEAD_LEN_M,
      forward,
      ARROW_HEIGHT_M,
      MARKING_WHITE,
    ),
  ];
}

/** One painted arrow per turn kind permitted from a lane, spread over the last ARROW_ZONE_M metres. Skips merge/diverge (no standard pavement arrow). */
export function buildTurnArrows(network: Network): THREE.BufferGeometry[] {
  const lanesById = new Map(network.lanes.map((lane) => [lane.id, lane]));
  const out: THREE.BufferGeometry[] = [];

  for (const link of network.links) {
    const laneCount = link.laneIds.length;
    for (let index = 0; index < laneCount; index++) {
      const laneId = link.laneIds[index] as string;
      const lane = mustGet(lanesById, laneId, "lane");
      const kinds = lane.turns.filter((turn) => TURN_ROTATIONS[turn] !== undefined);
      if (kinds.length === 0) continue;

      const zoneStart = Math.max(lane.startS, lane.endS - ARROW_ZONE_M);
      if (lane.endS - zoneStart < ARROW_MIN_ZONE_M) continue;

      const axis = laneAxis(link.geometry, index, laneCount, lane.widthM);
      const step = (lane.endS - zoneStart) / (kinds.length + 1);
      kinds.forEach((turn, k) => {
        const s = zoneStart + step * (k + 1);
        const { point, heading } = sampleAtS(axis, s);
        const rotation = TURN_ROTATIONS[turn] as number;
        const forward = rotateVector(heading, rotation);
        out.push(...buildArrow(point, forward));
      });
    }
  }
  return out;
}

function createBusLetterTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("createBusLetterTexture: 2d canvas context unavailable");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#e8e6df";
  ctx.font = "bold 104px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("А", canvas.width / 2, canvas.height / 2 + 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Repeating "A" glyphs (the Russian/Kazakh road marking for a dedicated bus lane) painted along
 * every bus lane. Every glyph shares the same quad UVs and texture, so they merge into one mesh
 * instead of one draw call per letter - a real network can have hundreds of these. Skipped outside
 * a browser (no canvas/document).
 */
function buildBusLaneLetters(network: Network): THREE.Mesh | null {
  if (typeof document === "undefined") return null;
  const lanesById = new Map(network.lanes.map((lane) => [lane.id, lane]));
  const geometries: THREE.BufferGeometry[] = [];

  for (const link of network.links) {
    const laneCount = link.laneIds.length;
    for (let index = 0; index < laneCount; index++) {
      const laneId = link.laneIds[index] as string;
      const lane = mustGet(lanesById, laneId, "lane");
      if (lane.kind !== "bus") continue;
      const axis = laneAxis(link.geometry, index, laneCount, lane.widthM);
      const total = lane.endS - lane.startS;
      const count = Math.max(1, Math.floor(total / LETTER_SPACING_M));
      for (let k = 0; k < count; k++) {
        const s = lane.startS + LETTER_SPACING_M * (k + 0.5);
        if (s > lane.endS) continue;
        const { point, heading } = sampleAtS(axis, s);
        const size = lane.widthM * LETTER_SIZE_FACTOR;
        geometries.push(buildQuadGeometry(point, size, size, heading, LETTER_HEIGHT_M));
      }
    }
  }

  const merged = mergeRibbons(geometries);
  if (!merged) return null;
  const material = new THREE.MeshBasicMaterial({
    map: createBusLetterTexture(),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = "bus-lane-letters";
  return mesh;
}

/** Every painted marking for `network`, as a scene group ready to add next to the road surfaces. */
export function buildMarkings(network: Network): THREE.Group {
  const group = new THREE.Group();
  group.name = "markings";

  const linesAndArrows = [
    ...buildLaneDividers(network),
    ...buildStopLines(network),
    ...buildCrosswalks(network),
    ...buildTurnArrows(network),
  ];
  const merged = mergeRibbons(linesAndArrows);
  if (merged) {
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    );
    mesh.name = "lines-and-arrows";
    group.add(mesh);
  }

  const letters = buildBusLaneLetters(network);
  if (letters) group.add(letters);

  return group;
}
