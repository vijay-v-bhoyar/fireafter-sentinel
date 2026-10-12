import "server-only";
import { start } from "workflow/api";
import { ingestCounty } from "@/workflows/ingestion";
import { z } from "zod";
import { AuthError, type CurrentUser } from "./auth";
import { getIncidentAuthorizationContext } from "./fireafter-supabase";
import { createEmptyDashboardBundle } from "./fireafter-data";
import { createIncidentFromLocation } from "./fireafter-store";
import { searchLocationsLive } from "./live-sources";
import { ingestionRpc, publicIngestionStatus, type IngestionJob } from "./ingestion-store";

export async function dispatchIngestion(job: IngestionJob) {
  if (["completed", "failed"].includes(job.status)) return;
  if (!await ingestionRpc<boolean>("fireafter_dispatch_ingestion", { p_id: job.id })) return;
  // Only the opaque job id enters workflow history. Raw source data, user identity,
  // asset coordinates and service credentials stay in server-owned storage.
  await start(ingestCounty, [job.id]);
}

export async function enqueueIngestion(user: CurrentUser, kind: "create" | "refresh", target: string, operationId: string | null) {
  if (!user.organizationId || !["analyst", "incident_commander"].includes(user.role ?? "")) throw new AuthError("Organization membership required", 403);
  const parsed = z.uuid().safeParse(operationId);
  if (!parsed.success) throw new AuthError("A valid X-Ingestion-Operation-ID is required for safe recovery.", 400);
  let seed: IngestionJob["seed"];
  let incidentKey: string;
  let pendingIncident: IngestionJob["seed"]["incident"];
  if (kind === "create") {
    const candidates = await searchLocationsLive(target);
    const location = candidates.find(candidate => candidate.id === target);
    if (!location) throw new AuthError("County could not be resolved exactly. Search and select the county again.", 400);
    pendingIncident = createIncidentFromLocation(location);
    // County geometry can exceed the SQL seed limit. The worker resolves this
    // exact identity again and stores geometry in bounded checkpoints instead.
    seed = { location: { id: location.id, county: location.county, state: location.state, fips: location.fips } };
    incidentKey = pendingIncident.id;
  } else {
    const context = await getIncidentAuthorizationContext(target);
    if (!context || context.organizationId !== user.organizationId) throw new AuthError("Incident not found", 404);
    seed = { targetId: context.databaseIncidentId };
    incidentKey = context.domainIncidentId;
  }
  const job = await ingestionRpc<IngestionJob>("fireafter_enqueue_ingestion", {
    p_id: parsed.data, p_actor: user.id, p_org: user.organizationId, p_incident: incidentKey, p_kind: kind, p_seed: seed,
  });
  let dispatchPending = false;
  try { await dispatchIngestion(job); }
  catch {
    // The outbox record is already durable. Never report that creation rolled back.
    dispatchPending = true;
    console.warn("[fireafter] ingestion dispatch unconfirmed", { jobId: job.id });
  }
  const workspaceIncident = job.seed.incident ?? pendingIncident;
  const workspace = kind === "create" && workspaceIncident ? {
    ...createEmptyDashboardBundle(job.incident_key), incident: workspaceIncident,
    locations: workspaceIncident.locationContext ? [workspaceIncident.locationContext] : [],
    currentUser: user, sensitiveInfrastructureAccess: false, durableIngestionEnabled: true,
  } : undefined;
  return Response.json({ ingestion: publicIngestionStatus(job), dispatchPending, workspace }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
