import { z } from "zod";
import { IdSchema, TimeOfDayMinSchema, VehicleClassSchema } from "./common.ts";
import { LeftTurnModeSchema } from "./network.ts";
import type { SimConfigPatch } from "./sim-config.ts";

/**
 * Scenario overrides are applied by the map-data compiler ON TOP of the generated network,
 * producing a new Network (deterministically). Changing overrides = recompile + restart.
 * They are the only editing surface exposed in the UI (forms, no geometry drawing).
 */

export const BusLaneOverrideSchema = z.object({
  allowed: z.array(VehicleClassSchema).min(1).optional(),
  activeFromMin: TimeOfDayMinSchema.optional(),
  activeToMin: TimeOfDayMinSchema.optional(),
  carsMayEnterForRightTurnWithinM: z.number().nonnegative().optional(),
});

export const LinkOverrideSchema = z.object({
  kind: z.literal("link"),
  linkId: IdSchema,
  set: z.object({
    /** Number of general-purpose full-length lanes (pockets and bus lanes are separate). */
    generalLanes: z.number().int().min(1).max(6).optional(),
    speedLimitKph: z.number().positive().optional(),
    /** 0 removes the pocket. */
    leftPocketLengthM: z.number().nonnegative().optional(),
    rightPocketLengthM: z.number().nonnegative().optional(),
    /** null removes the bus lane; an object adds/updates the rightmost lane as a bus lane. */
    busLane: BusLaneOverrideSchema.nullable().optional(),
  }),
});

export const SignalOverrideSchema = z.object({
  kind: z.literal("signal"),
  nodeId: IdSchema,
  set: z.object({
    cycleS: z.number().positive().optional(),
    offsetS: z.number().nonnegative().optional(),
    /** groupId -> green seconds. Phases are rebuilt by the plan generator to honour these. */
    greenS: z.record(IdSchema, z.number().positive()).optional(),
    /** approach linkId -> left-turn handling. Rebuilds phases (adds/removes the arrow section). */
    leftTurnModes: z.record(IdSchema, LeftTurnModeSchema).optional(),
    pedestrianPhase: z.boolean().optional(),
  }),
});

export const BusStopOverrideSchema = z.object({
  kind: z.literal("bus_stop"),
  stopId: IdSchema,
  set: z.object({ kind: z.enum(["in_lane", "bay"]).optional() }),
});

export const BusRouteOverrideSchema = z.object({
  kind: z.literal("bus_route"),
  routeId: IdSchema,
  set: z.object({
    headwayPeakS: z.number().positive().optional(),
    headwayOffpeakS: z.number().positive().optional(),
    enabled: z.boolean().optional(),
  }),
});

export const NetworkOverrideSchema = z.discriminatedUnion("kind", [
  LinkOverrideSchema,
  SignalOverrideSchema,
  BusStopOverrideSchema,
  BusRouteOverrideSchema,
]);
export type NetworkOverride = z.infer<typeof NetworkOverrideSchema>;

export const ScenarioSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  /** Network this scenario was authored against (meta.networkId). */
  networkId: IdSchema,
  overrides: z.array(NetworkOverrideSchema).default([]),
  /** Deep-partial SimConfig; validated when applied. */
  params: z.custom<SimConfigPatch>((v) => typeof v === "object" && v !== null).default({}),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** The scenario that represents the untouched generated network. */
export function baselineScenario(networkId: string): Scenario {
  return ScenarioSchema.parse({ id: "baseline", name: "Базовый", networkId });
}
