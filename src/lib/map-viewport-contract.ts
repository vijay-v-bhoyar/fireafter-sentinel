import { z } from "zod";

export const MAP_VIEW_VERSION = "2026-10-08-asset-view-v1";
export const MAP_VIEW_BYTES = 256 * 1024;
export const MAP_VIEW_UNAVAILABLE = "This map view is unavailable. Retry, or use the Action Queue while an operator checks the saved map index.";
export class MapViewportError extends Error {
  constructor(readonly status = 503, message = MAP_VIEW_UNAVAILABLE) { super(message); }
}
export const MapBoundsSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90),
  z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .refine(([w, s, e, n]) => e - w >= 0.000001 && n - s >= 0.000001);
export type MapBounds = z.infer<typeof MapBoundsSchema>;
export const MapViewportQuerySchema = z.object({
  incidentId: z.string().trim().min(1).max(256), revision: z.uuid(),
  bbox: z.string().max(180).transform(value => value.split(",").map(v => v.trim() ? Number(v) : NaN)).pipe(MapBoundsSchema),
  zoom: z.string().regex(/^(?:[0-9]|1[0-9]|20)$/),
}).strict();
export type MapViewportQuery = z.input<typeof MapViewportQuerySchema>;
const coordinate = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const count = z.number().int().min(0).max(100000);
export const MapViewportResponseSchema = z.object({
  version: z.literal(MAP_VIEW_VERSION), incidentId: z.string().min(1).max(256), revision: z.uuid(),
  bbox: MapBoundsSchema, zoom: z.number().int().min(0).max(20),
  totalStored: count, totalLocated: count, withheld: count, inView: count,
  mode: z.enum(["points", "clusters"]),
  items: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("point"), id: z.uuid(), name: z.string().max(512), type: z.string().max(64), coordinates: coordinate }).strict(),
    z.object({ kind: z.literal("cluster"), id: z.string().regex(/^c[0-3]-[0-3]$/), count: count.refine(n => n > 1), coordinates: coordinate }).strict(),
  ])).max(16),
}).strict();
export type MapViewportResponse = z.infer<typeof MapViewportResponseSchema>;
export function validateMapViewportResponse(value: unknown, input: z.output<typeof MapViewportQuerySchema>) {
  const result = MapViewportResponseSchema.parse(value);
  const [w, s, e, n] = input.bbox;
  const represented = result.items.reduce((sum, item) => sum + (item.kind === "cluster" ? item.count : 1), 0);
  if (result.incidentId !== input.incidentId || result.revision !== input.revision || result.zoom !== Number(input.zoom) ||
      result.bbox.some((v, i) => v !== input.bbox[i]) || result.totalLocated + result.withheld !== result.totalStored ||
      result.inView > result.totalLocated || represented !== result.inView ||
      new Set(result.items.map(item => item.id)).size !== result.items.length ||
      (result.mode === "clusters") !== result.items.some(item => item.kind === "cluster") ||
      result.items.some(item =>
        item.coordinates[0] < w || item.coordinates[0] > e || item.coordinates[1] < s || item.coordinates[1] > n)) throw new MapViewportError();
  return result;
}
