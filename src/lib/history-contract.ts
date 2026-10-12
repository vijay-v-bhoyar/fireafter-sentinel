import { z } from "zod";

export const HISTORY_PAGE_BYTES = 2 * 1024 * 1024;
export const HISTORY_RECORD_BYTES = 8 * 1024 * 1024;
export const HISTORY_UNAVAILABLE = "History could not be read. Retry, or ask your operator to check database access and retained records. No records were changed.";
export const HistoryLaneSchema = z.enum(["actions", "audit"]);
export const HistoryQuerySchema = z.object({
  incidentId: z.string().min(1).max(256),
  lane: HistoryLaneSchema,
  limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).default("25"),
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional(),
  commandId: z.uuid().optional(),
}).strict();
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;
export const HistoryRecordQuerySchema = z.object({ incidentId: z.string().min(1).max(256), lane: HistoryLaneSchema, recordId: z.uuid() }).strict();
export type HistoryRecordQuery = z.infer<typeof HistoryRecordQuerySchema>;
export const HistoryTimeSchema = z.iso.datetime({ offset: true }).regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/);
export const HistoryCursorSchema = z.object({
  version: z.literal(1), incidentId: z.uuid(), lane: HistoryLaneSchema,
  commandId: z.uuid().nullable(), createdAt: HistoryTimeSchema, id: z.uuid(),
}).strict();
export const HistoryEntrySchema = z.object({
  id: z.uuid(), createdAt: HistoryTimeSchema, type: z.string().min(1).max(80),
  actorId: z.uuid().nullable(), actorName: z.string(), summary: z.string(),
}).strict();
export const HistoryPageSchema = z.object({
  incidentId: z.string().min(1).max(256), databaseIncidentId: z.uuid(), canonicalIncidentId: z.string().min(1).max(256),
  lane: HistoryLaneSchema, commandId: z.uuid().nullable(), limit: z.number().int().min(1).max(50),
  entries: z.array(HistoryEntrySchema).max(50),
  nextCursor: z.string().max(1024).regex(/^[A-Za-z0-9_-]+$/).nullable(),
}).strict();
export type HistoryPage = z.infer<typeof HistoryPageSchema>;
export const HistoryRecordSchema = HistoryPageSchema.pick({ incidentId: true, databaseIncidentId: true, canonicalIncidentId: true, lane: true }).extend({
  record: HistoryEntrySchema.extend({ details: z.record(z.string(), z.unknown()), provenanceFlag: z.boolean() }),
}).strict();
export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;
export class HistoryError extends Error {
  constructor(readonly status: number, message = HISTORY_UNAVAILABLE) { super(message); }
}

// Preserve PostgreSQL microseconds; JavaScript Date alone loses cursor precision.
export function historyTime(value: string) {
  const time = HistoryTimeSchema.parse(value);
  const fraction = time.match(/\.(\d+)/)?.[1] ?? "";
  if (fraction.length > 6) throw new HistoryError(503);
  return BigInt(Math.floor(Date.parse(time) / 1000)) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
}
export function compareHistoryPosition(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) {
  const delta = historyTime(a.createdAt) - historyTime(b.createdAt);
  return delta === BigInt(0) ? a.id.localeCompare(b.id) : delta > BigInt(0) ? 1 : -1;
}
