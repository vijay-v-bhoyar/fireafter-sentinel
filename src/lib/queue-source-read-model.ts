import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { InventoryCapacityError } from "./inventory-error";
import type { SourceSnapshot } from "./types";

// Bump when source interpretation or freshness inputs change. Not a raw-geometry proof.
export const QUEUE_SOURCE_VERSION = "2026-10-08-queue-source-v1";
export const QUEUE_SOURCE_MODEL_BYTES = 256 * 1024;
export class QueueSourceReadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const columns = ["id", "incident_id", "source_key", "source_url", "source_name", "fetched_at", "source_updated_at", "status", "stale", "freshness_label", "coverage_status", "warnings"] as const;
const metadata = ["domainSourceId", "domainIncidentId", "sourceKey", "detail", "sourceTimeBasis", "validUntil", "warnings", "rawPayloadEncoding", "rawPayloadHash", "rawPayloadBytes", "rawPayload"] as const;
export const QUEUE_SOURCE_SELECT = [...columns, ...metadata.map(key => `meta_${key}:raw_payload->${key}`), "queue_read:raw_payload->queueReadModel"].join(",");

const dateRecord = z.object({ assessmentDate: z.string() }).strict();
const sourceSchema = z.object({
  id: z.string().min(1), incidentId: z.string().min(1), sourceKey: z.string().optional(), sourceUrl: z.string().optional(),
  sourceName: z.string(), fetchedAt: z.string(), sourceUpdatedAt: z.string(), sourceTimeBasis: z.enum(["provider", "retrieval", "unknown"]),
  validUntil: z.string().optional(), status: z.enum(["online", "delayed", "offline"]), stale: z.boolean(), freshnessLabel: z.string(),
  detail: z.string(), coverageStatus: z.enum(["available", "partial", "not_available", "stale", "error"]).optional(), warnings: z.array(z.string()),
  rawPayload: z.object({ interpretationVersion: z.string().optional(), analysisGeometryVersion: z.string().optional(), failureCode: z.string().optional(),
    assessment: dateRecord.optional(), basins: z.array(dateRecord).max(2).nullable().optional() }).strict(),
}).strict();
const modelSchema = z.object({ version: z.literal(QUEUE_SOURCE_VERSION), sourceRowId: z.uuid(), incidentRowId: z.uuid(),
  metadataHash: z.string().regex(/^[a-f0-9]{64}$/), projectionHash: z.string().regex(/^[a-f0-9]{64}$/), source: sourceSchema.nullable() }).strict();
type SourceRow = Record<string, unknown> & { id: string; incident_id: string; raw_payload: Record<string, unknown> };
export type QueueSourceProjection = Record<string, unknown> & { id: string; incident_id: string; queue_read: unknown };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value ?? null;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest("hex");
function metadataHash(row: QueueSourceProjection) {
  const values = Object.fromEntries([...columns, ...metadata.map(key => `meta_${key}`)].map(key => {
    const value = row[key];
    // PostgreSQL normalizes timestamptz spelling, not its value.
    const date = ["fetched_at", "source_updated_at"].includes(key) && typeof value === "string" ? Date.parse(value) : NaN;
    return [key, Number.isFinite(date) ? new Date(date).toISOString() : value ?? null];
  }));
  return hash(values);
}

export function queueSourceProjection(row: SourceRow): QueueSourceProjection {
  return { ...Object.fromEntries(columns.map(key => [key, row[key] ?? null])),
    ...Object.fromEntries(metadata.map(key => [`meta_${key}`, row.raw_payload[key] ?? null])),
    id: row.id, incident_id: row.incident_id, queue_read: row.raw_payload.queueReadModel };
}

function dateValue(value: unknown) {
  const date = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).assessmentDate : undefined;
  return typeof date === "string" ? date : "";
}
function freshnessPayload(raw: Record<string, unknown> = {}) {
  const result: z.infer<typeof sourceSchema>["rawPayload"] = {};
  for (const key of ["interpretationVersion", "analysisGeometryVersion", "failureCode"] as const) {
    if (typeof raw[key] === "string") result[key] = raw[key];
  }
  if ("assessment" in raw) result.assessment = { assessmentDate: dateValue(raw.assessment) };
  if ("basins" in raw) {
    if (!Array.isArray(raw.basins)) result.basins = null;
    else {
      const dates = raw.basins.map(value => Date.parse(dateValue(value)));
      // The freshness rule checks all dates for validity and future publication.
      // Min/max retain that result at every evaluation time; invalidity stays explicit.
      result.basins = dates.some(value => !Number.isFinite(value)) ? [{ assessmentDate: "" }]
        : dates.length ? [{ assessmentDate: new Date(dates.reduce((a, b) => Math.min(a, b))).toISOString() },
          { assessmentDate: new Date(dates.reduce((a, b) => Math.max(a, b))).toISOString() }] : [];
    }
  }
  return result;
}

/** Source must come from the full persisted-row mapper and provenance gate. */
export function createQueueSourceReadModel(row: SourceRow, source: SourceSnapshot | null) {
  const value = { version: QUEUE_SOURCE_VERSION, sourceRowId: row.id, incidentRowId: row.incident_id,
    metadataHash: metadataHash(queueSourceProjection(row)), source: source && {
      id: source.id, incidentId: source.incidentId, sourceKey: source.sourceKey, sourceUrl: source.sourceUrl, sourceName: source.sourceName,
      fetchedAt: source.fetchedAt, sourceUpdatedAt: source.sourceUpdatedAt, sourceTimeBasis: source.sourceTimeBasis ?? "unknown", validUntil: source.validUntil,
      status: source.status, stale: source.stale, freshnessLabel: source.freshnessLabel, detail: source.detail,
      coverageStatus: source.coverageStatus, warnings: source.warnings ?? [], rawPayload: freshnessPayload(source.rawPayload),
    } };
  const model = { ...value, projectionHash: hash(value.source) };
  if (Buffer.byteLength(JSON.stringify(model)) > QUEUE_SOURCE_MODEL_BYTES) throw new InventoryCapacityError("read_budget");
  const parsed = modelSchema.safeParse(model);
  if (!parsed.success) throw new InventoryCapacityError("read_invalid");
  return parsed.data;
}

export function readQueueSourceModel(row: QueueSourceProjection): SourceSnapshot | null {
  if (Buffer.byteLength(JSON.stringify(row.queue_read ?? null)) > QUEUE_SOURCE_MODEL_BYTES) throw new InventoryCapacityError("read_budget");
  const parsed = modelSchema.safeParse(row.queue_read);
  if (!parsed.success || parsed.data.sourceRowId !== row.id || parsed.data.incidentRowId !== row.incident_id ||
    parsed.data.metadataHash !== metadataHash(row) || parsed.data.projectionHash !== hash(parsed.data.source)) throw new InventoryCapacityError("read_unverified");
  return parsed.data.source;
}
