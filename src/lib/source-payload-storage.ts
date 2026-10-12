import "server-only";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { InventoryCapacityError } from "./inventory-error";
import { SOURCE_SPATIAL_ENCODING, unpackSpatialSourcePayload } from "./source-spatial-storage";

const ENCODING = "gzip-json-v1";
const MAX_BYTES = 64 * 1024 * 1024;
const PACK_AFTER_BYTES = 256 * 1024;
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export const SOURCE_PAYLOAD_STORAGE_KEYS = ["rawPayloadEncoding", "rawPayloadGzip", "rawPayloadHash", "rawPayloadBytes", "rawPayloadSpatial"] as const;

export function packSourcePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > MAX_BYTES) throw new InventoryCapacityError("read_budget");
  if (bytes.length < PACK_AFTER_BYTES) return { rawPayload: payload };
  return {
    rawPayloadEncoding: ENCODING,
    rawPayloadBytes: bytes.length,
    rawPayloadHash: digest(bytes),
    rawPayloadGzip: gzipSync(bytes).toString("base64"),
  };
}

export function unpackSourcePayload(stored: Record<string, unknown>, budget = { remaining: MAX_BYTES }): Record<string, unknown> {
  if (stored.rawPayloadEncoding === SOURCE_SPATIAL_ENCODING) return unpackSpatialSourcePayload(stored, budget);
  if (stored.rawPayloadEncoding === undefined) {
    const raw = stored.rawPayload;
    const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const size = Buffer.byteLength(JSON.stringify(payload));
    if (size > budget.remaining) throw new InventoryCapacityError("read_budget");
    budget.remaining -= size;
    return payload;
  }
  try {
    const size = stored.rawPayloadBytes;
    const encoded = stored.rawPayloadGzip;
    if (stored.rawPayloadEncoding !== ENCODING || !Number.isSafeInteger(size) ||
      typeof size !== "number" || size < 1 || size > budget.remaining || size > MAX_BYTES ||
      typeof encoded !== "string" || encoded.length > MAX_BYTES * 2 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid source encoding");
    const compressed = Buffer.from(encoded, "base64");
    if (compressed.toString("base64") !== encoded) throw new Error("Invalid base64");
    const bytes = gunzipSync(compressed, { maxOutputLength: size });
    if (bytes.length !== size || digest(bytes) !== stored.rawPayloadHash) throw new Error("Source integrity mismatch");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid source object");
    budget.remaining -= size;
    return parsed as Record<string, unknown>;
  } catch {
    throw new InventoryCapacityError("read_invalid");
  }
}
