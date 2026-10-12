import "server-only";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { InventoryCapacityError } from "./inventory-error";

export const SOURCE_SPATIAL_ENCODING = "gzip-spatial-json-v1";
export const SOURCE_SPATIAL_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_STORED_BYTES = 20 * 1024 * 1024;
const TARGET_CHUNK_BYTES = 256 * 1024;
const MAX_CHUNKS = 4096;
const MAX_BASE_BYTES = 1024 * 1024;
// Ordinal, four finite WGS84 numbers, field names and delimiters per record.
const MAX_ENTRY_OVERHEAD = 256;
export type SpatialBounds = [number, number, number, number];
type Entry = { position: number; bounds: SpatialBounds; record: unknown };
export type SourceSpatialChunk = { position: number; count: number; bounds: SpatialBounds; bytes: number; hash: string; gzip: string };
export type SourceSpatialIndex = { field: "features" | "basins"; count: number; baseJson: string; chunks: SourceSpatialChunk[]; hash: string };
export type SourceSpatialManifest = Omit<SourceSpatialIndex, "chunks"> & { chunks: Omit<SourceSpatialChunk, "gzip">[] };
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = (): never => { throw new InventoryCapacityError("read_invalid"); };
const capacity = (): never => { throw new InventoryCapacityError("read_budget"); };
export function validSpatialBounds(value: unknown): value is SpatialBounds {
  return Array.isArray(value) && value.length === 4 && value.every(x => typeof x === "number" && Number.isFinite(x)) &&
    value[0] >= -180 && value[2] <= 180 && value[1] >= -90 && value[3] <= 90 && value[0] <= value[2] && value[1] <= value[3];
}
export function spatialBoundsOverlap(a: SpatialBounds, b: SpatialBounds) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
function union(values: SpatialBounds[]): SpatialBounds {
  const first = [...values[0]] as SpatialBounds;
  for (const box of values.slice(1)) {
    first[0] = Math.min(first[0], box[0]); first[1] = Math.min(first[1], box[1]);
    first[2] = Math.max(first[2], box[2]); first[3] = Math.max(first[3], box[3]);
  }
  return first;
}
export function sourceSpatialChunkHeader(chunk: Omit<SourceSpatialChunk, "gzip">) {
  return { position: chunk.position, count: chunk.count, bounds: chunk.bounds, bytes: chunk.bytes, hash: chunk.hash };
}
function indexHash(index: Omit<SourceSpatialManifest, "hash">) {
  return digest(JSON.stringify({ field: index.field, count: index.count, baseJson: index.baseJson, chunks: index.chunks.map(sourceSpatialChunkHeader) }));
}
function readBase(index: Pick<SourceSpatialIndex, "field" | "baseJson">): Record<string, unknown> {
  let base: unknown;
  try { base = JSON.parse(index.baseJson); } catch { return invalid(); }
  if (!object(base) || !Array.isArray(base[index.field]) || (base[index.field] as unknown[]).length !== 0) return invalid();
  return base;
}

/** Lossless JSON-wire storage; callers must supply bounds from their complete geometry validator. */
export function packSpatialSourcePayload(payload: Record<string, unknown>, field: "features" | "basins", bounds: SpatialBounds[]) {
  const original = JSON.stringify(payload), size = Buffer.byteLength(original);
  if (size > MAX_BYTES) capacity();
  const wire = JSON.parse(original) as Record<string, unknown>, records = wire[field];
  if (!["features", "basins"].includes(field) || !Array.isArray(records) || records.length !== bounds.length || records.length > 100_000 || bounds.some(box => !validSpatialBounds(box))) return invalid();
  // A string survives jsonb key normalization while retaining the original wire order.
  const baseJson = JSON.stringify({ ...wire, [field]: [] });
  if (Buffer.byteLength(baseJson) > MAX_BASE_BYTES) capacity();
  const extent = bounds.length ? union(bounds) : [0, 0, 0, 0] as SpatialBounds;
  const bins = new Map<number, Entry[]>();
  for (const [position, record] of records.entries()) {
    const box = bounds[position];
    const x = Math.min(31, Math.floor(((box[0] + box[2]) / 2 - extent[0]) / Math.max(1e-12, extent[2] - extent[0]) * 32));
    const y = Math.min(31, Math.floor(((box[1] + box[3]) / 2 - extent[1]) / Math.max(1e-12, extent[3] - extent[1]) * 32));
    const key = y * 32 + x, bin = bins.get(key) ?? [];
    bin.push({ position, bounds: [...box], record }); bins.set(key, bin);
  }
  const chunks: SourceSpatialChunk[] = [];
  const flush = (entries: Entry[]) => {
    if (!entries.length) return;
    const bytes = Buffer.from(JSON.stringify(entries));
    if (bytes.length > SOURCE_SPATIAL_CHUNK_BYTES || chunks.length >= MAX_CHUNKS) capacity();
    chunks.push({ position: chunks.length, count: entries.length, bounds: union(entries.map(row => row.bounds)),
      bytes: bytes.length, hash: digest(bytes), gzip: gzipSync(bytes).toString("base64") });
  };
  for (const [, bin] of [...bins].sort(([a], [b]) => a - b)) {
    let page: Entry[] = [], pageBytes = 2;
    for (const entry of bin) {
      const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (page.length && (page.length === 64 || pageBytes + bytes > TARGET_CHUNK_BYTES)) { flush(page); page = []; pageBytes = 2; }
      page.push(entry); pageBytes += bytes;
    }
    flush(page);
  }
  const index = { field, count: records.length, baseJson, chunks };
  const stored = { rawPayloadEncoding: SOURCE_SPATIAL_ENCODING, rawPayloadBytes: size, rawPayloadHash: digest(original),
    rawPayloadSpatial: { ...index, hash: indexHash(index) } };
  if (Buffer.byteLength(JSON.stringify(stored)) > MAX_STORED_BYTES) capacity();
  return stored;
}

export function readSourceSpatialIndex(stored: Record<string, unknown>): SourceSpatialIndex {
  return readSpatialIndex(stored, true) as SourceSpatialIndex;
}
export function readSourceSpatialManifest(stored: Record<string, unknown>): SourceSpatialManifest {
  return readSpatialIndex(stored, false);
}
function readSpatialIndex(stored: Record<string, unknown>, withGzip: boolean): SourceSpatialManifest {
  const value = stored.rawPayloadSpatial;
  if (stored.rawPayloadEncoding !== SOURCE_SPATIAL_ENCODING || !integer(stored.rawPayloadBytes, 1, MAX_BYTES) || !hex(stored.rawPayloadHash) ||
    !object(value) || !exactKeys(value, ["field", "count", "baseJson", "chunks", "hash"]) ||
    !["features", "basins"].includes(String(value.field)) || !integer(value.count, 0, 100_000) || typeof value.baseJson !== "string" ||
    Buffer.byteLength(value.baseJson) > MAX_BASE_BYTES || Buffer.byteLength(value.baseJson) > stored.rawPayloadBytes ||
    !Array.isArray(value.chunks) || value.chunks.length > MAX_CHUNKS || !hex(value.hash)) return invalid();
  const index = value as SourceSpatialIndex;
  if (Buffer.byteLength(JSON.stringify({ rawPayloadEncoding: stored.rawPayloadEncoding, rawPayloadBytes: stored.rawPayloadBytes,
    rawPayloadHash: stored.rawPayloadHash, rawPayloadSpatial: value })) > (withGzip ? MAX_STORED_BYTES : 2 * 1024 * 1024)) capacity();
  readBase(index);
  for (const [position, chunk] of index.chunks.entries()) {
    if (!object(chunk) || !exactKeys(chunk, ["position", "count", "bounds", "bytes", "hash", ...(withGzip ? ["gzip"] : [])]) ||
      chunk.position !== position || !integer(chunk.count, 1, 64) || !validSpatialBounds(chunk.bounds) ||
      !integer(chunk.bytes, 2, SOURCE_SPATIAL_CHUNK_BYTES) || !hex(chunk.hash) ||
      (withGzip && (typeof chunk.gzip !== "string" || chunk.gzip.length > SOURCE_SPATIAL_CHUNK_BYTES * 2))) invalid();
  }
  if (index.chunks.reduce((sum, chunk) => sum + chunk.count, 0) !== index.count || indexHash(index) !== index.hash) invalid();
  // Check before the first inflate, including when individual chunk hashes are valid.
  if (index.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) >
    stored.rawPayloadBytes + index.count * MAX_ENTRY_OVERHEAD + index.chunks.length * 2) capacity();
  return index;
}

export function decodeSourceSpatialChunk(chunk: SourceSpatialChunk, total: number): Entry[] {
  try {
    if (!integer(total, 0, 100_000) || !integer(chunk.position, 0, MAX_CHUNKS - 1) || !integer(chunk.count, 1, 64) || !validSpatialBounds(chunk.bounds) ||
      !integer(chunk.bytes, 2, SOURCE_SPATIAL_CHUNK_BYTES) || !hex(chunk.hash) || typeof chunk.gzip !== "string" ||
      chunk.gzip.length > SOURCE_SPATIAL_CHUNK_BYTES * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.gzip)) invalid();
    const compressed = Buffer.from(chunk.gzip, "base64");
    if (compressed.toString("base64") !== chunk.gzip) invalid();
    const bytes = gunzipSync(compressed, { maxOutputLength: chunk.bytes });
    if (bytes.length !== chunk.bytes || digest(bytes) !== chunk.hash) invalid();
    const entries = JSON.parse(bytes.toString("utf8")) as Entry[];
    if (!Array.isArray(entries) || entries.length !== chunk.count || entries.some(entry => !object(entry) || !exactKeys(entry, ["position", "bounds", "record"]) ||
      !integer(entry.position, 0, total - 1) || !validSpatialBounds(entry.bounds) || !Object.hasOwn(entry, "record")) ||
      new Set(entries.map(entry => entry.position)).size !== entries.length ||
      JSON.stringify(union(entries.map(entry => entry.bounds))) !== JSON.stringify(chunk.bounds)) invalid();
    return entries;
  } catch { return invalid(); }
}

export function unpackSpatialSourcePayload(stored: Record<string, unknown>, budget: { remaining: number }) {
  const index = readSourceSpatialIndex(stored), size = stored.rawPayloadBytes as number;
  if (!integer(budget.remaining, 0, Number.MAX_SAFE_INTEGER)) invalid();
  if (size > budget.remaining) capacity();
  const records = new Array<unknown>(index.count), seen = new Set<number>();
  for (const chunk of index.chunks) for (const entry of decodeSourceSpatialChunk(chunk, index.count)) {
    if (seen.has(entry.position)) invalid();
    seen.add(entry.position); records[entry.position] = entry.record;
  }
  if (seen.size !== index.count) invalid();
  const result = { ...readBase(index), [index.field]: records }, serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) !== size || digest(serialized) !== stored.rawPayloadHash) invalid();
  budget.remaining -= size;
  return result;
}
