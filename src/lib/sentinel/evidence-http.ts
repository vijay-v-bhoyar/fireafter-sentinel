import "server-only";
import { z } from "zod";
import { IdSchema, ModeSchema, SENTINEL_LIMITS } from "./contracts";
import { SentinelSourceError } from "./sources";
import { SentinelReadError } from "./store";

export const evidenceResponseHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
const CanonicalIdSchema = IdSchema.transform(value => value.toLowerCase());
const CursorSchema = z.strictObject({ v: z.literal(1), incidentId: CanonicalIdSchema, mode: ModeSchema,
  afterGeneration: z.number().int().positive().safe() });

/** Cursor carries pagination position, never authority. Current session/SQL determine organization access. */
export function encodeSourceChangeCursor(incidentId: string, mode: string, afterGeneration: number) {
  const cursor = CursorSchema.parse({ v: 1, incidentId, mode, afterGeneration });
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
export function evidenceLocatorFromUrl(request: Request, withCursor = false) {
  const params = new URL(request.url).searchParams;
  const allowed = withCursor ? ["incidentId", "mode", "cursor"] : ["incidentId", "mode"];
  if (Array.from(params.keys()).some(key => !allowed.includes(key)) || params.getAll("incidentId").length !== 1 ||
      params.getAll("mode").length !== 1 || params.getAll("cursor").length > (withCursor ? 1 : 0)) {
    throw new SentinelSourceError("INPUT_INVALID");
  }
  const locator = z.strictObject({ incidentId: CanonicalIdSchema, mode: ModeSchema }).safeParse({ incidentId: params.get("incidentId"), mode: params.get("mode") });
  if (!locator.success) throw new SentinelSourceError("INPUT_INVALID");
  const token = params.get("cursor");
  if (token === null) return { ...locator.data, afterGeneration: 0 };
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) throw new Error("Invalid cursor encoding");
    const cursor = CursorSchema.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    if (encodeSourceChangeCursor(cursor.incidentId, cursor.mode, cursor.afterGeneration) !== token ||
        cursor.incidentId !== locator.data.incidentId || cursor.mode !== locator.data.mode) throw new Error("Cursor scope mismatch");
    return { ...locator.data, afterGeneration: cursor.afterGeneration };
  } catch { throw new SentinelSourceError("INPUT_INVALID"); }
}
export function evidenceJson(value: unknown, status = 200) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > SENTINEL_LIMITS.providerResponseBytes) {
    throw new SentinelSourceError("STORAGE_UNAVAILABLE");
  }
  return new Response(serialized, { status, headers: { ...evidenceResponseHeaders, "Content-Type": "application/json; charset=utf-8" } });
}
export function evidenceUnavailable() {
  return evidenceJson({ error: "Evidence is unavailable in this workspace." }, 404);
}
export function evidenceFailure(error: unknown) {
  if (error instanceof SentinelSourceError || error instanceof SentinelReadError) {
    const status = error.code === "AUTH_REQUIRED" ? 401 : error.code === "SCOPE_DENIED" ? 403 : error.code === "INPUT_INVALID" ? 400
      : error.code === "SOURCE_CONFLICT" ? 409 : 503;
    return evidenceJson({ error: error.message, code: error.code }, status);
  }
  return evidenceJson({ error: "Evidence storage is unavailable. Try again later.", code: "STORAGE_UNAVAILABLE" }, 503);
}
