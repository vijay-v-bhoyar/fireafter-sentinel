import "server-only";
import { z } from "zod";
import type { CurrentUser } from "./auth";
import { getIncidentAuthorizationContext } from "./fireafter-supabase";
import { getSupabaseAdminClient } from "./supabase";
import { canWriteOperationalRecords } from "./role-capabilities";
import { isNonOperationalAuditEventRecord, isNonOperationalResponderActionRecord } from "./non-operational-records";
import { redactFirmsProvenance } from "./source-link";
import { compareHistoryPosition, HISTORY_PAGE_BYTES, HISTORY_RECORD_BYTES, HistoryCursorSchema, HistoryError, HistoryPageSchema,
  HistoryQuerySchema, HistoryTimeSchema, HistoryRecordQuerySchema, HistoryRecordSchema, type HistoryRecordQuery, type HistoryQuery, type HistoryPage } from "./history-contract";

const positionSchema = z.object({ id: z.uuid(), created_at: HistoryTimeSchema, actor_id: z.uuid().nullable(), actor_name: z.string() });
const actionListSchema = positionSchema.extend({ action: z.enum(["accept", "modify", "reject", "annotate"]),
  command_reference: z.string().nullable(), recommendations: z.object({ incident_id: z.uuid() }) });
const auditListSchema = positionSchema.extend({ incident_id: z.uuid(), event_type: z.string().min(1).max(80), command_reference: z.string().nullable() });
const actionSchema = positionSchema.extend({
  recommendation_id: z.uuid(), action: z.enum(["accept", "modify", "reject", "annotate"]),
  note: z.string(), actor_name: z.string(), modified_priority: z.string().nullable(),
  recommendation_snapshot: z.record(z.string(), z.unknown()),
  recommendations: z.object({ incident_id: z.uuid() }),
});
const auditSchema = positionSchema.extend({
  incident_id: z.uuid(), recommendation_id: z.uuid().nullable(), event_type: z.string().min(1).max(80),
  actor_name: z.string(), summary: z.string(), payload: z.record(z.string(), z.unknown()),
});

export async function readHistoryPage(raw: HistoryQuery, user: CurrentUser) {
  const input = HistoryQuerySchema.parse(raw);
  if (!canWriteOperationalRecords(user) || !z.uuid().safeParse(user.id).success || !z.uuid().safeParse(user.organizationId).success) {
    throw new HistoryError(403, "Commander or analyst organization membership is required to read complete history.");
  }
  const limit = Number(input.limit);
  try {
    const client = getSupabaseAdminClient();
    if (!client) throw new HistoryError(503);
    const context = await getIncidentAuthorizationContext(input.incidentId);
    if (!context) throw new HistoryError(404, "Incident not found.");
    if (context.organizationId !== user.organizationId) throw new HistoryError(403, "Incident access denied.");
    let cursor: z.infer<typeof HistoryCursorSchema> | undefined;
    if (input.cursor) {
      try { cursor = HistoryCursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))); }
      catch { throw new HistoryError(400, "Invalid history cursor. Start again from Latest records."); }
      if (cursor.incidentId !== context.databaseIncidentId || cursor.lane !== input.lane || cursor.commandId !== (input.commandId ?? null)) {
        throw new HistoryError(400, "History cursor belongs to a different incident, stream, or command. Start again from Latest records.");
      }
    }
    const isAction = input.lane === "actions";
    let query = isAction
      ? client.from("responder_actions").select("id,action,actor_id,actor_name,created_at,command_reference:recommendation_snapshot->>domainActionId,recommendations!inner(incident_id)", { count: "exact" }).eq("recommendations.incident_id", context.databaseIncidentId)
      : client.from("audit_events").select("id,incident_id,event_type,actor_id,actor_name,created_at,command_reference:payload->>commandId", { count: "exact" }).eq("incident_id", context.databaseIncidentId);
    if (input.commandId) query = isAction
      ? query.like("recommendation_snapshot->>domainActionId", `action-command-%-${input.commandId}`)
      : query.eq("payload->>commandId", input.commandId);
    if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    const { data, error, count } = await query.order("created_at", { ascending: false }).order("id", { ascending: false })
      .limit(limit).abortSignal(AbortSignal.timeout(10_000)).retry(false);
    if (error) throw error;
    if (!Array.isArray(data) || !Number.isSafeInteger(count) || count === null || count < data.length || data.length > limit ||
      (count > 0 && data.length === 0) || Buffer.byteLength(JSON.stringify(data)) > HISTORY_PAGE_BYTES) throw new HistoryError(503);
    let previous = cursor;
    const ids = new Set<string>();
    const entries = data.flatMap<HistoryPage["entries"][number]>(value => {
      const row = positionSchema.parse(value);
      const position = { createdAt: row.created_at, id: row.id };
      if (ids.has(row.id) || (previous && compareHistoryPosition(position, previous) >= 0)) throw new HistoryError(503);
      ids.add(row.id);
      previous = { ...position, version: 1, incidentId: context.databaseIncidentId, lane: input.lane, commandId: input.commandId ?? null };
      if (isAction) {
        const action = actionListSchema.parse(value);
        if (action.recommendations.incident_id !== context.databaseIncidentId) throw new HistoryError(503);
        if (input.commandId && (!action.actor_id || action.command_reference !== `action-command-${action.actor_id}-${input.commandId}`)) throw new HistoryError(503);
        return [{ ...position, type: action.action, actorId: action.actor_id, actorName: action.actor_name, summary: "Recorded responder decision" }];
      }
      const audit = auditListSchema.parse(value);
      if (audit.incident_id !== context.databaseIncidentId || (input.commandId && audit.command_reference !== input.commandId)) throw new HistoryError(503);
      return [{ ...position, type: audit.event_type, actorId: audit.actor_id, actorName: audit.actor_name, summary: "Recorded audit event" }];
    });
    // Do not publish service-read history after an observed ownership/alias change.
    const after = await getIncidentAuthorizationContext(input.incidentId);
    if (!after || after.databaseIncidentId !== context.databaseIncidentId || after.domainIncidentId !== context.domainIncidentId || after.organizationId !== user.organizationId) {
      throw new HistoryError(403, "Incident authority changed. Reload and verify your access.");
    }
    const nextCursor = count > data.length && previous ? Buffer.from(JSON.stringify(previous)).toString("base64url") : null;
    const result = HistoryPageSchema.parse(redactFirmsProvenance({ incidentId: input.incidentId,
      databaseIncidentId: context.databaseIncidentId, canonicalIncidentId: context.domainIncidentId, lane: input.lane,
      commandId: input.commandId ?? null, limit, entries, nextCursor }));
    if (Buffer.byteLength(JSON.stringify(result)) > HISTORY_PAGE_BYTES) throw new HistoryError(503);
    console.info("[fireafter] history page read", { operation: "history_read", lane: input.lane, records: entries.length });
    return result;
  } catch (error) {
    console.warn("[fireafter] history page unavailable", { operation: "history_read", lane: input.lane, status: error instanceof HistoryError ? error.status : 503 });
    throw error instanceof HistoryError ? error : new HistoryError(503);
  }
}

export async function readHistoryRecord(raw: HistoryRecordQuery, user: CurrentUser) {
  const input = HistoryRecordQuerySchema.parse(raw);
  if (!canWriteOperationalRecords(user) || !z.uuid().safeParse(user.id).success || !z.uuid().safeParse(user.organizationId).success) throw new HistoryError(403, "History access denied.");
  try {
    const client = getSupabaseAdminClient();
    if (!client) throw new HistoryError(503);
    const context = await getIncidentAuthorizationContext(input.incidentId);
    if (!context) throw new HistoryError(404, "Incident not found.");
    if (context.organizationId !== user.organizationId) throw new HistoryError(403, "Incident access denied.");
    const action = input.lane === "actions";
    const query = action
      ? client.from("responder_actions").select("id,recommendation_id,action,note,actor_id,actor_name,modified_priority,recommendation_snapshot,created_at,recommendations!inner(incident_id)").eq("recommendations.incident_id", context.databaseIncidentId)
      : client.from("audit_events").select("id,incident_id,recommendation_id,event_type,actor_id,actor_name,summary,payload,created_at").eq("incident_id", context.databaseIncidentId);
    const { data, error } = await query.eq("id", input.recordId).abortSignal(AbortSignal.timeout(10_000)).retry(false).maybeSingle();
    if (error) throw error;
    if (!data) throw new HistoryError(404, "Retained record not found in this incident.");
    let record;
    if (action) {
      const row = actionSchema.parse(data);
      if (row.recommendations.incident_id !== context.databaseIncidentId || row.id !== input.recordId) throw new HistoryError(503);
      record = { id: row.id, createdAt: row.created_at, type: row.action, actorId: row.actor_id, actorName: row.actor_name,
        summary: "Recorded responder decision", provenanceFlag: isNonOperationalResponderActionRecord(row),
        details: { recommendationId: row.recommendation_id, action: row.action, note: row.note, modifiedPriority: row.modified_priority, recommendationSnapshot: row.recommendation_snapshot } };
    } else {
      const row = auditSchema.parse(data);
      if (row.incident_id !== context.databaseIncidentId || row.id !== input.recordId) throw new HistoryError(503);
      record = { id: row.id, createdAt: row.created_at, type: row.event_type, actorId: row.actor_id, actorName: row.actor_name,
        summary: row.summary, provenanceFlag: isNonOperationalAuditEventRecord(row), details: { recommendationId: row.recommendation_id, payload: row.payload } };
    }
    const after = await getIncidentAuthorizationContext(input.incidentId);
    if (!after || after.databaseIncidentId !== context.databaseIncidentId || after.domainIncidentId !== context.domainIncidentId || after.organizationId !== user.organizationId) throw new HistoryError(403, "Incident authority changed. Reload and verify your access.");
    const result = HistoryRecordSchema.parse(redactFirmsProvenance({ incidentId: input.incidentId, databaseIncidentId: context.databaseIncidentId,
      canonicalIncidentId: context.domainIncidentId, lane: input.lane, record }));
    if (Buffer.byteLength(JSON.stringify(result)) > HISTORY_RECORD_BYTES) throw new HistoryError(413, "This retained record exceeds the bounded evidence reader. Ask your operator for an authorized database export; other history pages remain accessible.");
    console.info("[fireafter] history evidence read", { operation: "history_record", lane: input.lane });
    return result;
  } catch (error) {
    console.warn("[fireafter] history evidence unavailable", { operation: "history_record", lane: input.lane, status: error instanceof HistoryError ? error.status : 503 });
    throw error instanceof HistoryError ? error : new HistoryError(503);
  }
}
