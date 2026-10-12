import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CurrentUser } from "./auth";
import { getSupabaseAdminClient } from "./supabase";
import { canWriteOperationalRecords } from "./role-capabilities";
import { MapViewportError } from "./map-viewport-contract";
import { readQueueSourceModel, type QueueSourceProjection } from "./queue-source-read-model";
import { readSourceSpatialManifest, decodeSourceSpatialChunk, sourceSpatialChunkHeader, spatialBoundsOverlap, type SourceSpatialChunk } from "./source-spatial-storage";
import { readSourceLineGeometry } from "./source-line-geometry";
import { pwfdfBasinsFromSnapshot } from "./pwfdf";
import { evidenceMaxAgeMinutes, hasCurrentSourceEvidence, projectSourceFreshness } from "./source-freshness";
import { SOURCE_VIEW_VERSION, SOURCE_VIEW_BYTES, SOURCE_VIEW_RPC_BYTES, SOURCE_VIEW_EXPANDED_BYTES, SOURCE_VIEW_COMPRESSED_BYTES,
  SourceViewportQuerySchema, validateSourceViewportResponse, type SourceViewportQuery, type SourceViewportResponse } from "./source-viewport-contract";

const object = z.record(z.string(), z.unknown());
const rpcSchema = z.object({ version: z.literal(SOURCE_VIEW_VERSION), incidentId: z.string(), revision: z.uuid(), bbox: z.array(z.number()).length(4),
  zoom: z.number().int(), layer: z.string(), sourceRowId: z.uuid().nullable(), incidentRowId: z.uuid(), model: object.nullable(), storage: object.nullable(),
  mode: z.enum(["ready", "zoom_required", "unavailable"]), candidateChunks: z.number().int().min(0).max(4096),
  candidateRecords: z.number().int().min(0).max(100000), compressedBytes: z.number().int().min(0).max(32 * 1024 * 1024), chunks: z.array(object).max(4096),
}).strict();
function safeUrl(value: string | undefined) {
  try { const url = new URL(value!); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function bounds(paths: number[][][]) {
  const box: [number, number, number, number] = [180, 90, -180, -90];
  for (const path of paths) for (const [x, y] of path) { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
  return box;
}

export function projectSourceViewport(value: unknown, input: z.output<typeof SourceViewportQuerySchema>, now = new Date()): SourceViewportResponse {
  if (Buffer.byteLength(JSON.stringify(value)) > SOURCE_VIEW_RPC_BYTES) throw new MapViewportError();
  const rpc = rpcSchema.parse(value);
  if (rpc.incidentId !== input.incidentId || rpc.revision !== input.revision || rpc.layer !== input.layer || rpc.zoom !== Number(input.zoom) ||
    rpc.bbox.some((v, i) => v !== input.bbox[i])) throw new MapViewportError();
  const result: SourceViewportResponse = { version: SOURCE_VIEW_VERSION, incidentId: input.incidentId, revision: input.revision,
    layer: input.layer, zoom: Number(input.zoom), bbox: input.bbox, mode: rpc.mode, totalRecords: null, candidateRecords: rpc.candidateRecords,
    candidateChunks: rpc.candidateChunks, source: null, features: [] };
  let source = null;
  if (rpc.model) {
    if (rpc.model.version !== SOURCE_VIEW_VERSION || rpc.model.revision !== input.revision) throw new MapViewportError();
    const projection = rpc.model.projection as QueueSourceProjection;
    if (!projection || projection.id !== rpc.sourceRowId || projection.incident_id !== rpc.incidentRowId) throw new MapViewportError();
    source = readQueueSourceModel(projection);
    if (source) {
      if (source.sourceKey !== input.layer) throw new MapViewportError();
      const current = projectSourceFreshness(source, now, evidenceMaxAgeMinutes());
      result.source = { rowId: rpc.sourceRowId!, name: source.sourceName, url: safeUrl(source.sourceUrl), fetchedAt: source.fetchedAt,
        sourceUpdatedAt: source.sourceUpdatedAt, timeBasis: source.sourceTimeBasis ?? "unknown", current: hasCurrentSourceEvidence(current),
        freshness: current.freshnessLabel, detail: current.detail, warnings: current.warnings ?? [] };
    }
  } else if (rpc.sourceRowId !== null) throw new MapViewportError();
  if (!rpc.storage) {
    if (rpc.mode !== "unavailable" || rpc.candidateChunks || rpc.candidateRecords || rpc.compressedBytes || rpc.chunks.length) throw new MapViewportError();
    return validateSourceViewportResponse(result, input);
  }
  if (!source || !rpc.model || rpc.mode === "unavailable") throw new MapViewportError();
  const projection = rpc.model.projection as QueueSourceProjection;
  if (projection.meta_rawPayloadHash !== rpc.storage.rawPayloadHash || projection.meta_rawPayloadBytes !== rpc.storage.rawPayloadBytes ||
    projection.meta_rawPayloadEncoding !== rpc.storage.rawPayloadEncoding) throw new MapViewportError();
  const index = readSourceSpatialManifest(rpc.storage);
  if (index.field !== (input.layer === "usgs-pwfdf" ? "basins" : "features")) throw new MapViewportError();
  result.totalRecords = index.count;
  const selected = index.chunks.filter(chunk => spatialBoundsOverlap(chunk.bounds, input.bbox));
  if (selected.length !== rpc.candidateChunks || selected.reduce((n, chunk) => n + chunk.count, 0) !== rpc.candidateRecords) throw new MapViewportError();
  const overBudget = selected.reduce((n, chunk) => n + chunk.bytes, 0) > SOURCE_VIEW_EXPANDED_BYTES || rpc.compressedBytes > SOURCE_VIEW_COMPRESSED_BYTES || rpc.candidateRecords > 4096;
  if ((rpc.mode === "zoom_required") !== overBudget || (rpc.mode === "zoom_required" && rpc.chunks.length)) throw new MapViewportError();
  if (rpc.mode === "zoom_required") return validateSourceViewportResponse(result, input);
  if (selected.length !== rpc.chunks.length) throw new MapViewportError();
  const chunks = rpc.chunks as SourceSpatialChunk[];
  if (chunks.some((chunk, i) => JSON.stringify(sourceSpatialChunkHeader(chunk)) !== JSON.stringify(sourceSpatialChunkHeader(selected[i]))) ||
    chunks.reduce((n, chunk) => n + (typeof chunk.gzip === "string" ? Buffer.byteLength(chunk.gzip) + 512 : Infinity), 0) !== rpc.compressedBytes) throw new MapViewportError();
  const entries = chunks.flatMap(chunk => decodeSourceSpatialChunk(chunk, index.count));
  if (new Set(entries.map(entry => entry.position)).size !== entries.length) throw new MapViewportError();
  const base = JSON.parse(index.baseJson);
  const payload = { ...base, [index.field]: entries.map(entry => entry.record), ...(index.field === "basins" ? { basinCount: entries.length } : {}) };
  if (input.layer === "usgs-pwfdf") {
    const basins = entries.length ? pwfdfBasinsFromSnapshot({ ...source, rawPayload: payload }) : [];
    if (basins.length !== entries.length) throw new MapViewportError();
    result.features = basins.map((basin, i) => ({ id: `${rpc.sourceRowId}:${entries[i].position}`, position: entries[i].position, sourceFeatureId: basin.id,
      name: basin.id, category: basin.combinedHazard, sourceUrl: safeUrl(source.sourceUrl), geometry: basin.geometry }));
  } else {
    const { features, warning } = readSourceLineGeometry(payload, input.layer);
    if (warning || features.length !== entries.length) throw new MapViewportError();
    result.features = features.map((feature, i) => ({ id: `${rpc.sourceRowId}:${entries[i].position}`, position: entries[i].position, sourceFeatureId: feature.id,
      name: feature.name ?? feature.id, category: feature.class ?? null, sourceUrl: safeUrl(feature.sourceUrl ?? source.sourceUrl),
      geometry: { type: "MultiLineString", coordinates: feature.paths } }));
  }
  // Recheck bounds from the actual decoded geometry, not just the storage index.
  for (const [i, feature] of result.features.entries()) {
    const paths = feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates.flat() : feature.geometry.coordinates;
    if (JSON.stringify(bounds(paths)) !== JSON.stringify(entries[i].bounds)) throw new MapViewportError();
  }
  result.features = result.features.filter((_, i) => spatialBoundsOverlap(entries[i].bounds, input.bbox)).sort((a, b) => a.position - b.position);
  if (Buffer.byteLength(JSON.stringify(result)) > SOURCE_VIEW_BYTES) { result.mode = "zoom_required"; result.features = []; }
  return validateSourceViewportResponse(result, input);
}

export async function getSourceViewport(raw: SourceViewportQuery, user: CurrentUser, callerSignal: AbortSignal) {
  const input = SourceViewportQuerySchema.parse(raw);
  if (!canWriteOperationalRecords(user) || !user.organizationId) throw new MapViewportError(403);
  const db = getSupabaseAdminClient(); if (!db) throw new MapViewportError();
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(12000)]);
  const { data, error } = await (db as unknown as SupabaseClient).rpc("fireafter_read_source_viewport", {
    p_incident_id: input.incidentId, p_actor_id: user.id, p_organization_id: user.organizationId, p_role: user.role,
    p_revision: input.revision, p_bbox: input.bbox, p_zoom: Number(input.zoom), p_layer: input.layer,
  }).abortSignal(signal).retry(false);
  if (signal.aborted) throw new MapViewportError();
  if (error) throw new MapViewportError(error.code === "MV403" ? 403 : error.code === "MV409" ? 409 : error.code === "MV404" ? 404 : 503);
  const result = projectSourceViewport(data, input);
  if (signal.aborted) throw new MapViewportError();
  return result;
}
