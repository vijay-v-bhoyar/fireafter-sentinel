import { z } from "zod";
import { MapBoundsSchema, MapViewportError, MapViewportQuerySchema } from "./map-viewport-contract";

export const SOURCE_VIEW_VERSION = "2026-10-09-source-view-v1";
export const SOURCE_VIEW_BYTES = 4 * 1024 * 1024;
export const SOURCE_VIEW_RPC_BYTES = 6 * 1024 * 1024;
export const SOURCE_VIEW_EXPANDED_BYTES = 8 * 1024 * 1024;
export const SOURCE_VIEW_COMPRESSED_BYTES = 2 * 1024 * 1024;
export const SOURCE_VIEW_LAYERS = ["tiger-roads", "3dhp-flowlines", "usgs-pwfdf"] as const;
export const SourceViewportQuerySchema = MapViewportQuerySchema.extend({ layer: z.enum(SOURCE_VIEW_LAYERS) });
export type SourceViewportQuery = z.input<typeof SourceViewportQuerySchema>;
const count = z.number().int().min(0).max(100000);
const coordinate = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const path = z.array(coordinate).min(2).max(100000);
const geometry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MultiLineString"), coordinates: z.array(path).min(1).max(100000) }).strict(),
  z.object({ type: z.literal("Polygon"), coordinates: z.array(path).min(1).max(100000) }).strict(),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(path).min(1).max(100000)).min(1).max(500) }).strict(),
]);
const safeUrl = z.string().max(8192).refine(value => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }).nullable();
const feature = z.object({ id: z.string().max(128), position: count, sourceFeatureId: z.string().min(1).max(4096),
  name: z.string().max(4096), sourceUrl: safeUrl, category: z.string().max(4096).nullable(), geometry }).strict();
export const SourceViewportResponseSchema = z.object({
  version: z.literal(SOURCE_VIEW_VERSION), incidentId: z.string().min(1).max(256), revision: z.uuid(),
  bbox: MapBoundsSchema, zoom: z.number().int().min(0).max(20), layer: z.enum(SOURCE_VIEW_LAYERS),
  mode: z.enum(["ready", "zoom_required", "unavailable"]), totalRecords: count.nullable(), candidateRecords: count, candidateChunks: z.number().int().min(0).max(4096),
  source: z.object({ rowId: z.uuid(), name: z.string().max(4096), url: safeUrl, fetchedAt: z.string().max(128), sourceUpdatedAt: z.string().max(128),
    timeBasis: z.enum(["provider", "retrieval", "unknown"]), current: z.boolean(), freshness: z.string().max(4096),
    detail: z.string().max(256 * 1024), warnings: z.array(z.string().max(256 * 1024)).max(4096) }).strict().nullable(),
  features: z.array(feature).max(4096),
}).strict();
export type SourceViewportResponse = z.infer<typeof SourceViewportResponseSchema>;
export function validateSourceViewportResponse(value: unknown, input: z.output<typeof SourceViewportQuerySchema>) {
  const result = SourceViewportResponseSchema.parse(value);
  if (result.incidentId !== input.incidentId || result.revision !== input.revision || result.layer !== input.layer || result.zoom !== Number(input.zoom) ||
    result.bbox.some((v, i) => v !== input.bbox[i]) || (result.mode === "unavailable") !== (result.totalRecords === null) ||
    (result.totalRecords !== null && result.candidateRecords > result.totalRecords) || result.features.length > result.candidateRecords ||
    (result.mode !== "ready" && result.features.length !== 0) || (result.mode !== "unavailable" && !result.source) ||
    new Set(result.features.map(item => item.position)).size !== result.features.length || result.features.some(item =>
      item.position >= result.totalRecords! || item.id !== `${result.source?.rowId}:${item.position}` ||
      (input.layer === "usgs-pwfdf") === (item.geometry.type === "MultiLineString"))) throw new MapViewportError();
  return result;
}
