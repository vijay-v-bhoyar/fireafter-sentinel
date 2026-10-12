import "server-only";
import { createHash } from "node:crypto";
import { projectUploadedAsset, type ImportValidationBudget } from "./asset-import-validation";
import { buildSupabasePayload, type PublicationProjectionOptions } from "./fireafter-supabase";
import { validateBundleWrite, type BundleWrite } from "./bundle-write";
import type { runLiveSourceRefresh } from "./live-sources";
import type { AuditEvent } from "./types";

export function prepareIngestionPayload(jobId: string, phase: "initial" | "final",
  derived: Awaited<ReturnType<typeof runLiveSourceRefresh>>, context: BundleWrite, now = new Date(),
  budget: ImportValidationBudget = { vertices: 0, comparisons: 0 }, publication?: PublicationProjectionOptions) {
  const write = validateBundleWrite(context);
  const assets = derived.assets.map(asset => projectUploadedAsset(asset, derived.incident, budget));
  const event: AuditEvent = {
    id: `ingestion-${createHash("sha256").update(`${jobId}:${phase}`).digest("hex")}`,
    incidentId: derived.incident.id, eventType: write.operation === "create" ? "IncidentCreated" : "SourcesRefreshed",
    actorName: "Authenticated responder", createdAt: now.toISOString(),
    summary: phase === "initial" ? "Published initial evidence; additional sources and terrain are processing." : "Completed checkpointed county evidence refresh.",
    payload: { ingestionOperationId: jobId, phase },
  };
  const auditEvents: AuditEvent[] = write.operation === "create"
    ? [event, { ...event, id: `${event.id}-sources`, eventType: "SourcesRefreshed" }]
    : [event];
  const payload = buildSupabasePayload(derived, { write, assets, actions: [], auditEvents, publication });
  if (!derived.sourceSnapshots.length) payload.incident.last_refresh = now.toISOString();
  // Match the existing persistence boundary exactly, including actor and revision
  // attribution checked by fireafter_commit_bundle inside the final transaction.
  payload.auditEvents = payload.auditEvents.map(event => ({ ...event, actor_id: write.actorId,
    payload: { ...event.payload, actorId: write.actorId, operation: write.operation, expectedRevision: write.expectedRevision } }));
  return { ...payload, write };
}
