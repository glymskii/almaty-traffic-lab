import { z } from "zod";
import {
  BBoxSchema,
  HighwayClassSchema,
  IdSchema,
  LonLatSchema,
  PolygonSchema,
  PolylineSchema,
  ProvenanceMapSchema,
  SCHEMA_VERSION,
  TimeOfDayMinSchema,
  TurnKindSchema,
  VehicleClassSchema,
} from "./common.ts";

// ---------------------------------------------------------------------------
// Nodes and links (directed graph)
// ---------------------------------------------------------------------------

/**
 * junction   - unsignalized intersection; priority is resolved per connector (`protection`)
 * signalized - has a SignalController
 * merge      - ramp/lane joins a carriageway without an intersection (Al-Farabi style)
 * gate       - boundary of the bbox; vehicles are born/removed here (see Gate)
 * dead_end   - link ends inside the bbox (cul-de-sac); acts as a small source/sink
 * bend       - degree-2 geometry node kept for readability of the graph
 */
export const NodeKindSchema = z.enum([
  "junction",
  "signalized",
  "merge",
  "gate",
  "dead_end",
  "bend",
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const NodeSchema = z.object({
  id: IdSchema,
  x: z.number(),
  y: z.number(),
  kind: NodeKindSchema,
  name: z.string().optional(),
  osmNodeId: z.number().optional(),
  provenance: ProvenanceMapSchema.default({}),
});
export type NetworkNode = z.infer<typeof NodeSchema>;

/** One direction of travel. A two-way street produces two links with opposite from/to. */
export const LinkSchema = z.object({
  id: IdSchema,
  fromNodeId: IdSchema,
  toNodeId: IdSchema,
  name: z.string().optional(),
  highwayClass: HighwayClassSchema,
  /** Centreline of this direction, from fromNode to toNode. */
  geometry: PolylineSchema,
  lengthM: z.number().positive(),
  speedLimitKph: z.number().positive(),
  /** Ordered leftmost -> rightmost in the direction of travel. */
  laneIds: z.array(IdSchema).min(1),
  osmWayIds: z.array(z.number()).default([]),
  provenance: ProvenanceMapSchema.default({}),
});
export type Link = z.infer<typeof LinkSchema>;

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export const BusLaneRuleSchema = z.object({
  /** Classes allowed to drive here at any time. */
  allowed: z.array(VehicleClassSchema).min(1),
  /** Active interval; 0..1440 means 24/7. Outside the interval the lane behaves as general. */
  activeFromMin: TimeOfDayMinSchema.default(0),
  activeToMin: TimeOfDayMinSchema.default(1440),
  /** Cars may legally enter within this distance of a right turn they intend to make. */
  carsMayEnterForRightTurnWithinM: z.number().nonnegative().default(50),
});
export type BusLaneRule = z.infer<typeof BusLaneRuleSchema>;

/**
 * general     - full-length or partial general-purpose lane
 * bus         - dedicated bus lane (needs `busLane`)
 * turn_pocket - lane that opens mid-link (startS > 0) for a turn; spillback happens when it is full
 */
export const LaneKindSchema = z.enum(["general", "bus", "turn_pocket"]);
export type LaneKind = z.infer<typeof LaneKindSchema>;

export const LaneSchema = z.object({
  id: IdSchema,
  linkId: IdSchema,
  /** 0 = leftmost lane of the link in the direction of travel. Must equal position in link.laneIds. */
  index: z.number().int().nonnegative(),
  widthM: z.number().positive().default(3.5),
  /** Lane exists for s in [startS, endS] along the link. Full-length lanes: 0..link.lengthM. */
  startS: z.number().nonnegative(),
  endS: z.number().positive(),
  kind: LaneKindSchema,
  allowed: z.array(VehicleClassSchema).min(1),
  /** Movements permitted from the end of this lane. */
  turns: z.array(TurnKindSchema).min(1),
  busLane: BusLaneRuleSchema.optional(),
  provenance: ProvenanceMapSchema.default({}),
});
export type Lane = z.infer<typeof LaneSchema>;

// ---------------------------------------------------------------------------
// Connectors (lane-to-lane movements through a node) and conflicts
// ---------------------------------------------------------------------------

/**
 * protected  - when its signal group is green, every conflicting movement is red: no gap acceptance
 * permissive - its signal group may be green together with conflicting movements: gap acceptance
 * yield      - unsignalized, must yield at its conflict points
 * priority   - unsignalized, has right of way at its conflict points
 */
export const ProtectionSchema = z.enum(["protected", "permissive", "yield", "priority"]);
export type Protection = z.infer<typeof ProtectionSchema>;

export const ConflictPointSchema = z.object({
  otherConnectorId: IdSchema,
  /** Distance along this connector to the conflict point. */
  sThisM: z.number().nonnegative(),
  /** Distance along the other connector to the same point. */
  sOtherM: z.number().nonnegative(),
  /** Who has right of way when both may proceed. `signal` = resolved by the controller. */
  priority: z.enum(["this", "other", "signal"]),
});
export type ConflictPoint = z.infer<typeof ConflictPointSchema>;

export const ConnectorSchema = z.object({
  id: IdSchema,
  fromLaneId: IdSchema,
  toLaneId: IdSchema,
  viaNodeId: IdSchema,
  turn: TurnKindSchema,
  geometry: PolylineSchema,
  lengthM: z.number().positive(),
  signalGroupId: IdSchema.optional(),
  protection: ProtectionSchema,
  conflicts: z.array(ConflictPointSchema).default([]),
  /** Crosswalks this movement passes through and must yield to. */
  crosswalkIds: z.array(IdSchema).default([]),
  provenance: ProvenanceMapSchema.default({}),
});
export type Connector = z.infer<typeof ConnectorSchema>;

export const CrosswalkSchema = z.object({
  id: IdSchema,
  nodeId: IdSchema,
  /** Across the carriageway. */
  geometry: PolylineSchema,
  lengthM: z.number().positive(),
  /** Movements that cross it (must be kept consistent with Connector.crosswalkIds). */
  connectorIds: z.array(IdSchema).default([]),
  /** Pedestrian signal group; absent = unsignalized zebra, vehicles always yield to present pedestrians. */
  signalGroupId: IdSchema.optional(),
  provenance: ProvenanceMapSchema.default({}),
});
export type Crosswalk = z.infer<typeof CrosswalkSchema>;

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** main = round lights; arrow_* = additional section (доп. секция). Arrow sections are OFF, not red, when not green. */
export const SignalSectionSchema = z.enum(["main", "arrow_left", "arrow_right"]);
export type SignalSection = z.infer<typeof SignalSectionSchema>;

export const SignalGroupSchema = z.object({
  id: IdSchema,
  kind: z.enum(["vehicle", "pedestrian"]),
  section: SignalSectionSchema.default("main"),
  /** Vehicle groups: the incoming link this group serves (for UI labels and editing). */
  approachLinkId: IdSchema.optional(),
  connectorIds: z.array(IdSchema).default([]),
  crosswalkIds: z.array(IdSchema).default([]),
});
export type SignalGroup = z.infer<typeof SignalGroupSchema>;

export const PhaseSchema = z.object({
  id: IdSchema,
  greenGroupIds: z.array(IdSchema).min(1),
  greenS: z.number().positive(),
  yellowS: z.number().nonnegative().default(3),
  allRedS: z.number().nonnegative().default(2),
});
export type Phase = z.infer<typeof PhaseSchema>;

export const LeftTurnModeSchema = z.enum([
  "protected",
  "permissive",
  "protected_permissive",
  "prohibited",
]);
export type LeftTurnMode = z.infer<typeof LeftTurnModeSchema>;

export const SignalControllerSchema = z.object({
  id: IdSchema,
  nodeId: IdSchema,
  /** Shift of the cycle start relative to global time 0, for green waves. */
  offsetS: z.number().nonnegative().default(0),
  groups: z.array(SignalGroupSchema).min(1),
  /** Executed in order, cyclically. Cycle length = sum(green + yellow + allRed). */
  phases: z.array(PhaseSchema).min(1),
  /** approach linkId -> how left turns from that approach are handled. */
  leftTurnModes: z.record(IdSchema, LeftTurnModeSchema).default({}),
  pedestrianPhase: z.boolean().default(true),
  provenance: ProvenanceMapSchema.default({}),
});
export type SignalController = z.infer<typeof SignalControllerSchema>;

export function cycleLengthS(controller: Pick<SignalController, "phases">): number {
  let total = 0;
  for (const p of controller.phases) total += p.greenS + p.yellowS + p.allRedS;
  return total;
}

// ---------------------------------------------------------------------------
// Public transport
// ---------------------------------------------------------------------------

export const BusStopSchema = z.object({
  id: IdSchema,
  name: z.string().optional(),
  linkId: IdSchema,
  laneId: IdSchema,
  /** Position of the stop along the link. */
  s: z.number().nonnegative(),
  /** in_lane: the bus blocks its lane while dwelling. bay: the bus leaves the lane. */
  kind: z.enum(["in_lane", "bay"]),
  osmNodeId: z.number().optional(),
  provenance: ProvenanceMapSchema.default({}),
});
export type BusStop = z.infer<typeof BusStopSchema>;

export const BusRouteSchema = z.object({
  id: IdSchema,
  ref: z.string(),
  name: z.string().optional(),
  kind: z.enum(["bus", "trolleybus"]),
  /** Ordered path inside the bbox; consecutive links must share a node. */
  linkIds: z.array(IdSchema).min(1),
  stopIds: z.array(IdSchema).default([]),
  headwayPeakS: z.number().positive(),
  headwayOffpeakS: z.number().positive(),
  entryNodeId: IdSchema,
  exitNodeId: IdSchema,
  osmRelationId: z.number().optional(),
  provenance: ProvenanceMapSchema.default({}),
});
export type BusRoute = z.infer<typeof BusRouteSchema>;

// ---------------------------------------------------------------------------
// Demand anchors
// ---------------------------------------------------------------------------

export const GateSchema = z.object({
  id: IdSchema,
  nodeId: IdSchema,
  /** Links leaving the gate into the network (vehicles are born on these). */
  inLinkIds: z.array(IdSchema).default([]),
  /** Links arriving at the gate (vehicles are removed on these). */
  outLinkIds: z.array(IdSchema).default([]),
  weightIn: z.number().nonnegative(),
  weightOut: z.number().nonnegative(),
  provenance: ProvenanceMapSchema.default({}),
});
export type Gate = z.infer<typeof GateSchema>;

export const AttractorKindSchema = z.enum([
  "mall",
  "office",
  "university",
  "stadium",
  "hospital",
  "transport_hub",
  "residential",
  "other",
]);
export const AttractorSchema = z.object({
  id: IdSchema,
  name: z.string().optional(),
  x: z.number(),
  y: z.number(),
  /** Nearest network node used for trip start/end. */
  nodeId: IdSchema,
  kind: AttractorKindSchema,
  weightIn: z.number().nonnegative(),
  weightOut: z.number().nonnegative(),
  provenance: ProvenanceMapSchema.default({}),
});
export type Attractor = z.infer<typeof AttractorSchema>;

// ---------------------------------------------------------------------------
// City layers (rendering only)
// ---------------------------------------------------------------------------

export const BuildingSchema = z.object({
  id: IdSchema,
  footprint: PolygonSchema,
  heightM: z.number().positive(),
  provenance: ProvenanceMapSchema.default({}),
});
export type Building = z.infer<typeof BuildingSchema>;

export const AreaSchema = z.object({
  id: IdSchema,
  kind: z.enum(["park", "water", "rail", "pedestrian"]),
  polygon: PolygonSchema,
});
export type Area = z.infer<typeof AreaSchema>;

export const WaterwaySchema = z.object({
  id: IdSchema,
  polyline: PolylineSchema,
  widthM: z.number().positive().default(6),
});
export type Waterway = z.infer<typeof WaterwaySchema>;

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const NetworkMetaSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  networkId: IdSchema,
  bboxId: IdSchema,
  bbox: BBoxSchema,
  /** Lon/lat of local (0,0). */
  origin: LonLatSchema,
  generatedAt: z.string(),
  generator: z.string(),
  osmSnapshotAt: z.string().optional(),
  sourceHash: z.string().optional(),
});
export type NetworkMeta = z.infer<typeof NetworkMetaSchema>;

export const NetworkSchema = z.object({
  meta: NetworkMetaSchema,
  nodes: z.array(NodeSchema),
  links: z.array(LinkSchema),
  lanes: z.array(LaneSchema),
  connectors: z.array(ConnectorSchema),
  crosswalks: z.array(CrosswalkSchema).default([]),
  signalControllers: z.array(SignalControllerSchema).default([]),
  busStops: z.array(BusStopSchema).default([]),
  busRoutes: z.array(BusRouteSchema).default([]),
  gates: z.array(GateSchema).default([]),
  attractors: z.array(AttractorSchema).default([]),
  buildings: z.array(BuildingSchema).default([]),
  areas: z.array(AreaSchema).default([]),
  waterways: z.array(WaterwaySchema).default([]),
});
export type Network = z.infer<typeof NetworkSchema>;

/** Parse + validate a JSON value into a Network. Throws ZodError on schema violation. */
export function parseNetwork(json: unknown): Network {
  return NetworkSchema.parse(json);
}
