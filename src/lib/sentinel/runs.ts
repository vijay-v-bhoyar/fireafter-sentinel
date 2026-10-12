import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import {
  IdSchema, InstantSchema, ProviderReservationSchema, ProviderSettlementSchema, RunCancelSchema,
  RunCheckpointSchema, RunCommandResultSchema, RunCommandSchema, RunLeaseSchema,
  RunLocatorSchema, RunProjectionSchema, WorkerLeaseInputSchema, WorkerMutationSchema, type SentinelScope,
} from "./contracts";
import { assertEvidenceScope } from "./evidence";

type RunErrorCode = "AUTH_REQUIRED" | "SCOPE_DENIED" | "INPUT_INVALID" | "RUN_CONFLICT" | "RUN_BUSY" | "BUDGET_STOPPED" | "STORAGE_UNAVAILABLE";
const messages: Record<RunErrorCode, string> = {
  AUTH_REQUIRED: "Sign in to review this run.", SCOPE_DENIED: "This run is unavailable in your workspace.",
  INPUT_INVALID: "Run input is invalid or exceeds the supported bounds.",
  RUN_CONFLICT: "Run configuration, lease or command changed. Review its current status.",
  RUN_BUSY: "An incident run or provider request is already active. Review its current status.",
  BUDGET_STOPPED: "This run cannot fit another request within its reserved limits.",
  STORAGE_UNAVAILABLE: "Run storage is unavailable. Try again later.",
};
export class SentinelRunError extends Error {
  constructor(readonly code: RunErrorCode) { super(messages[code]); this.name = "SentinelRunError"; }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) throw new SentinelRunError("INPUT_INVALID");
  return value.data;
}
async function caller(write: boolean) {
  let user;
  try { user = await getCurrentUser(); } catch { throw new SentinelRunError("STORAGE_UNAVAILABLE"); }
  if (!user) throw new SentinelRunError("AUTH_REQUIRED");
  if (!user.organizationId || !user.role || !(write ? ["analyst", "incident_commander"] : ["viewer", "analyst", "incident_commander"]).includes(user.role)) {
    throw new SentinelRunError("SCOPE_DENIED");
  }
  return { id: user.id, organizationId: user.organizationId };
}
async function rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
  try {
    const db = getSupabaseAdminClient() as SupabaseClient | null; // Existing private target guard runs before SDK/network use.
    if (!db) throw new SentinelRunError("STORAGE_UNAVAILABLE");
    const { data, error } = await db.rpc(name, parameters);
    if (error) {
      const code: RunErrorCode = error.code === "42501" ? "SCOPE_DENIED" : error.code === "22023" ? "INPUT_INVALID"
        : ["40001", "23505"].includes(error.code) ? "RUN_CONFLICT" : error.code === "55P03" ? "RUN_BUSY"
          : error.code === "54000" ? "BUDGET_STOPPED" : "STORAGE_UNAVAILABLE";
      throw new SentinelRunError(code);
    }
    return data;
  } catch (error) {
    if (error instanceof SentinelRunError) throw error;
    throw new SentinelRunError("STORAGE_UNAVAILABLE");
  }
}
function storage<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SentinelRunError("STORAGE_UNAVAILABLE");
  return parsed.data;
}
function scopedParameters(scope: SentinelScope, runId?: string) {
  return { p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode, ...(runId ? { p_run_id: runId } : {}) };
}
function bindRun(run: z.infer<typeof RunProjectionSchema>, scope: SentinelScope, runId?: string) {
  try { assertEvidenceScope(run.scope, scope); } catch { throw new SentinelRunError("STORAGE_UNAVAILABLE"); }
  if (runId && run.id !== runId) throw new SentinelRunError("STORAGE_UNAVAILABLE");
  return run;
}

/** Local admission does not dispatch a provider or renew a replayed run's deadline. */
export async function admitRun(input: unknown) {
  const command = parse(RunCommandSchema, input), user = await caller(true);
  const scope = { organizationId: user.organizationId, incidentId: command.incidentId, mode: command.mode };
  const result = storage(RunCommandResultSchema, await rpc("sentinel_admit_run", {
    ...scopedParameters(scope), p_actor_id: user.id, p_config_id: command.sourceConfigRevision, p_command_id: command.commandId,
  }));
  bindRun(result.run, scope);
  if (result.run.createdBy !== user.id || result.run.sourceConfigRevision !== command.sourceConfigRevision ||
      result.receipt.kind !== "admit" || result.receipt.commandId !== command.commandId) throw new SentinelRunError("STORAGE_UNAVAILABLE");
  return result;
}
export async function readRun(input: unknown) {
  const locator = parse(RunLocatorSchema, input), user = await caller(false);
  const scope = { organizationId: user.organizationId, incidentId: locator.incidentId, mode: locator.mode };
  const result = await rpc("sentinel_read_run", { ...scopedParameters(scope, locator.runId), p_actor_id: user.id });
  return result === null ? null : bindRun(storage(RunProjectionSchema, result), scope, locator.runId);
}
export async function cancelRun(input: unknown) {
  const command = parse(RunCancelSchema, input), user = await caller(true);
  const scope = { organizationId: user.organizationId, incidentId: command.incidentId, mode: command.mode };
  const result = storage(RunCommandResultSchema, await rpc("sentinel_cancel_run", {
    ...scopedParameters(scope, command.runId), p_actor_id: user.id, p_command_id: command.commandId,
  }));
  bindRun(result.run, scope, command.runId);
  if (result.receipt.kind !== "cancel" || result.receipt.commandId !== command.commandId) throw new SentinelRunError("STORAGE_UNAVAILABLE");
  return result;
}

/** Private worker helpers: SQL loads the persisted run actor and rechecks their current membership. */
export async function acquireRunLease(input: unknown) {
  const worker = parse(WorkerLeaseInputSchema, input);
  const result = storage(RunLeaseSchema, await rpc("sentinel_acquire_run_lease", { ...scopedParameters(worker.scope, worker.runId), p_owner: worker.owner }));
  bindRun(result.run, worker.scope, worker.runId);
  if (result.owner !== worker.owner) throw new SentinelRunError("STORAGE_UNAVAILABLE");
  return result;
}
export async function renewRunLease(input: unknown) {
  const worker = parse(WorkerMutationSchema, input);
  const result = storage(RunLeaseSchema, await rpc("sentinel_renew_run_lease", {
    ...scopedParameters(worker.scope, worker.runId), p_owner: worker.owner, p_fence: worker.fence,
  }));
  bindRun(result.run, worker.scope, worker.runId);
  if (result.owner !== worker.owner || result.run.fence !== worker.fence) throw new SentinelRunError("STORAGE_UNAVAILABLE");
  return result;
}
export async function reserveProviderAttempt(input: unknown) {
  const attempt = parse(ProviderReservationSchema, input);
  const result = storage(z.strictObject({ attemptId: IdSchema, dispatchAllowed: z.boolean(), dispatchDeadline: InstantSchema }),
    await rpc("sentinel_reserve_provider_attempt", { ...scopedParameters(attempt.scope, attempt.runId), p_owner: attempt.owner, p_fence: attempt.fence,
      p_attempt_id: attempt.attemptId, p_stage: attempt.stage, p_kind: attempt.kind, p_input_tokens: attempt.inputTokens, p_output_tokens: attempt.outputTokens }));
  if (result.attemptId !== attempt.attemptId) throw new SentinelRunError("STORAGE_UNAVAILABLE");
  return result;
}
export async function settleProviderAttempt(input: unknown) {
  const attempt = parse(ProviderSettlementSchema, input);
  const result = storage(z.strictObject({ attemptId: IdSchema, state: z.enum(["completed", "uncertain"]) }),
    await rpc("sentinel_settle_provider_attempt", { ...scopedParameters(attempt.scope, attempt.runId), p_owner: attempt.owner, p_fence: attempt.fence,
      p_attempt_id: attempt.attemptId, p_state: attempt.state, p_input_tokens: attempt.inputTokens, p_output_tokens: attempt.outputTokens, p_response_bytes: attempt.responseBytes }));
  if (result.attemptId !== attempt.attemptId || result.state !== attempt.state) throw new SentinelRunError("STORAGE_UNAVAILABLE");
  return result;
}
export async function checkpointRun(input: unknown) {
  const checkpoint = parse(RunCheckpointSchema, input);
  const run = bindRun(storage(RunProjectionSchema, await rpc("sentinel_checkpoint_run", {
    ...scopedParameters(checkpoint.scope, checkpoint.runId), p_owner: checkpoint.owner, p_fence: checkpoint.fence,
    p_checkpoint_id: checkpoint.checkpointId, p_state: checkpoint.state, p_stage: checkpoint.stage, p_result_hash: checkpoint.resultHash,
  })), checkpoint.scope, checkpoint.runId);
  if (run.fence !== checkpoint.fence || !["retrieving", "interpreting", "validating"].includes(run.status)) throw new SentinelRunError("STORAGE_UNAVAILABLE");
  return run;
}
