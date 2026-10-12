import "server-only";
import { readBoundedRequestBody, requestBodyFailure } from "../request-limits";
import { isCrossOriginMutation } from "../request-origin";
import { SENTINEL_LIMITS } from "./contracts";
import { SentinelRunError } from "./runs";

export const runResponseHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export function runFailure(error: unknown) {
  const bodyFailure = requestBodyFailure(error, "Run request exceeds the supported size.");
  if (bodyFailure) return Response.json({ error: bodyFailure.message }, { status: bodyFailure.status, headers: runResponseHeaders });
  if (error instanceof SentinelRunError) {
    const status = error.code === "AUTH_REQUIRED" ? 401 : error.code === "SCOPE_DENIED" ? 403 : error.code === "INPUT_INVALID" ? 400
      : error.code === "BUDGET_STOPPED" ? 429 : error.code === "RUN_CONFLICT" || error.code === "RUN_BUSY" ? 409 : 503;
    return Response.json({ error: error.message, code: error.code }, { status, headers: runResponseHeaders });
  }
  return Response.json({ error: "Run storage is unavailable. Try again later.", code: "STORAGE_UNAVAILABLE" }, { status: 503, headers: runResponseHeaders });
}
export async function runMutationBody(request: Request) {
  if (isCrossOriginMutation(request)) return { response: Response.json({ error: "Cross-origin request rejected" }, { status: 403, headers: runResponseHeaders }) };
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { response: Response.json({ error: "Send an application/json request." }, { status: 415, headers: runResponseHeaders }) };
  }
  const bounded = await readBoundedRequestBody(request, SENTINEL_LIMITS.mutationBytes);
  try { return { body: await bounded.json() }; } catch { throw new SentinelRunError("INPUT_INVALID"); }
}
export function runLocatorFromUrl(request: Request, runId: string) {
  const params = new URL(request.url).searchParams;
  if (Array.from(params.keys()).some(key => !["incidentId", "mode"].includes(key)) || params.getAll("incidentId").length !== 1 || params.getAll("mode").length !== 1) {
    throw new SentinelRunError("INPUT_INVALID");
  }
  return { runId, incidentId: params.get("incidentId"), mode: params.get("mode") };
}
