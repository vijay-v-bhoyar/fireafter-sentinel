import { createHash } from "node:crypto";
import { z } from "zod";

export const ACCOUNT_RECOVERY_VERSION = "20260914140000";
const uuid = z.uuid();
const receiptSchema = z.object({
  version: z.literal(ACCOUNT_RECOVERY_VERSION),
  attemptId: uuid, organizationId: uuid, emailHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestedRole: z.enum(["reviewer", "responder", "viewer"]),
  databaseRole: z.enum(["analyst", "incident_commander", "viewer"]),
  operatorIdentity: uuid,
  operatorUserId: uuid,
  operatorIdentitySource: z.literal("authenticated_supabase_user"),
  state: z.enum(["auth_pending", "membership_committed", "succeeded"]),
  userId: uuid.nullable(), created: z.boolean(), claimed: z.boolean(),
  startedAt: z.iso.datetime({ offset: true }), completedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict().refine(value => value.state === "auth_pending" || value.userId !== null)
  .refine(value => (value.state === "succeeded") === (value.completedAt !== null));

export function accountEmailHash(email) {
  return createHash("sha256").update(email).digest("hex");
}

export function validateAttemptId(value) {
  if (!uuid.safeParse(value).success) throw new Error("FIREAFTER_OPERATOR_ATTEMPT_ID must be an operator-known UUID. Preserve it for status/reconcile; never replace an uncertain attempt.");
  return value.toLowerCase();
}

export function validateOperatorUserId(value) {
  if (!uuid.safeParse(value).success) {
    throw new Error("Authenticated operator identity is missing or invalid. Sign in with the allowlisted operator account; never provide a caller-chosen identity.");
  }
  return value.toLowerCase();
}

export function assertReceiptBinding(receipt, account) {
  if (receipt.attemptId !== account.attemptId || receipt.organizationId !== account.organizationId ||
    receipt.emailHash !== accountEmailHash(account.email) || receipt.requestedRole !== account.requestedRole ||
    receipt.databaseRole !== account.databaseRole || receipt.operatorUserId !== account.operatorUserId ||
    receipt.operatorIdentity !== account.operatorUserId || receipt.operatorIdentitySource !== "authenticated_supabase_user") {
    throw new Error("Issuance reference belongs to a different request. Restore the original account, organization, role and operator metadata; do not dispatch a replacement.");
  }
}

export async function issuanceRpc(supabase, name, args) {
  try {
    const { data, error } = await supabase.rpc(name, args).abortSignal(AbortSignal.timeout(20_000)).retry(false);
    if (error) throw error;
    return receiptSchema.parse(data);
  } catch {
    throw new Error("Issuance coordinator outcome is unavailable or conflicting. Verify migration 20260914140000 and inspect this attempt with status/reconcile; Auth or membership may already have changed. Do not create a replacement attempt.");
  }
}

export async function getOperatorAccountIssuance({ supabase, attemptId }) {
  attemptId = validateAttemptId(attemptId);
  const receipt = await issuanceRpc(supabase, "fireafter_get_account_issuance_as_operator", { p_attempt_id: attemptId });
  if (receipt.attemptId !== attemptId || receipt.claimed) throw new Error("Issuance status identity is invalid; stop and inspect the coordinator.");
  return receipt;
}

// All CLI HTTP exchanges share this operation deadline, including body reads.
export function createOperatorFetch(fetchImpl = fetch, deadline = AbortSignal.timeout(60_000)) {
  return async (input, init) => {
    const signal = AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]);
    const response = await fetchImpl(input, { ...init, signal });
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks = [];
    let bytes = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error("Operator response exceeds its byte budget.");
        chunks.push(value);
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers });
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
}
