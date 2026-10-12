import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { IdSchema, ModeSchema } from "./contracts";
import { assertEvidenceScope, assertVersionIntegrity } from "./evidence";

export class SentinelReadError extends Error {
  constructor(readonly code: "AUTH_REQUIRED" | "SCOPE_DENIED" | "STORAGE_UNAVAILABLE") {
    super(code === "AUTH_REQUIRED" ? "Sign in to review this evidence."
      : code === "SCOPE_DENIED" ? "This evidence is unavailable in your workspace."
        : "Evidence storage is unavailable. Try again later.");
    this.name = "SentinelReadError";
  }
}

/** Actor/org are derived here, never accepted from request input. The RPC rechecks current membership. */
export async function readDocumentVersion(incidentId: string, mode: string, versionId: string) {
  const incident = IdSchema.parse(incidentId), version = IdSchema.parse(versionId), dataMode = ModeSchema.parse(mode);
  let user: Awaited<ReturnType<typeof getCurrentUser>>;
  try { user = await getCurrentUser(); } catch { throw new SentinelReadError("STORAGE_UNAVAILABLE"); }
  if (!user) throw new SentinelReadError("AUTH_REQUIRED");
  if (!user.organizationId || !user.role || !["viewer", "analyst", "incident_commander"].includes(user.role)) {
    throw new SentinelReadError("SCOPE_DENIED");
  }
  let db: SupabaseClient | null;
  try { db = getSupabaseAdminClient() as SupabaseClient | null; } catch { throw new SentinelReadError("STORAGE_UNAVAILABLE"); }
  if (!db) throw new SentinelReadError("STORAGE_UNAVAILABLE");
  const scope = { organizationId: user.organizationId, incidentId: incident, mode: dataMode };
  try {
    const { data, error } = await db.rpc("sentinel_read_document_version", {
      p_actor_id: user.id, p_organization_id: scope.organizationId, p_incident_id: incident, p_mode: dataMode, p_version_id: version,
    });
    if (error) throw new SentinelReadError(error.code === "42501" ? "SCOPE_DENIED" : "STORAGE_UNAVAILABLE");
    if (data === null) return null;
    const record = assertVersionIntegrity(data);
    assertEvidenceScope(record.scope, scope);
    if (record.id !== version) throw new SentinelReadError("STORAGE_UNAVAILABLE");
    return record;
  } catch (error) {
    if (error instanceof SentinelReadError) throw error;
    throw new SentinelReadError("STORAGE_UNAVAILABLE");
  }
}
