import { z } from "zod";

/** Bump only through a documented decision (see docs/CONTRACTS.md, "Изменение контрактов"). */
export const SCHEMA_VERSION = 1 as const;

/** Where an attribute value came from. Shown in the UI so assumptions are never hidden. */
export const ProvenanceSchema = z.enum(["osm", "default", "manual"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** attribute name -> provenance. Attributes not listed are structural (derived from geometry/topology). */
export const ProvenanceMapSchema = z.record(z.string(), ProvenanceSchema);
export type ProvenanceMap = z.infer<typeof ProvenanceMapSchema>;

export const VehicleClassSchema = z.enum(["car", "bus", "trolleybus", "taxi"]);
export type VehicleClass = z.infer<typeof VehicleClassSchema>;
export const VEHICLE_CLASSES = VehicleClassSchema.options;

export const IdSchema = z.string().min(1);

/** Local metric coordinates: x = east, y = north, meters from the network origin (bbox centre). */
export const Point2Schema = z.tuple([z.number(), z.number()]);
export type Point2 = z.infer<typeof Point2Schema>;
export const PolylineSchema = z.array(Point2Schema).min(2);
export type Polyline = z.infer<typeof PolylineSchema>;
export const PolygonSchema = z.array(Point2Schema).min(3);
export type Polygon = z.infer<typeof PolygonSchema>;

export const TurnKindSchema = z.enum(["through", "left", "right", "uturn", "merge", "diverge"]);
export type TurnKind = z.infer<typeof TurnKindSchema>;

export const HighwayClassSchema = z.enum([
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "residential",
  "unclassified",
  "living_street",
  "service",
]);
export type HighwayClass = z.infer<typeof HighwayClassSchema>;

export const LonLatSchema = z.object({ lat: z.number(), lon: z.number() });
export type LonLat = z.infer<typeof LonLatSchema>;

export const BBoxSchema = z.object({
  south: z.number(),
  west: z.number(),
  north: z.number(),
  east: z.number(),
});
export type BBox = z.infer<typeof BBoxSchema>;

/** Minutes since midnight, 0..1440. */
export const TimeOfDayMinSchema = z.number().min(0).max(1440);
