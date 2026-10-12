import "server-only";
import { SentinelPolicyError } from "./policies";
import { evidenceFailure, evidenceJson } from "./evidence-http";
import { runFailure } from "./run-http";
export function policyFailure(error: unknown, mutation = false) {
  if (error instanceof SentinelPolicyError) return evidenceJson({ error: error.message, code: error.code },
    error.code === "AUTH_REQUIRED" ? 401 : error.code === "SCOPE_DENIED" ? 403 : error.code === "INPUT_INVALID" ? 400 : error.code === "POLICY_CONFLICT" ? 409 : 503);
  const response = mutation ? runFailure(error) : evidenceFailure(error); response.headers.set("X-Content-Type-Options", "nosniff"); return response;
}
