import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { IdSchema, ModeSchema, utf8Bytes } from "./contracts";
import { FeedbackObservationSchema } from "./feedback-contracts";
const id = IdSchema.transform(v => v.toLowerCase());
const inputSchema = z.strictObject({ incidentId: id, mode: ModeSchema, feedbackId: id,
  destination: z.literal("sentinel_internal_evaluation"), retentionPolicyRevision: id });
const messages = { AUTH_REQUIRED: "Sign in to access evaluation feedback.", SCOPE_DENIED: "Evaluation feedback is unavailable in your workspace.",
  INPUT_INVALID: "Evaluation feedback request is invalid.", STORAGE_UNAVAILABLE: "Evaluation feedback storage is unavailable." };
export class SentinelFeedbackError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "SentinelFeedbackError"; }
}
/** Internal evaluation input only. This function neither sends to a provider nor promotes a correction. */
export async function readFeedbackForEvaluation(input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new SentinelFeedbackError("INPUT_INVALID");
  try {
    const user = await getCurrentUser();
    if (!user) throw new SentinelFeedbackError("AUTH_REQUIRED");
    if (!user.organizationId || user.role !== "incident_commander") throw new SentinelFeedbackError("SCOPE_DENIED");
    const actorId = id.parse(user.id), organizationId = id.parse(user.organizationId), c = parsed.data;
    const db = getSupabaseAdminClient() as SupabaseClient | null;
    if (!db) throw new SentinelFeedbackError("STORAGE_UNAVAILABLE");
    const { data, error } = await db.rpc("sentinel_read_feedback_for_evaluation", { p_actor_id: actorId, p_organization_id: organizationId,
      p_incident_id: c.incidentId, p_mode: c.mode, p_feedback_id: c.feedbackId, p_destination: c.destination, p_retention_revision: c.retentionPolicyRevision });
    if (error) throw new SentinelFeedbackError(error.code === "42501" ? "SCOPE_DENIED" : error.code === "22023" ? "INPUT_INVALID" : "STORAGE_UNAVAILABLE");
    if (data === null) return null;
    if (utf8Bytes(JSON.stringify(data)) > 16384) throw new SentinelFeedbackError("STORAGE_UNAVAILABLE");
    const result = FeedbackObservationSchema.parse(data);
    if (result.id !== c.feedbackId || result.scope.organizationId !== organizationId || result.scope.incidentId !== c.incidentId ||
      result.scope.mode !== c.mode || result.permissionRecordId === null) throw new SentinelFeedbackError("STORAGE_UNAVAILABLE");
    return result;
  } catch (error) {
    if (error instanceof SentinelFeedbackError) throw error;
    throw new SentinelFeedbackError("STORAGE_UNAVAILABLE");
  }
}
