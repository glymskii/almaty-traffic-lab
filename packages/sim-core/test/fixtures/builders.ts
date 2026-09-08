import {
  checkNetworkIntegrity,
  cycleLengthS,
  type LeftTurnMode,
  type Link,
  type Network,
  type NetworkOverride,
  type Protection,
  parseNetwork,
  type SegmentDescriptor,
  type TurnKind,
  type VehicleClass,
} from "@atl/contracts";
import {
  add,
  cubicBezierPolyline,
  firstCrossing,
  fromAngleDeg,
  LANE_WIDTH_M,
  laneEndpoint,
  leftOf,
  normalize,
  polylineLen,
  rightOf,
  scale,
  sub,
  type Vec2,
  vecLength,
} from "./geometry.ts";
import { signalController, signalGroup, signalPhase } from "./signals.ts";

/**
 * Synthetic mini-networks for nuance tests (docs/NUANCES.md). Every builder returns a Network that
 * passes parseNetwork + checkNetworkIntegrity. Builders are deterministic and dependency-free.
 * `straightRoad` is the reference example; `crossroads`/`tJunction`/`mergeRamp`/`corridor` are T-03.
 *
 * Fixture shapes (top-down, x = east, y = north, right-hand traffic):
 *
 *   straightRoad                        crossroads (4 gates, signalized "center")
 *   g0 ================> g1                        N.gate
 *   (lanes, optional bus lane)                        |
 *                                        W.gate ---- center ---- E.gate
 *                                                       |
 *                                                     S.gate
 *                                     (left pocket + arrow phase optional per approach;
 *                                      crosswalk on each arm optional)
 *
 *   tJunction (main EW, minor from south)   mergeRamp (Al-Farabi style)
 *
 *   W.gate ------ center ------ E.gate     gate.w --500m--> merge --(mainLengthM-500m)--> gate.e
 *                    |                                         ^  20 deg
 *                    | (yield unless signalized)                \
 *                 S.gate                                     gate.ramp (from the SW)
 *
 *   corridor (N signalized crossroads sharing an EW arterial; optional parallel street)
 *
 *          parallelStreet: residential, 200m north, T-joins each cross street's north end
 *   res.gate.w ==== j0.N.gate === j1.N.gate === ... === j(last).N.gate ==== res.gate.e
 *                       |             |                        |
 *   W.gate ==== j0 ==(spacingM)== j1 ==(spacingM)== ... == j(last) ==== E.gate
 *                       |             |                        |
 *                    j0.S.gate     j1.S.gate                j(last).S.gate
 */

const ALL: VehicleClass[] = ["car", "bus", "trolleybus", "taxi"];
const PT: VehicleClass[] = ["bus", "trolleybus"];

function meta(networkId: string) {
  return {
    schemaVersion: 1 as const,
    networkId,
    bboxId: "synthetic",
    bbox: { south: 0, west: 0, north: 0, east: 0 },
    origin: { lat: 43.24, lon: 76.92 },
    generatedAt: "2026-01-01T00:00:00Z",
    generator: "synthetic-builders",
  };
}

export interface StraightRoadOptions {
  lengthM?: number;
  /** General lanes, excluding the bus lane. */
  lanes?: number;
  speedLimitKph?: number;
  /** Adds a rightmost dedicated bus lane. */
  busLane?: boolean;
  /** Places a bus stop at this position on the rightmost lane. */
  busStop?: { s: number; kind: "in_lane" | "bay" };
  /** Adds a single bus route over the road with these headways. */
  busRoute?: { headwayPeakS: number; headwayOffpeakS: number };
}

/** gate -> one directed link -> gate. Baseline for speed-limit, lane-count, bus-lane and bus-stop tests. */
export function straightRoad(opts: StraightRoadOptions = {}): Network {
  const lengthM = opts.lengthM ?? 1000;
  const lanes = opts.lanes ?? 2;
  const speed = opts.speedLimitKph ?? 60;
  const laneIds: string[] = [];
  const laneDefs = [];
  for (let i = 0; i < lanes; i++) {
    const id = `l0:${i}`;
    laneIds.push(id);
    laneDefs.push({
      id,
      linkId: "l0",
      index: i,
      startS: 0,
      endS: lengthM,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    });
  }
  if (opts.busLane) {
    const id = `l0:${lanes}`;
    laneIds.push(id);
    laneDefs.push({
      id,
      linkId: "l0",
      index: lanes,
      startS: 0,
      endS: lengthM,
      kind: "bus",
      allowed: PT,
      turns: ["through"],
      busLane: { allowed: PT },
    });
  }
  const rightmost = laneIds[laneIds.length - 1] as string;
  const busStops = opts.busStop
    ? [{ id: "stop0", linkId: "l0", laneId: rightmost, s: opts.busStop.s, kind: opts.busStop.kind }]
    : [];
  const busRoutes = opts.busRoute
    ? [
        {
          id: "route0",
          ref: "1",
          kind: "bus",
          linkIds: ["l0"],
          stopIds: busStops.map((s) => s.id),
          headwayPeakS: opts.busRoute.headwayPeakS,
          headwayOffpeakS: opts.busRoute.headwayOffpeakS,
          entryNodeId: "n0",
          exitNodeId: "n1",
        },
      ]
    : [];

  return finish({
    meta: meta("straight-road"),
    nodes: [
      { id: "n0", x: 0, y: 0, kind: "gate" },
      { id: "n1", x: lengthM, y: 0, kind: "gate" },
    ],
    links: [
      {
        id: "l0",
        fromNodeId: "n0",
        toNodeId: "n1",
        name: "Тестовая",
        highwayClass: "secondary",
        geometry: [
          [0, 0],
          [lengthM, 0],
        ],
        lengthM,
        speedLimitKph: speed,
        laneIds,
      },
    ],
    lanes: laneDefs,
    connectors: [],
    gates: [
      { id: "g0", nodeId: "n0", inLinkIds: ["l0"], weightIn: 1, weightOut: 0 },
      { id: "g1", nodeId: "n1", outLinkIds: ["l0"], weightIn: 0, weightOut: 1 },
    ],
    busStops,
    busRoutes,
  });
}

// ---------------------------------------------------------------------------
// Shared geometry/topology machinery for the intersection-shaped builders
// (crossroads, tJunction, corridor). mergeRamp is simple enough to stay standalone.
// ---------------------------------------------------------------------------

type Dir = "N" | "E" | "S" | "W";
const DIRS: Dir[] = ["N", "E", "S", "W"];
/** Outward direction from a junction centre along each compass arm. */
const DIR_VEC: Record<Dir, Vec2> = { N: [0, 1], E: [1, 0], S: [0, -1], W: [-1, 0] };
/** Right-hand traffic: from an approach, the exit arm of a left/right turn (see docs/ARCHITECTURE.md). */
const NEXT_CW: Record<Dir, Dir> = { N: "E", E: "S", S: "W", W: "N" };
const PREV_CW: Record<Dir, Dir> = { N: "W", E: "N", S: "E", W: "S" };
const OPPOSITE: Record<Dir, Dir> = { N: "S", S: "N", E: "W", W: "E" };

/** Per-approach bookkeeping shared by connector generation and signal-group assembly. */
interface ArmInfo {
  dir: Dir;
  inLinkId: string;
  outLinkId: string;
  pocketLaneId: string | undefined;
  /** General through lanes, left to right, excluding the pocket and bus lane. */
  throughLaneIds: string[];
  busLaneId: string | undefined;
  /** Whichever lane the right turn originates from (bus lane if this approach has one). */
  rightmostLaneId: string;
  exitGeneralLaneIds: string[];
  exitBusLaneId: string | undefined;
  /** Direction of travel arriving at the junction (toward centre). */
  inDirVec: Vec2;
  /** Direction of travel leaving the junction (away from centre). */
  outDirVec: Vec2;
  throughConnectorIds: string[];
  busThroughConnectorId: string | undefined;
  leftConnectorId: string | undefined;
  rightConnectorId: string | undefined;
  mainGroupId: string | undefined;
  arrowGroupId: string | undefined;
  pedGroupId: string | undefined;
}

function armInfoFromLink(
  dir: Dir,
  inLinkId: string,
  inLaneIds: string[],
  outLinkId: string,
  outLaneIds: string[],
  inDirVec: Vec2,
  outDirVec: Vec2,
): ArmInfo {
  const rightmostLaneId = inLaneIds[inLaneIds.length - 1];
  if (!rightmostLaneId) throw new Error(`arm ${dir}: needs at least one lane`);
  return {
    dir,
    inLinkId,
    outLinkId,
    pocketLaneId: undefined,
    throughLaneIds: inLaneIds,
    busLaneId: undefined,
    rightmostLaneId,
    exitGeneralLaneIds: outLaneIds,
    exitBusLaneId: undefined,
    inDirVec,
    outDirVec,
    throughConnectorIds: [],
    busThroughConnectorId: undefined,
    leftConnectorId: undefined,
    rightConnectorId: undefined,
    mainGroupId: undefined,
    arrowGroupId: undefined,
    pedGroupId: undefined,
  };
}

/** The same physical arm, viewed from the node at its far end instead of its near end. */
function reverseArmInfo(dir: Dir, info: ArmInfo): ArmInfo {
  return armInfoFromLink(
    dir,
    info.outLinkId,
    info.exitGeneralLaneIds,
    info.inLinkId,
    info.throughLaneIds,
    info.outDirVec,
    info.inDirVec,
  );
}

interface LinkRegistry {
  geom: Map<string, Vec2[]>;
  order: Map<string, string[]>;
}

/** Turns for a lane with no pocket and no bus lane: ends (index 0 / last) also handle left/right. */
function simpleLaneTurns(index: number, total: number): TurnKind[] {
  const turns: TurnKind[] = ["through"];
  if (index === 0) turns.push("left");
  if (index === total - 1) turns.push("right");
  return turns;
}

function buildDirectionalLink(
  id: string,
  fromNodeId: string,
  fromPos: Vec2,
  toNodeId: string,
  toPos: Vec2,
  lanesN: number,
  highwayClass: string,
  speedLimitKph: number,
  registry: LinkRegistry,
) {
  const lengthM = vecLength(sub(toPos, fromPos));
  const laneIds: string[] = [];
  const laneDefs = [];
  for (let i = 0; i < lanesN; i++) {
    const laneId = `${id}:${i}`;
    laneDefs.push({
      id: laneId,
      linkId: id,
      index: i,
      startS: 0,
      endS: lengthM,
      kind: "general",
      allowed: ALL,
      turns: simpleLaneTurns(i, lanesN),
    });
    laneIds.push(laneId);
  }
  const link = {
    id,
    fromNodeId,
    toNodeId,
    highwayClass,
    geometry: [fromPos, toPos],
    lengthM,
    speedLimitKph,
    laneIds,
  };
  registry.geom.set(id, [fromPos, toPos]);
  registry.order.set(id, laneIds);
  return { link, laneDefs, laneIds };
}

/** Builds one gate-terminated approach: a pair of links (in/out) plus lanes, pocket and bus lane. */
function buildApproachArm(spec: {
  centerId: string;
  center: Vec2;
  dir: Dir;
  armLengthM: number;
  lanes: number;
  /** 0 = no pocket; the leftmost through lane then also permits "left". */
  pocketM: number;
  busLane: boolean;
  idPrefix: string;
  registry: LinkRegistry;
  speedLimitKph?: number;
  highwayClass?: string;
  /** "junction" repurposes the far node as an unsignalized junction instead of a gate (corridor). */
  farNodeKind?: "gate" | "junction";
  /**
   * Half-width of the junction box: the stop line sits this far from the node centre, so connectors
   * actually cross the intersection instead of degenerating into stubs at a single point (T-11).
   * `armLengthM` stays the gate-to-stop-line distance, so the gate simply moves further out.
   */
  junctionRadiusM?: number;
  /**
   * Splits the exit into a stub of this length plus a tail, with an all-but-permanently red signal
   * between them, so that the exit fills up and the queue spills back into the junction (N19).
   */
  blockedExitM?: number;
}) {
  const { centerId, center, dir, armLengthM, lanes, pocketM, busLane, idPrefix, registry } = spec;
  const speedLimitKph = spec.speedLimitKph ?? 50;
  const highwayClass = spec.highwayClass ?? "secondary";
  const farNodeKind = spec.farNodeKind ?? "gate";
  const junctionRadiusM = spec.junctionRadiusM ?? 0;
  const blockedExitM = spec.blockedExitM ?? 0;

  const stopPos = add(center, scale(DIR_VEC[dir], junctionRadiusM));
  const gatePos = add(center, scale(DIR_VEC[dir], armLengthM + junctionRadiusM));
  const gateId = `${idPrefix}.gate`;
  const inLinkId = `${idPrefix}.in`;
  const outLinkId = `${idPrefix}.out`;
  const inDirVec = normalize(sub(center, gatePos));
  const outDirVec = normalize(sub(gatePos, center));

  const inLaneDefs = [];
  const inLaneIds: string[] = [];
  let idx = 0;
  let pocketLaneId: string | undefined;
  if (pocketM > 0) {
    pocketLaneId = `${inLinkId}:${idx}`;
    inLaneDefs.push({
      id: pocketLaneId,
      linkId: inLinkId,
      index: idx,
      startS: armLengthM - pocketM,
      endS: armLengthM,
      kind: "turn_pocket",
      allowed: ALL,
      turns: ["left"],
    });
    inLaneIds.push(pocketLaneId);
    idx++;
  }
  const throughLaneIds: string[] = [];
  for (let i = 0; i < lanes; i++) {
    const id = `${inLinkId}:${idx}`;
    const turns: TurnKind[] = ["through"];
    if (i === 0 && !pocketLaneId) turns.push("left");
    if (i === lanes - 1 && !busLane) turns.push("right");
    inLaneDefs.push({
      id,
      linkId: inLinkId,
      index: idx,
      startS: 0,
      endS: armLengthM,
      kind: "general",
      allowed: ALL,
      turns,
    });
    inLaneIds.push(id);
    throughLaneIds.push(id);
    idx++;
  }
  let busLaneId: string | undefined;
  if (busLane) {
    busLaneId = `${inLinkId}:${idx}`;
    inLaneDefs.push({
      id: busLaneId,
      linkId: inLinkId,
      index: idx,
      startS: 0,
      endS: armLengthM,
      kind: "bus",
      allowed: PT,
      turns: ["through", "right"],
      busLane: { allowed: PT },
    });
    inLaneIds.push(busLaneId);
    idx++;
  }
  const lastThrough = throughLaneIds[throughLaneIds.length - 1];
  if (!lastThrough) throw new Error(`arm ${idPrefix}: needs at least one through lane`);
  const rightmostLaneId = busLaneId ?? lastThrough;

  // Exit lanes only ever appear as a connector's `toLaneId` within this same arm's own network,
  // so `turns` is unused here -- except corridor's parallelStreet, which reverses an arm's exit
  // lanes into the residential T-junction's approach lanes. Give them the same "no pocket" turns
  // a plain approach lane would have so that reversal stays valid without special-casing it.
  // `blockedExitM` splits the exit into a short stub plus a tail, with an all-but-permanently red
  // signal in between: the stub fills up and the queue spills back into the junction box (N19).
  const outStubM = blockedExitM > 0 ? Math.min(blockedExitM, armLengthM / 2) : armLengthM;
  const tailLinkId = `${idPrefix}.tail`;
  const exitLanesOf = (linkId: string, lengthM: number) => {
    const defs = [];
    const ids: string[] = [];
    const generalIds: string[] = [];
    for (let i = 0; i < lanes; i++) {
      const id = `${linkId}:${i}`;
      defs.push({
        id,
        linkId,
        index: i,
        startS: 0,
        endS: lengthM,
        kind: "general",
        allowed: ALL,
        turns: simpleLaneTurns(i, lanes),
      });
      ids.push(id);
      generalIds.push(id);
    }
    let busId: string | undefined;
    if (busLane) {
      busId = `${linkId}:${lanes}`;
      defs.push({
        id: busId,
        linkId,
        index: lanes,
        startS: 0,
        endS: lengthM,
        kind: "bus",
        allowed: PT,
        turns: ["through"],
        busLane: { allowed: PT },
      });
      ids.push(busId);
    }
    return { defs, ids, generalIds, busId };
  };
  const out = exitLanesOf(outLinkId, outStubM);
  const outLaneDefs = out.defs;
  const outLaneIds = out.ids;
  const exitGeneralLaneIds = out.generalIds;
  const exitBusLaneId = out.busId;
  const tail = blockedExitM > 0 ? exitLanesOf(tailLinkId, armLengthM - outStubM) : undefined;

  // With a junction box the two carriageways are also pulled apart: each keeps to the right of the
  // arm axis by half its own width. Without this the opposing directions would sit on exactly the
  // same lane centrelines and no left turn would ever cross an opposing through movement.
  const inShift =
    junctionRadiusM > 0
      ? scale(rightOf(inDirVec), (inLaneIds.length * LANE_WIDTH_M) / 2)
      : ([0, 0] as Vec2);
  const outShift =
    junctionRadiusM > 0
      ? scale(rightOf(outDirVec), (outLaneIds.length * LANE_WIDTH_M) / 2)
      : ([0, 0] as Vec2);
  const inGeometry: Vec2[] = [add(gatePos, inShift), add(stopPos, inShift)];
  const blockPos = add(center, scale(DIR_VEC[dir], junctionRadiusM + outStubM));
  const outEnd = tail ? add(blockPos, outShift) : add(gatePos, outShift);
  const outGeometry: Vec2[] = [add(stopPos, outShift), outEnd];
  const tailGeometry: Vec2[] = [outEnd, add(gatePos, outShift)];

  registry.geom.set(inLinkId, inGeometry);
  registry.order.set(inLinkId, inLaneIds);
  registry.geom.set(outLinkId, outGeometry);
  registry.order.set(outLinkId, outLaneIds);
  if (tail) {
    registry.geom.set(tailLinkId, tailGeometry);
    registry.order.set(tailLinkId, tail.ids);
  }

  const info: ArmInfo = {
    dir,
    inLinkId,
    outLinkId,
    pocketLaneId,
    throughLaneIds,
    busLaneId,
    rightmostLaneId,
    exitGeneralLaneIds,
    exitBusLaneId,
    inDirVec,
    outDirVec,
    throughConnectorIds: [],
    busThroughConnectorId: undefined,
    leftConnectorId: undefined,
    rightConnectorId: undefined,
    mainGroupId: undefined,
    arrowGroupId: undefined,
    pedGroupId: undefined,
  };

  const blockNodeId = `${idPrefix}.block`;
  const nodes: unknown[] = [{ id: gateId, x: gatePos[0], y: gatePos[1], kind: farNodeKind }];
  const armLinks: unknown[] = [
    {
      id: inLinkId,
      fromNodeId: gateId,
      toNodeId: centerId,
      highwayClass,
      geometry: inGeometry,
      lengthM: armLengthM,
      speedLimitKph,
      laneIds: inLaneIds,
    },
    {
      id: outLinkId,
      fromNodeId: centerId,
      toNodeId: tail ? blockNodeId : gateId,
      highwayClass,
      geometry: outGeometry,
      lengthM: outStubM,
      speedLimitKph,
      laneIds: outLaneIds,
    },
  ];
  const armLanes: unknown[] = [...inLaneDefs, ...outLaneDefs];
  const armConnectors: RawConnector[] = [];
  const armControllers: unknown[] = [];
  if (tail) {
    nodes.push({ id: blockNodeId, x: blockPos[0], y: blockPos[1], kind: "signalized" });
    armLinks.push({
      id: tailLinkId,
      fromNodeId: blockNodeId,
      toNodeId: gateId,
      highwayClass,
      geometry: tailGeometry,
      lengthM: armLengthM - outStubM,
      speedLimitKph,
      laneIds: tail.ids,
    });
    armLanes.push(...tail.defs);
    const groupId = `sg.${idPrefix}.block`;
    for (let i = 0; i < outLaneIds.length; i++) {
      const fromLaneId = outLaneIds[i] as string;
      const toLaneId = tail.ids[i] as string;
      const c = makeConnector(
        registry,
        fromLaneId,
        outLinkId,
        outDirVec,
        toLaneId,
        tailLinkId,
        outDirVec,
        blockNodeId,
        "through",
        "protected",
      );
      c.signalGroupId = groupId;
      armConnectors.push(c);
    }
    armControllers.push(
      signalController({
        id: `ctrl.${idPrefix}.block`,
        nodeId: blockNodeId,
        groups: [
          signalGroup({
            id: groupId,
            kind: "vehicle",
            section: "main",
            approachLinkId: outLinkId,
            connectorIds: armConnectors.map((c) => c.id),
          }),
        ],
        // One green second per ten minutes: red for every practical purpose, but still a legal plan
        // (checkNetworkIntegrity rejects a group that is never green).
        phases: [
          signalPhase({
            id: `ph.${idPrefix}.block`,
            greenGroupIds: [groupId],
            greenS: 1,
            yellowS: 0,
            allRedS: 600,
          }),
        ],
      }),
    );
  }

  return {
    nodes,
    links: armLinks,
    lanes: armLanes,
    connectors: armConnectors,
    controllers: armControllers,
    gate:
      farNodeKind === "gate"
        ? {
            id: `${idPrefix}.g`,
            nodeId: gateId,
            inLinkIds: [inLinkId],
            outLinkIds: [tail ? tailLinkId : outLinkId],
            weightIn: 1,
            weightOut: 1,
          }
        : undefined,
    info,
  };
}

interface RawConflict {
  otherConnectorId: string;
  sThisM: number;
  sOtherM: number;
  priority: "this" | "other" | "signal";
}

interface RawConnector {
  id: string;
  fromLaneId: string;
  toLaneId: string;
  viaNodeId: string;
  turn: TurnKind;
  geometry: Vec2[];
  lengthM: number;
  protection: Protection;
  signalGroupId: string | undefined;
  conflicts: RawConflict[];
  crosswalkIds: string[];
}

function laneEndOnLink(
  registry: LinkRegistry,
  linkId: string,
  laneId: string,
  atEnd: boolean,
): Vec2 {
  const geom = registry.geom.get(linkId);
  const order = registry.order.get(linkId);
  if (!geom || !order) throw new Error(`synthetic network: unknown link ${linkId}`);
  const idx = order.indexOf(laneId);
  if (idx < 0)
    throw new Error(`synthetic network: lane ${laneId} not registered on link ${linkId}`);
  return laneEndpoint(geom, idx, order.length, atEnd);
}

function makeConnector(
  registry: LinkRegistry,
  fromLaneId: string,
  fromLinkId: string,
  fromTangent: Vec2,
  toLaneId: string,
  toLinkId: string,
  toTangent: Vec2,
  viaNodeId: string,
  turn: TurnKind,
  protection: Protection,
): RawConnector {
  const p0 = laneEndOnLink(registry, fromLinkId, fromLaneId, true);
  const p3 = laneEndOnLink(registry, toLinkId, toLaneId, false);
  const geometry = cubicBezierPolyline(p0, fromTangent, p3, toTangent, 8);
  return {
    id: `${fromLaneId}>${toLaneId}`,
    fromLaneId,
    toLaneId,
    viaNodeId,
    turn,
    geometry,
    lengthM: polylineLen(geometry),
    protection,
    signalGroupId: undefined,
    conflicts: [],
    crosswalkIds: [],
  };
}

/**
 * Generates through/left/right connectors for every present arm of an intersection (3 arms for
 * tJunction, 4 for crossroads/corridor). A turn whose exit arm is absent (e.g. the minor road of a
 * T-junction has no through movement) is simply skipped.
 */
function buildMovementConnectors(
  arms: Partial<Record<Dir, ArmInfo>>,
  registry: LinkRegistry,
  viaNodeId: string,
  includeLeft: boolean,
  protectionFor: (dir: Dir, turn: "through" | "left" | "right") => Protection,
): {
  connectors: RawConnector[];
  approachLinkOf: Map<string, string>;
  exitArmConnectors: Partial<Record<Dir, string[]>>;
} {
  const connectors: RawConnector[] = [];
  const approachLinkOf = new Map<string, string>();
  const exitArmConnectors: Partial<Record<Dir, string[]>> = {};
  const pushExit = (dir: Dir, id: string) => {
    const list = exitArmConnectors[dir];
    if (list) list.push(id);
    else exitArmConnectors[dir] = [id];
  };

  for (const dir of Object.keys(arms) as Dir[]) {
    const a = arms[dir];
    if (!a) continue;

    const oppDir = OPPOSITE[dir];
    const opp = arms[oppDir];
    if (opp) {
      a.throughLaneIds.forEach((fromLaneId, i) => {
        const toLaneId = opp.exitGeneralLaneIds[i];
        if (!toLaneId) return;
        const c = makeConnector(
          registry,
          fromLaneId,
          a.inLinkId,
          a.inDirVec,
          toLaneId,
          opp.outLinkId,
          opp.outDirVec,
          viaNodeId,
          "through",
          protectionFor(dir, "through"),
        );
        a.throughConnectorIds.push(c.id);
        approachLinkOf.set(c.id, a.inLinkId);
        pushExit(oppDir, c.id);
        connectors.push(c);
      });
      if (a.busLaneId && opp.exitBusLaneId) {
        const c = makeConnector(
          registry,
          a.busLaneId,
          a.inLinkId,
          a.inDirVec,
          opp.exitBusLaneId,
          opp.outLinkId,
          opp.outDirVec,
          viaNodeId,
          "through",
          protectionFor(dir, "through"),
        );
        a.busThroughConnectorId = c.id;
        approachLinkOf.set(c.id, a.inLinkId);
        pushExit(oppDir, c.id);
        connectors.push(c);
      }
    }

    if (includeLeft) {
      const leftDir = NEXT_CW[dir];
      const leftArm = arms[leftDir];
      const fromLaneId = a.pocketLaneId ?? a.throughLaneIds[0];
      if (leftArm && fromLaneId) {
        const toLaneId = leftArm.exitGeneralLaneIds[0];
        if (toLaneId) {
          const c = makeConnector(
            registry,
            fromLaneId,
            a.inLinkId,
            a.inDirVec,
            toLaneId,
            leftArm.outLinkId,
            leftArm.outDirVec,
            viaNodeId,
            "left",
            protectionFor(dir, "left"),
          );
          a.leftConnectorId = c.id;
          approachLinkOf.set(c.id, a.inLinkId);
          pushExit(leftDir, c.id);
          connectors.push(c);
        }
      }
    }

    const rightDir = PREV_CW[dir];
    const rightArm = arms[rightDir];
    if (rightArm) {
      const toLaneId = rightArm.exitGeneralLaneIds[rightArm.exitGeneralLaneIds.length - 1];
      if (toLaneId) {
        const c = makeConnector(
          registry,
          a.rightmostLaneId,
          a.inLinkId,
          a.inDirVec,
          toLaneId,
          rightArm.outLinkId,
          rightArm.outDirVec,
          viaNodeId,
          "right",
          protectionFor(dir, "right"),
        );
        a.rightConnectorId = c.id;
        approachLinkOf.set(c.id, a.inLinkId);
        pushExit(rightDir, c.id);
        connectors.push(c);
      }
    }
  }

  return { connectors, approachLinkOf, exitArmConnectors };
}

/**
 * Geometric conflict points between connectors of different approaches (docs/tasks/T-03): two
 * connectors from the same approach never conflict. `resolve` decides right-of-way; for a
 * signalized node it should just return "signal".
 */
function computeConflicts(
  connectors: RawConnector[],
  approachOf: (c: RawConnector) => string,
  resolve: (a: RawConnector, b: RawConnector) => "this" | "other" | "signal",
): void {
  for (let i = 0; i < connectors.length; i++) {
    const a = connectors[i];
    if (!a) continue;
    for (let j = i + 1; j < connectors.length; j++) {
      const b = connectors[j];
      if (!b) continue;
      if (approachOf(a) === approachOf(b)) continue;
      const hit = firstCrossing(a.geometry, b.geometry);
      if (!hit) continue;
      const verdict = resolve(a, b);
      const mirrored = verdict === "this" ? "other" : verdict === "other" ? "this" : "signal";
      a.conflicts.push({
        otherConnectorId: b.id,
        sThisM: hit.sA,
        sOtherM: hit.sB,
        priority: verdict,
      });
      b.conflicts.push({
        otherConnectorId: a.id,
        sThisM: hit.sB,
        sOtherM: hit.sA,
        priority: mirrored,
      });
    }
  }
}

/** Standard unsignalized right-of-way: main-road connectors beat the named minor approach; among
 * main-road movements, an opposing through beats a left turn; anything else is a deterministic
 * (but otherwise arbitrary) tie-break so every detected crossing gets a consistent verdict. */
function priorityVsMinor(
  approachLinkOf: Map<string, string>,
  minorInLinkId: string,
): (a: RawConnector, b: RawConnector) => "this" | "other" {
  return (a, b) => {
    const aMinor = approachLinkOf.get(a.id) === minorInLinkId;
    const bMinor = approachLinkOf.get(b.id) === minorInLinkId;
    if (aMinor && !bMinor) return "other";
    if (bMinor && !aMinor) return "this";
    if (a.turn === "through" && b.turn === "left") return "this";
    if (b.turn === "through" && a.turn === "left") return "other";
    return a.id < b.id ? "this" : "other";
  };
}

// ---------------------------------------------------------------------------
// crossroads
// ---------------------------------------------------------------------------

export interface CrossroadsOptions {
  /** Approach length from gate to stop line, per arm. */
  armLengthM?: number;
  /** General through lanes per approach. */
  lanes?: number;
  /** Left-turn pocket length per approach; 0 = no pocket (left turns share the leftmost through lane). */
  leftPocketM?: number;
  leftTurnMode?: "protected" | "permissive" | "protected_permissive" | "prohibited";
  /** Bus lane on the east-west street. */
  busLaneEW?: boolean;
  /** Pedestrian crosswalks on all arms with a pedestrian phase. */
  crosswalks?: boolean;
  /** Fixed-time plan. When omitted the builder emits a simple 2-phase plan (NS / EW) plus arrows if protected. */
  cycleS?: number;
  greenSplitNS?: number;
  /**
   * Chokes the exit of one arm: its outbound link becomes a stub of `blockedExitM` metres ending at
   * an all-but-permanently red signal, so the queue spills back into the junction box (N19).
   */
  blockedExit?: { dir: "N" | "E" | "S" | "W"; lengthM?: number };
}

/** Four-arm signalized intersection with gates at each arm end. The workhorse fixture. T-03. */
export function crossroads(opts: CrossroadsOptions = {}): Network {
  const armLengthM = opts.armLengthM ?? 300;
  const lanesN = opts.lanes ?? 2;
  const leftPocketM = opts.leftPocketM ?? 60;
  const leftTurnMode = opts.leftTurnMode ?? "permissive";
  const busLaneEW = opts.busLaneEW ?? false;
  const crosswalksOn = opts.crosswalks ?? false;
  const cycleS = opts.cycleS ?? 90;
  const greenSplitNS = opts.greenSplitNS ?? 0.5;
  const blockedExit = opts.blockedExit;

  const centerId = "center";
  const center: Vec2 = [0, 0];
  const registry: LinkRegistry = { geom: new Map(), order: new Map() };

  const nodes: unknown[] = [{ id: centerId, x: 0, y: 0, kind: "signalized" }];
  const links: unknown[] = [];
  const lanes: unknown[] = [];
  const gates: unknown[] = [];
  const exitConnectors: RawConnector[] = [];
  const exitControllers: unknown[] = [];
  const arms: Partial<Record<Dir, ArmInfo>> = {};

  // Half-width of the junction box: the crossing street is `lanesN` lanes per direction plus a
  // pocket or bus lane, so the stop lines sit this far from the centre and the connectors really
  // cross each other inside the box (see buildApproachArm.junctionRadiusM).
  const junctionRadiusM = (lanesN + 1) * LANE_WIDTH_M;

  for (const dir of DIRS) {
    const isEW = dir === "E" || dir === "W";
    const arm = buildApproachArm({
      centerId,
      center,
      dir,
      armLengthM,
      lanes: lanesN,
      pocketM: leftPocketM,
      busLane: busLaneEW && isEW,
      idPrefix: dir,
      registry,
      junctionRadiusM,
      blockedExitM: blockedExit?.dir === dir ? (blockedExit.lengthM ?? 60) : 0,
    });
    nodes.push(...arm.nodes);
    links.push(...arm.links);
    lanes.push(...arm.lanes);
    if (arm.gate) gates.push(arm.gate);
    exitControllers.push(...arm.controllers);
    exitConnectors.push(...arm.connectors);
    arms[dir] = arm.info;
  }

  const includeLeft = leftTurnMode !== "prohibited";
  const protectionFor = (_dir: Dir, turn: "through" | "left" | "right"): Protection => {
    if (turn !== "left") return "protected";
    return leftTurnMode === "protected" ? "protected" : "permissive";
  };

  const { connectors, approachLinkOf, exitArmConnectors } = buildMovementConnectors(
    arms,
    registry,
    centerId,
    includeLeft,
    protectionFor,
  );
  computeConflicts(
    connectors,
    (c) => approachLinkOf.get(c.id) ?? "",
    () => "signal",
  );

  const groups: ReturnType<typeof signalGroup>[] = [];
  const leftTurnModes: Record<string, LeftTurnMode> = {};
  const connectorById = new Map(connectors.map((c) => [c.id, c]));
  const withArrows = leftTurnMode === "protected" || leftTurnMode === "protected_permissive";

  for (const dir of DIRS) {
    const a = arms[dir];
    if (!a) continue;
    leftTurnModes[a.inLinkId] = leftTurnMode;

    const mainIds = [...a.throughConnectorIds];
    if (a.busThroughConnectorId) mainIds.push(a.busThroughConnectorId);
    if (a.rightConnectorId) mainIds.push(a.rightConnectorId);
    if (includeLeft && leftTurnMode === "permissive" && a.leftConnectorId)
      mainIds.push(a.leftConnectorId);

    const mainGroupId = `sg.${dir}.main`;
    for (const cid of mainIds) {
      const c = connectorById.get(cid);
      if (c) c.signalGroupId = mainGroupId;
    }
    groups.push(
      signalGroup({
        id: mainGroupId,
        kind: "vehicle",
        section: "main",
        approachLinkId: a.inLinkId,
        connectorIds: mainIds,
      }),
    );
    a.mainGroupId = mainGroupId;

    if (withArrows && a.leftConnectorId) {
      const arrowGroupId = `sg.${dir}.arrow`;
      const c = connectorById.get(a.leftConnectorId);
      if (c) c.signalGroupId = arrowGroupId;
      groups.push(
        signalGroup({
          id: arrowGroupId,
          kind: "vehicle",
          section: "arrow_left",
          approachLinkId: a.inLinkId,
          connectorIds: [a.leftConnectorId],
        }),
      );
      a.arrowGroupId = arrowGroupId;
    }

    if (crosswalksOn) {
      const pedGroupId = `sg.${dir}.ped`;
      groups.push(signalGroup({ id: pedGroupId, kind: "pedestrian", crosswalkIds: [`cw.${dir}`] }));
      a.pedGroupId = pedGroupId;
    }
  }

  function axisGreens(axis: Dir[], oppositeAxis: Dir[]): string[] {
    const ids: string[] = [];
    for (const dir of axis) {
      const a = arms[dir];
      if (!a?.mainGroupId) continue;
      ids.push(a.mainGroupId);
      if (leftTurnMode === "protected_permissive" && a.arrowGroupId) ids.push(a.arrowGroupId);
    }
    if (crosswalksOn) {
      for (const dir of oppositeAxis) {
        const pedId = arms[dir]?.pedGroupId;
        if (pedId) ids.push(pedId);
      }
    }
    return ids;
  }

  const phases: ReturnType<typeof signalPhase>[] = [];
  if (withArrows) {
    const leadIds = (["N", "S"] as Dir[])
      .map((d) => arms[d]?.arrowGroupId)
      .filter((x): x is string => x !== undefined);
    if (leadIds.length > 0)
      phases.push(signalPhase({ id: "ph.ns.lead", greenGroupIds: leadIds, greenS: 12 }));
  }
  phases.push(
    signalPhase({
      id: "ph.ns",
      greenGroupIds: axisGreens(["N", "S"], ["E", "W"]),
      greenS: cycleS * greenSplitNS,
    }),
  );
  if (withArrows) {
    const leadIds = (["E", "W"] as Dir[])
      .map((d) => arms[d]?.arrowGroupId)
      .filter((x): x is string => x !== undefined);
    if (leadIds.length > 0)
      phases.push(signalPhase({ id: "ph.ew.lead", greenGroupIds: leadIds, greenS: 12 }));
  }
  phases.push(
    signalPhase({
      id: "ph.ew",
      greenGroupIds: axisGreens(["E", "W"], ["N", "S"]),
      greenS: cycleS * (1 - greenSplitNS),
    }),
  );

  const crosswalks: unknown[] = [];
  if (crosswalksOn) {
    for (const dir of DIRS) {
      const a = arms[dir];
      if (!a) continue;
      const crossPos = add(center, scale(DIR_VEC[dir], 8));
      const perp = leftOf(DIR_VEC[dir]);
      const halfW = (lanesN + 1) * LANE_WIDTH_M;
      const p0: Vec2 = sub(crossPos, scale(perp, halfW));
      const p1: Vec2 = add(crossPos, scale(perp, halfW));
      const cwId = `cw.${dir}`;
      const connectorIds = exitArmConnectors[dir] ?? [];
      for (const cid of connectorIds) {
        const c = connectorById.get(cid);
        if (c) c.crosswalkIds.push(cwId);
      }
      crosswalks.push({
        id: cwId,
        nodeId: centerId,
        geometry: [p0, p1],
        lengthM: vecLength(sub(p1, p0)),
        connectorIds,
        signalGroupId: a.pedGroupId,
      });
    }
  }

  const controller = signalController({
    id: "ctrl0",
    nodeId: centerId,
    groups,
    phases,
    leftTurnModes,
  });

  return finish({
    meta: meta("crossroads"),
    nodes,
    links,
    lanes,
    connectors: [...connectors, ...exitConnectors],
    crosswalks,
    signalControllers: [controller, ...exitControllers],
    gates,
  });
}

// ---------------------------------------------------------------------------
// tJunction
// ---------------------------------------------------------------------------

export interface TJunctionOptions {
  armLengthM?: number;
  lanes?: number;
  /** Unsignalized: minor road yields. Signalized: 2-phase plan. */
  signalized?: boolean;
}

/** Main road with a minor road joining from the south. T-03. */
export function tJunction(opts: TJunctionOptions = {}): Network {
  const armLengthM = opts.armLengthM ?? 300;
  const lanesN = opts.lanes ?? 2;
  const signalized = opts.signalized ?? false;

  const centerId = "center";
  const center: Vec2 = [0, 0];
  const registry: LinkRegistry = { geom: new Map(), order: new Map() };

  const nodes: unknown[] = [
    { id: centerId, x: 0, y: 0, kind: signalized ? "signalized" : "junction" },
  ];
  const links: unknown[] = [];
  const lanes: unknown[] = [];
  const gates: unknown[] = [];
  const arms: Partial<Record<Dir, ArmInfo>> = {};

  for (const dir of ["E", "W", "S"] as Dir[]) {
    const arm = buildApproachArm({
      centerId,
      center,
      dir,
      armLengthM,
      lanes: lanesN,
      pocketM: 0,
      busLane: false,
      idPrefix: dir,
      registry,
      junctionRadiusM: (lanesN + 1) * LANE_WIDTH_M,
    });
    nodes.push(...arm.nodes);
    links.push(...arm.links);
    lanes.push(...arm.lanes);
    if (arm.gate) gates.push(arm.gate);
    arms[dir] = arm.info;
  }

  const protectionFor = (dir: Dir): Protection => {
    if (signalized) return "protected";
    return dir === "S" ? "yield" : "priority";
  };

  const { connectors, approachLinkOf } = buildMovementConnectors(
    arms,
    registry,
    centerId,
    true,
    protectionFor,
  );

  const minorInLinkId = (arms.S as ArmInfo).inLinkId;
  computeConflicts(
    connectors,
    (c) => approachLinkOf.get(c.id) ?? "",
    signalized ? () => "signal" : priorityVsMinor(approachLinkOf, minorInLinkId),
  );

  let controllers: unknown[] = [];
  if (signalized) {
    const groups: ReturnType<typeof signalGroup>[] = [];
    const leftTurnModes: Record<string, LeftTurnMode> = {};
    const connectorById = new Map(connectors.map((c) => [c.id, c]));
    for (const dir of ["E", "W", "S"] as Dir[]) {
      const a = arms[dir];
      if (!a) continue;
      leftTurnModes[a.inLinkId] = "permissive";
      const mainIds = [...a.throughConnectorIds];
      if (a.rightConnectorId) mainIds.push(a.rightConnectorId);
      if (a.leftConnectorId) mainIds.push(a.leftConnectorId);
      const mainGroupId = `sg.${dir}.main`;
      for (const cid of mainIds) {
        const c = connectorById.get(cid);
        if (c) c.signalGroupId = mainGroupId;
      }
      groups.push(
        signalGroup({
          id: mainGroupId,
          kind: "vehicle",
          section: "main",
          approachLinkId: a.inLinkId,
          connectorIds: mainIds,
        }),
      );
      a.mainGroupId = mainGroupId;
    }
    const ewIds = (["E", "W"] as Dir[])
      .map((d) => arms[d]?.mainGroupId)
      .filter((x): x is string => x !== undefined);
    const sIds = arms.S?.mainGroupId ? [arms.S.mainGroupId] : [];
    const phases = [
      signalPhase({ id: "ph.ew", greenGroupIds: ewIds, greenS: 45 }),
      signalPhase({ id: "ph.s", greenGroupIds: sIds, greenS: 20 }),
    ];
    controllers = [
      signalController({ id: "ctrl0", nodeId: centerId, groups, phases, leftTurnModes }),
    ];
  }

  return finish({
    meta: meta("t-junction"),
    nodes,
    links,
    lanes,
    connectors,
    signalControllers: controllers,
    gates,
  });
}

// ---------------------------------------------------------------------------
// mergeRamp
// ---------------------------------------------------------------------------

export interface MergeRampOptions {
  mainLanes?: number;
  mainLengthM?: number;
  /** Length of the acceleration lane after the merge node; 0 = ramp ends at the node (yield). */
  accelLaneM?: number;
}

const MERGE_AT_M = 500;
const RAMP_LENGTH_M = 180;
const RAMP_ANGLE_DEG = 20;

/** Trunk road with a ramp joining at a merge node (Al-Farabi style). T-03. */
export function mergeRamp(opts: MergeRampOptions = {}): Network {
  const mainLanes = opts.mainLanes ?? 2;
  const mainLengthM = opts.mainLengthM ?? 1500;
  const accelLaneM = opts.accelLaneM ?? 0;
  const afterLengthM = mainLengthM - MERGE_AT_M;

  const westGatePos: Vec2 = [0, 0];
  const mergePos: Vec2 = [MERGE_AT_M, 0];
  const eastGatePos: Vec2 = [mainLengthM, 0];
  const rampHeading = fromAngleDeg(RAMP_ANGLE_DEG);
  const rampGatePos = sub(mergePos, scale(rampHeading, RAMP_LENGTH_M));

  const nodes = [
    { id: "gate.w", x: westGatePos[0], y: westGatePos[1], kind: "gate" },
    { id: "merge", x: mergePos[0], y: mergePos[1], kind: "merge" },
    { id: "gate.e", x: eastGatePos[0], y: eastGatePos[1], kind: "gate" },
    { id: "gate.ramp", x: rampGatePos[0], y: rampGatePos[1], kind: "gate" },
  ];

  const registry: LinkRegistry = { geom: new Map(), order: new Map() };
  const lanes = [];

  const beforeLaneIds: string[] = [];
  for (let i = 0; i < mainLanes; i++) {
    const id = `main.before:${i}`;
    lanes.push({
      id,
      linkId: "main.before",
      index: i,
      startS: 0,
      endS: MERGE_AT_M,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    });
    beforeLaneIds.push(id);
  }
  const links = [
    {
      id: "main.before",
      fromNodeId: "gate.w",
      toNodeId: "merge",
      highwayClass: "trunk",
      geometry: [westGatePos, mergePos],
      lengthM: MERGE_AT_M,
      speedLimitKph: 80,
      laneIds: beforeLaneIds,
    },
  ];
  registry.geom.set("main.before", [westGatePos, mergePos]);
  registry.order.set("main.before", beforeLaneIds);

  const afterLaneIds: string[] = [];
  for (let i = 0; i < mainLanes; i++) {
    const id = `main.after:${i}`;
    lanes.push({
      id,
      linkId: "main.after",
      index: i,
      startS: 0,
      endS: afterLengthM,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    });
    afterLaneIds.push(id);
  }
  let accelLaneId: string | undefined;
  if (accelLaneM > 0) {
    accelLaneId = `main.after:${mainLanes}`;
    lanes.push({
      id: accelLaneId,
      linkId: "main.after",
      index: mainLanes,
      startS: 0,
      endS: accelLaneM,
      kind: "general",
      allowed: ALL,
      turns: ["merge"],
    });
    afterLaneIds.push(accelLaneId);
  }
  links.push({
    id: "main.after",
    fromNodeId: "merge",
    toNodeId: "gate.e",
    highwayClass: "trunk",
    geometry: [mergePos, eastGatePos],
    lengthM: afterLengthM,
    speedLimitKph: 80,
    laneIds: afterLaneIds,
  });
  registry.geom.set("main.after", [mergePos, eastGatePos]);
  registry.order.set("main.after", afterLaneIds);

  const rampLaneId = "ramp:0";
  lanes.push({
    id: rampLaneId,
    linkId: "ramp",
    index: 0,
    startS: 0,
    endS: RAMP_LENGTH_M,
    kind: "general",
    allowed: ALL,
    turns: ["merge"],
  });
  links.push({
    id: "ramp",
    fromNodeId: "gate.ramp",
    toNodeId: "merge",
    highwayClass: "secondary_link",
    geometry: [rampGatePos, mergePos],
    lengthM: RAMP_LENGTH_M,
    speedLimitKph: 40,
    laneIds: [rampLaneId],
  });
  registry.geom.set("ramp", [rampGatePos, mergePos]);
  registry.order.set("ramp", [rampLaneId]);

  const mainAxis: Vec2 = [1, 0];
  const connectors: RawConnector[] = [];
  const mainThroughIds: string[] = [];
  for (let i = 0; i < mainLanes; i++) {
    const fromLaneId = beforeLaneIds[i];
    const toLaneId = afterLaneIds[i];
    if (!fromLaneId || !toLaneId) continue;
    const c = makeConnector(
      registry,
      fromLaneId,
      "main.before",
      mainAxis,
      toLaneId,
      "main.after",
      mainAxis,
      "merge",
      "through",
      "priority",
    );
    connectors.push(c);
    mainThroughIds.push(c.id);
  }

  const mergeTargetLaneId = accelLaneId ?? (afterLaneIds[mainLanes - 1] as string);
  const mergeConnector = makeConnector(
    registry,
    rampLaneId,
    "ramp",
    rampHeading,
    mergeTargetLaneId,
    "main.after",
    mainAxis,
    "merge",
    "merge",
    "yield",
  );
  connectors.push(mergeConnector);

  // The ramp and the rightmost main-line lane converge at the merge node rather than crossing
  // deeper in the network, so their bezier curves meet only at the shared endpoint (see geometry.ts
  // firstCrossing, which deliberately excludes endpoint touches): the conflict sits right there.
  const rightmostThroughId = mainThroughIds[mainThroughIds.length - 1];
  const rightmostThrough = connectors.find((c) => c.id === rightmostThroughId);
  if (rightmostThrough) {
    mergeConnector.conflicts.push({
      otherConnectorId: rightmostThrough.id,
      sThisM: mergeConnector.lengthM,
      sOtherM: 0,
      priority: "other",
    });
    rightmostThrough.conflicts.push({
      otherConnectorId: mergeConnector.id,
      sThisM: 0,
      sOtherM: mergeConnector.lengthM,
      priority: "this",
    });
  }

  const gates = [
    {
      id: "g.w",
      nodeId: "gate.w",
      inLinkIds: ["main.before"],
      outLinkIds: [],
      weightIn: 1,
      weightOut: 0,
    },
    {
      id: "g.e",
      nodeId: "gate.e",
      inLinkIds: [],
      outLinkIds: ["main.after"],
      weightIn: 0,
      weightOut: 1,
    },
    {
      id: "g.ramp",
      nodeId: "gate.ramp",
      inLinkIds: ["ramp"],
      outLinkIds: [],
      weightIn: 1,
      weightOut: 0,
    },
  ];

  return finish({
    meta: meta("merge-ramp"),
    nodes,
    links,
    lanes,
    connectors,
    gates,
  });
}

// ---------------------------------------------------------------------------
// corridor
// ---------------------------------------------------------------------------

export interface CorridorOptions {
  intersections?: number;
  spacingM?: number;
  lanes?: number;
  /** Offsets for green wave; omitted = all zero. */
  offsetsS?: number[];
  /** Parallel residential street one block away (for navigator re-routing tests). */
  parallelStreet?: boolean;
}

const CROSS_ARM_M = 100;
const PARALLEL_OFFSET_M = 200;
const PARALLEL_GATE_MARGIN_M = 150;

/** Arterial with N signalized crossroads in a row. T-03. */
export function corridor(opts: CorridorOptions = {}): Network {
  const intersections = opts.intersections ?? 4;
  const spacingM = opts.spacingM ?? 400;
  const lanesN = opts.lanes ?? 2;
  const offsetsS = opts.offsetsS ?? [];
  const parallelStreet = opts.parallelStreet ?? false;

  const registry: LinkRegistry = { geom: new Map(), order: new Map() };
  const nodes: unknown[] = [];
  const links: unknown[] = [];
  const lanes: unknown[] = [];
  const gates: unknown[] = [];
  const connectors: RawConnector[] = [];
  const controllers: unknown[] = [];

  const centerIds: string[] = [];
  const centerPos: Vec2[] = [];
  for (let i = 0; i < intersections; i++) {
    const id = `j${i}`;
    centerIds.push(id);
    centerPos.push([i * spacingM, 0]);
    nodes.push({ id, x: i * spacingM, y: 0, kind: "signalized" });
  }

  const armsPerNode: Partial<Record<Dir, ArmInfo>>[] = centerIds.map(() => ({}));
  const resArmsPerJunction: Partial<Record<Dir, ArmInfo>>[] = centerIds.map(() => ({}));

  // West end and east end: real gates.
  {
    const arm = buildApproachArm({
      centerId: centerIds[0] as string,
      center: centerPos[0] as Vec2,
      dir: "W",
      armLengthM: spacingM,
      lanes: lanesN,
      pocketM: 0,
      busLane: false,
      idPrefix: "corridor.W",
      registry,
    });
    nodes.push(...arm.nodes);
    links.push(...arm.links);
    lanes.push(...arm.lanes);
    if (arm.gate) gates.push(arm.gate);
    (armsPerNode[0] as Partial<Record<Dir, ArmInfo>>).W = arm.info;
  }
  {
    const last = intersections - 1;
    const arm = buildApproachArm({
      centerId: centerIds[last] as string,
      center: centerPos[last] as Vec2,
      dir: "E",
      armLengthM: spacingM,
      lanes: lanesN,
      pocketM: 0,
      busLane: false,
      idPrefix: "corridor.E",
      registry,
    });
    nodes.push(...arm.nodes);
    links.push(...arm.links);
    lanes.push(...arm.lanes);
    if (arm.gate) gates.push(arm.gate);
    (armsPerNode[last] as Partial<Record<Dir, ArmInfo>>).E = arm.info;
  }

  // Shared backbone between consecutive intersections (no gates in between).
  for (let i = 0; i < intersections - 1; i++) {
    const aId = centerIds[i] as string;
    const aPos = centerPos[i] as Vec2;
    const bId = centerIds[i + 1] as string;
    const bPos = centerPos[i + 1] as Vec2;
    const eastId = `${aId}.E`;
    const westId = `${bId}.W`;
    const east = buildDirectionalLink(
      eastId,
      aId,
      aPos,
      bId,
      bPos,
      lanesN,
      "secondary",
      50,
      registry,
    );
    const west = buildDirectionalLink(
      westId,
      bId,
      bPos,
      aId,
      aPos,
      lanesN,
      "secondary",
      50,
      registry,
    );
    links.push(east.link, west.link);
    lanes.push(...east.laneDefs, ...west.laneDefs);
    const eastDirVec = normalize(sub(bPos, aPos));
    const westDirVec = normalize(sub(aPos, bPos));
    (armsPerNode[i] as Partial<Record<Dir, ArmInfo>>).E = armInfoFromLink(
      "E",
      westId,
      west.laneIds,
      eastId,
      east.laneIds,
      westDirVec,
      eastDirVec,
    );
    (armsPerNode[i + 1] as Partial<Record<Dir, ArmInfo>>).W = armInfoFromLink(
      "W",
      eastId,
      east.laneIds,
      westId,
      west.laneIds,
      eastDirVec,
      westDirVec,
    );
  }

  // Cross streets: S always a short gated stub; N either a short gated stub or (parallelStreet) a
  // longer stub ending at a junction with the parallel residential street.
  for (let i = 0; i < intersections; i++) {
    const cId = centerIds[i] as string;
    const cPos = centerPos[i] as Vec2;

    const sArm = buildApproachArm({
      centerId: cId,
      center: cPos,
      dir: "S",
      armLengthM: CROSS_ARM_M,
      lanes: 1,
      pocketM: 0,
      busLane: false,
      idPrefix: `${cId}.S`,
      registry,
      highwayClass: "residential",
    });
    nodes.push(...sArm.nodes);
    links.push(...sArm.links);
    lanes.push(...sArm.lanes);
    if (sArm.gate) gates.push(sArm.gate);
    (armsPerNode[i] as Partial<Record<Dir, ArmInfo>>).S = sArm.info;

    const nArm = buildApproachArm({
      centerId: cId,
      center: cPos,
      dir: "N",
      armLengthM: parallelStreet ? PARALLEL_OFFSET_M : CROSS_ARM_M,
      lanes: 1,
      pocketM: 0,
      busLane: false,
      idPrefix: `${cId}.N`,
      registry,
      highwayClass: "residential",
      farNodeKind: parallelStreet ? "junction" : "gate",
    });
    nodes.push(...nArm.nodes);
    links.push(...nArm.links);
    lanes.push(...nArm.lanes);
    if (nArm.gate) gates.push(nArm.gate);
    (armsPerNode[i] as Partial<Record<Dir, ArmInfo>>).N = nArm.info;
    if (parallelStreet) {
      (resArmsPerJunction[i] as Partial<Record<Dir, ArmInfo>>).S = reverseArmInfo("S", nArm.info);
    }
  }

  // Parallel residential street, T-joining every cross street's north end.
  if (parallelStreet) {
    const resGateWPos: Vec2 = [-PARALLEL_GATE_MARGIN_M, PARALLEL_OFFSET_M];
    const resGateEPos: Vec2 = [
      (intersections - 1) * spacingM + PARALLEL_GATE_MARGIN_M,
      PARALLEL_OFFSET_M,
    ];
    nodes.push({ id: "res.gate.w", x: resGateWPos[0], y: resGateWPos[1], kind: "gate" });
    nodes.push({ id: "res.gate.e", x: resGateEPos[0], y: resGateEPos[1], kind: "gate" });

    const junctionIds = centerIds.map((cId) => `${cId}.N.gate`);
    const junctionPos = centerPos.map((p) => [p[0], PARALLEL_OFFSET_M] as Vec2);
    const chainIds = ["res.gate.w", ...junctionIds, "res.gate.e"];
    const chainPos = [resGateWPos, ...junctionPos, resGateEPos];

    for (let j = 0; j < chainIds.length - 1; j++) {
      const leftId = chainIds[j] as string;
      const leftPos = chainPos[j] as Vec2;
      const rightId = chainIds[j + 1] as string;
      const rightPos = chainPos[j + 1] as Vec2;
      const eastId = `res${j}.E`;
      const westId = `res${j}.W`;
      const eastSeg = buildDirectionalLink(
        eastId,
        leftId,
        leftPos,
        rightId,
        rightPos,
        1,
        "residential",
        40,
        registry,
      );
      const westSeg = buildDirectionalLink(
        westId,
        rightId,
        rightPos,
        leftId,
        leftPos,
        1,
        "residential",
        40,
        registry,
      );
      links.push(eastSeg.link, westSeg.link);
      lanes.push(...eastSeg.laneDefs, ...westSeg.laneDefs);
      const eastDirVec = normalize(sub(rightPos, leftPos));
      const westDirVec = normalize(sub(leftPos, rightPos));

      const leftJunctionIdx = j - 1;
      if (leftJunctionIdx >= 0 && leftJunctionIdx < intersections) {
        (resArmsPerJunction[leftJunctionIdx] as Partial<Record<Dir, ArmInfo>>).E = armInfoFromLink(
          "E",
          westId,
          westSeg.laneIds,
          eastId,
          eastSeg.laneIds,
          westDirVec,
          eastDirVec,
        );
      } else if (leftJunctionIdx === -1) {
        gates.push({
          id: "g.res.w",
          nodeId: "res.gate.w",
          inLinkIds: [eastId],
          outLinkIds: [westId],
          weightIn: 1,
          weightOut: 1,
        });
      }

      const rightJunctionIdx = j;
      if (rightJunctionIdx >= 0 && rightJunctionIdx < intersections) {
        (resArmsPerJunction[rightJunctionIdx] as Partial<Record<Dir, ArmInfo>>).W = armInfoFromLink(
          "W",
          eastId,
          eastSeg.laneIds,
          westId,
          westSeg.laneIds,
          eastDirVec,
          westDirVec,
        );
      } else if (rightJunctionIdx === intersections) {
        gates.push({
          id: "g.res.e",
          nodeId: "res.gate.e",
          inLinkIds: [westId],
          outLinkIds: [eastId],
          weightIn: 1,
          weightOut: 1,
        });
      }
    }

    for (let i = 0; i < intersections; i++) {
      const jId = `${centerIds[i]}.N.gate`;
      const jArms = resArmsPerJunction[i] as Partial<Record<Dir, ArmInfo>>;
      const minorInLinkId = (jArms.S as ArmInfo).inLinkId;
      const protectionFor = (dir: Dir): Protection => (dir === "S" ? "yield" : "priority");
      const { connectors: jConnectors, approachLinkOf } = buildMovementConnectors(
        jArms,
        registry,
        jId,
        true,
        protectionFor,
      );
      connectors.push(...jConnectors);
      computeConflicts(
        jConnectors,
        (c) => approachLinkOf.get(c.id) ?? "",
        priorityVsMinor(approachLinkOf, minorInLinkId),
      );
    }
  }

  // Main intersections: signalized crossroads, simple 2-phase (through+right+permissive left).
  for (let i = 0; i < intersections; i++) {
    const cId = centerIds[i] as string;
    const nodeArms = armsPerNode[i] as Partial<Record<Dir, ArmInfo>>;
    const protectionFor = (_dir: Dir, turn: "through" | "left" | "right"): Protection =>
      turn === "left" ? "permissive" : "protected";
    const { connectors: nodeConnectors, approachLinkOf } = buildMovementConnectors(
      nodeArms,
      registry,
      cId,
      true,
      protectionFor,
    );
    connectors.push(...nodeConnectors);
    computeConflicts(
      nodeConnectors,
      (c) => approachLinkOf.get(c.id) ?? "",
      () => "signal",
    );

    const groups: ReturnType<typeof signalGroup>[] = [];
    const leftTurnModes: Record<string, LeftTurnMode> = {};
    const connectorById = new Map(nodeConnectors.map((c) => [c.id, c]));
    for (const dir of Object.keys(nodeArms) as Dir[]) {
      const a = nodeArms[dir];
      if (!a) continue;
      leftTurnModes[a.inLinkId] = "permissive";
      const mainIds = [...a.throughConnectorIds];
      if (a.rightConnectorId) mainIds.push(a.rightConnectorId);
      if (a.leftConnectorId) mainIds.push(a.leftConnectorId);
      const mainGroupId = `${cId}.sg.${dir}`;
      for (const cid of mainIds) {
        const c = connectorById.get(cid);
        if (c) c.signalGroupId = mainGroupId;
      }
      groups.push(
        signalGroup({
          id: mainGroupId,
          kind: "vehicle",
          section: "main",
          approachLinkId: a.inLinkId,
          connectorIds: mainIds,
        }),
      );
      a.mainGroupId = mainGroupId;
    }
    const nsIds = (["N", "S"] as Dir[])
      .map((d) => nodeArms[d]?.mainGroupId)
      .filter((x): x is string => x !== undefined);
    const ewIds = (["E", "W"] as Dir[])
      .map((d) => nodeArms[d]?.mainGroupId)
      .filter((x): x is string => x !== undefined);
    const phases = [];
    if (nsIds.length > 0)
      phases.push(signalPhase({ id: `${cId}.ph.ns`, greenGroupIds: nsIds, greenS: 40 }));
    if (ewIds.length > 0)
      phases.push(signalPhase({ id: `${cId}.ph.ew`, greenGroupIds: ewIds, greenS: 40 }));
    const offsetS = offsetsS[i] ?? 0;
    controllers.push(
      signalController({ id: `${cId}.ctrl`, nodeId: cId, groups, phases, leftTurnModes, offsetS }),
    );
  }

  return finish({
    meta: meta("corridor"),
    nodes,
    links,
    lanes,
    connectors,
    signalControllers: controllers,
    gates,
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const CAPACITY_VEH_H_PER_LANE = 1800;

/**
 * Rough estimate of `demand.multiplier` (packages/contracts/src/sim-config.ts) at which the most
 * constrained signalized approach is loaded to ~1.2x its capacity, assuming the default auto
 * `tripsPerHourPeak` (0.7x summed inbound-gate-lane capacity) split across gates by `weightIn`.
 * Capacity of an approach = 1800 veh/h/lane x its share of green time (1 when unsignalized). This
 * is an order-of-magnitude tool for nuance tests (docs/NUANCES.md), not a calibrated demand model:
 * it does not know how a gate's trips split across turning movements.
 */
export function saturationMultiplier(net: Network): number {
  const lanesById = new Map(net.lanes.map((l) => [l.id, l]));
  const controllerByNode = new Map(net.signalControllers.map((c) => [c.nodeId, c]));
  const linksById = new Map(net.links.map((l) => [l.id, l]));

  const carLaneCount = (link: Link): number =>
    link.laneIds.filter((id) => lanesById.get(id)?.kind !== "bus").length;

  const greenShare = (link: Link): number => {
    const ctrl = controllerByNode.get(link.toNodeId);
    if (!ctrl) return 1;
    const cycle = cycleLengthS(ctrl);
    if (cycle <= 0) return 1;
    let greenS = 0;
    for (const p of ctrl.phases) {
      const active = p.greenGroupIds.some((gid) => {
        const g = ctrl.groups.find((gr) => gr.id === gid);
        return g !== undefined && g.kind === "vehicle" && g.approachLinkId === link.id;
      });
      if (active) greenS += p.greenS + p.yellowS;
    }
    return greenS / cycle;
  };

  let totalInboundLanes = 0;
  const gateInfo: { weightIn: number; capacityVehH: number }[] = [];
  for (const gate of net.gates) {
    let laneCount = 0;
    let capacityVehH = 0;
    for (const linkId of gate.inLinkIds) {
      const link = linksById.get(linkId);
      if (!link) continue;
      const n = carLaneCount(link);
      laneCount += n;
      capacityVehH += n * CAPACITY_VEH_H_PER_LANE * greenShare(link);
    }
    totalInboundLanes += laneCount;
    gateInfo.push({ weightIn: gate.weightIn, capacityVehH });
  }
  if (totalInboundLanes === 0) return 1;

  const tripsPerHourPeakAuto = 0.7 * totalInboundLanes * CAPACITY_VEH_H_PER_LANE;
  const totalWeight = gateInfo.reduce((s, g) => s + g.weightIn, 0) || 1;

  let best = Number.POSITIVE_INFINITY;
  for (const g of gateInfo) {
    const demandShare = g.weightIn / totalWeight;
    if (demandShare <= 0 || g.capacityVehH <= 0) continue;
    const m = (1.2 * g.capacityVehH) / (tripsPerHourPeakAuto * demandShare);
    if (m < best) best = m;
  }
  return Number.isFinite(best) ? best : 1;
}

/**
 * Approximates the `SegmentDescriptor[]` sim-core will generate for one link's lanes
 * (packages/contracts/src/metrics.ts), for tests that need segment boundaries before a Simulation
 * exists. `index` is local to this link, not the network-wide index a real Simulation would assign.
 */
export function approachSegments(
  net: Network,
  linkId: string,
  segmentLengthM = 25,
): SegmentDescriptor[] {
  const link = net.links.find((l) => l.id === linkId);
  if (!link) throw new Error(`approachSegments: unknown link ${linkId}`);
  const lanesById = new Map(net.lanes.map((l) => [l.id, l]));
  const freeFlowSpeedMps = link.speedLimitKph / 3.6;

  const segments: SegmentDescriptor[] = [];
  let index = 0;
  for (const laneId of link.laneIds) {
    const lane = lanesById.get(laneId);
    if (!lane) continue;
    let s = lane.startS;
    while (s < lane.endS - 1e-6) {
      const endS = Math.min(s + segmentLengthM, lane.endS);
      segments.push({
        index: index++,
        laneId,
        linkId,
        startS: s,
        endS,
        freeFlowSpeedMps,
        ...(endS >= lane.endS - 1e-6 ? { approachNodeId: link.toNodeId } : {}),
      });
      s = endS;
    }
  }
  return segments;
}

/** Convenience: apply overrides to a synthetic network (delegates to map-data once T-24 lands). */
export function withOverrides(_net: Network, _overrides: NetworkOverride[]): Network {
  throw new Error("not implemented: see docs/tasks/T-24-scenario-editor.md");
}

/** Validate strictly; builders must never emit inconsistent networks. */
export function finish(raw: unknown): Network {
  const net = parseNetwork(raw);
  const errors = checkNetworkIntegrity(net);
  if (errors.length > 0) throw new Error(`synthetic network invalid:\n${errors.join("\n")}`);
  return net;
}
