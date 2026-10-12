import "server-only";
import { getCurrentUser } from "./auth";
import { getClientDashboardBundle, createEmptyDashboardBundle } from "./fireafter-data";
import { getSupabaseQueuePage } from "./fireafter-supabase";
import { canWriteOperationalRecords } from "./role-capabilities";
import { QueuePageError } from "./queue-page-contract";
import { QueueSourceReadError } from "./queue-source-read-model";
import { evidenceMaxAgeMinutes, projectBundleFreshness } from "./source-freshness";
import type { Bundle } from "@/components/fireafter-dashboard";

export async function getQueueDashboardBundle(incidentId?: string): Promise<Bundle> {
  return getPagedDashboardBundle(incidentId, false);
}

export async function getMapDashboardBundle(incidentId?: string): Promise<Bundle> {
  return getPagedDashboardBundle(incidentId, true);
}

async function getPagedDashboardBundle(incidentId: string | undefined, includeBoundary: boolean): Promise<Bundle> {
  const user = await getCurrentUser();
  // Existing public/readonly and legacy small-county behavior is unchanged.
  if (!user || !canWriteOperationalRecords(user)) return getClientDashboardBundle(incidentId);
  const id = incidentId ?? process.env.FIREAFTER_DEFAULT_INCIDENT_ID ?? "incident-utah-county-ut";
  try {
    const result = await getSupabaseQueuePage({ incidentId: id, start: "0", limit: "10" }, user);
    const after = await getCurrentUser();
    if (!after || after.id !== user.id || after.organizationId !== user.organizationId || after.role !== user.role) throw new QueuePageError(403);
    // Map SSR needs the validated boundary, not the full asset/recommendation inventory.
    const location = result.incident.locationContext ? { ...result.incident.locationContext } : undefined;
    if (location && !includeBoundary) delete location.boundary;
    const incident = { ...result.incident, locationContext: location };
    return {
      ...projectBundleFreshness({ incident, sourceSnapshots: result.sourceSnapshots,
        recommendations: result.page.items.flatMap(item => item.status === "available" ? [item.recommendation] : []) },
      new Date(result.page.evaluatedAt), evidenceMaxAgeMinutes()),
      locations: location ? [location] : [], assets: [], actions: [], auditEvents: [],
      queuePage: result.page, currentUser: after, sensitiveInfrastructureAccess: true,
      durableIngestionEnabled: process.env.FIREAFTER_DURABLE_REFRESH_ENABLED === "true",
      viewportMapEnabled: process.env.FIREAFTER_VIEWPORT_MAP_ENABLED === "true",
    };
  } catch (error) {
    if (error instanceof QueuePageError && error.code === "QP_LEGACY") return getClientDashboardBundle(incidentId);
    const status = error instanceof QueueSourceReadError || error instanceof QueuePageError ? error.status : undefined;
    const dataUnavailableReason = status === 404 ? "not-found" : status === 403 ? "access-denied" : undefined;
    // Do not retry an unavailable bounded read by downloading the complete inventory.
    return { ...createEmptyDashboardBundle(id), currentUser: await getCurrentUser(), sensitiveInfrastructureAccess: false, dataAvailability: "unavailable",
      dataUnavailableReason,
      durableIngestionEnabled: process.env.FIREAFTER_DURABLE_REFRESH_ENABLED === "true" };
  }
}
