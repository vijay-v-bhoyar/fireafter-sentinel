import "server-only";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const MAX_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 384 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export type CheckpointManifest = { encoding: "gzip-json" | "base64-json"; bytes: number; hash: string; parts: number };

export function encodeCheckpoint(value: unknown, compress = true) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_BYTES) throw new Error("checkpoint_capacity");
  const stored = compress ? gzipSync(bytes) : bytes;
  const parts: { data: string }[] = [];
  for (let offset = 0; offset < stored.length; offset += CHUNK_BYTES) {
    parts.push({ data: stored.subarray(offset, offset + CHUNK_BYTES).toString("base64") });
  }
  const manifest: CheckpointManifest = { encoding: compress ? "gzip-json" : "base64-json", bytes: bytes.length, hash: hash(bytes), parts: parts.length };
  return { manifest, parts };
}

export function decodeCheckpoint<T>(manifest: CheckpointManifest, parts: { part: number; value: { data: string } }[]): T {
  if (!manifest || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_BYTES ||
    !Number.isSafeInteger(manifest.parts) || manifest.parts < 1 || manifest.parts > 1024 || parts.length !== manifest.parts ||
    !["gzip-json", "base64-json"].includes(manifest.encoding)) throw new Error("checkpoint_invalid");
  const buffers = parts.map((part, index) => {
    if (part.part !== index || typeof part.value.data !== "string" || part.value.data.length > CHUNK_BYTES * 4 / 3) throw new Error("checkpoint_invalid");
    const bytes = Buffer.from(part.value.data, "base64");
    if (bytes.toString("base64") !== part.value.data) throw new Error("checkpoint_invalid");
    return bytes;
  });
  const stored = Buffer.concat(buffers);
  const decoded = manifest.encoding === "gzip-json" ? gunzipSync(stored, { maxOutputLength: manifest.bytes }) : stored;
  if (decoded.length !== manifest.bytes || hash(decoded) !== manifest.hash) throw new Error("checkpoint_invalid");
  return JSON.parse(decoded.toString("utf8")) as T;
}
