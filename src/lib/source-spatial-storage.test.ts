import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { unpackSourcePayload } from "./source-payload-storage";
import { decodeSourceSpatialChunk, packSpatialSourcePayload, readSourceSpatialIndex, SOURCE_SPATIAL_CHUNK_BYTES,
  spatialBoundsOverlap, validSpatialBounds, type SourceSpatialChunk, type SpatialBounds } from "./source-spatial-storage";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const box = (x: number, y = 35): SpatialBounds => [x, y, x + 0.01, y + 0.01];
function fixture(count = 200) {
  const bounds = Array.from({ length: count }, (_, i) => box(-122 + (i * 17 % 31) / 20, 35 + (i * 13 % 29) / 20));
  const features = bounds.map((b, i) => ({ id: `record-${i}`, name: `Road ${i}`, tags: { z: 1, a: 2 },
    paths: [[[b[0], b[1]], [b[2], b[3]]], [[b[0], b[3]], [b[2], b[1]]]] }));
  return { payload: { z: "metadata", features, a: { z: "retained", a: "retained" } }, bounds };
}
function packed(count = 200) { const f = fixture(count); return packSpatialSourcePayload(f.payload, "features", f.bounds); }
type Packed = ReturnType<typeof packed>;
function reseal(value: Packed) {
  const index = value.rawPayloadSpatial;
  index.hash = digest(JSON.stringify({ field: index.field, count: index.count, baseJson: index.baseJson,
    chunks: index.chunks.map(({ position, count, bounds, bytes, hash }) => ({ position, count, bounds, bytes, hash })) }));
}
function entries(chunk: SourceSpatialChunk) { return JSON.parse(gunzipSync(Buffer.from(chunk.gzip, "base64")).toString("utf8")); }
function replaceChunk(chunk: SourceSpatialChunk, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  chunk.bytes = bytes.length; chunk.hash = digest(bytes); chunk.gzip = gzipSync(bytes).toString("base64");
}

describe("lossless spatial source chunks", () => {
  it("restores original order, metadata and disconnected paths after spatial sorting", () => {
    const { payload, bounds } = fixture();
    const stored = packSpatialSourcePayload(payload, "features", bounds);
    const index = readSourceSpatialIndex(stored);
    const sortedPositions = index.chunks.flatMap(chunk => decodeSourceSpatialChunk(chunk, index.count).map(entry => entry.position));
    expect(sortedPositions).not.toEqual(Array.from({ length: bounds.length }, (_, i) => i));
    expect(JSON.stringify(unpackSourcePayload(stored))).toBe(JSON.stringify(payload));
    expect(index.chunks.every(chunk => chunk.count <= 64 && chunk.bytes <= SOURCE_SPATIAL_CHUNK_BYTES)).toBe(true);
  });

  it("survives actual PostgreSQL jsonb object-key normalization", async () => {
    const db = new PGlite();
    try {
      const stored = packed();
      const result = await db.query<{ value: Packed }>("select $1::jsonb as value", [JSON.stringify(stored)]);
      expect(JSON.stringify(result.rows[0].value)).not.toBe(JSON.stringify(stored));
      expect(unpackSourcePayload(result.rows[0].value)).toEqual(fixture().payload);
    } finally { await db.close(); }
  });

  it("preserves polygon holes and multipolygon members without simplification", () => {
    const ring = [[-122, 35], [-121, 35], [-121, 36], [-122, 36], [-122, 35]];
    const hole = [[-121.8, 35.2], [-121.8, 35.4], [-121.6, 35.4], [-121.6, 35.2], [-121.8, 35.2]];
    const payload = { basins: [{ id: "basin-a", geometry: { type: "MultiPolygon", coordinates: [[ring, hole], [ring]] } }], assessmentDate: "2026-01-01" };
    expect(unpackSourcePayload(packSpatialSourcePayload(payload, "basins", [[-122, 35, -121, 36]]))).toEqual(payload);
  });

  it("supports empty and degenerate-extent collections", () => {
    expect(unpackSourcePayload(packSpatialSourcePayload({ features: [], available: false }, "features", []))).toEqual({ features: [], available: false });
    const features = Array.from({ length: 200 }, (_, id) => ({ id }));
    const stored = packSpatialSourcePayload({ features }, "features", features.map(() => [0, 0, 0, 0]));
    expect(stored.rawPayloadSpatial.chunks.map(chunk => chunk.count)).toEqual([64, 64, 64, 8]);
    expect(unpackSourcePayload(stored)).toEqual({ features });
  });

  it("allows a feature above the target but never above the indivisible chunk limit", () => {
    const payload = { features: [{ text: "x".repeat(300_000) }] };
    expect(unpackSourcePayload(packSpatialSourcePayload(payload, "features", [box(-121)]))).toEqual(payload);
    expect(() => packSpatialSourcePayload({ features: [{ text: "x".repeat(SOURCE_SPATIAL_CHUNK_BYTES) }] }, "features", [box(-121)])).toThrow();
  });

  it("bounds base metadata, record counts and caller-supplied bounds", () => {
    expect(() => packSpatialSourcePayload({ features: [], extra: "x".repeat(1024 * 1024) }, "features", [])).toThrow();
    expect(() => packSpatialSourcePayload({ features: [1] }, "features", [])).toThrow();
    expect(() => packSpatialSourcePayload({ features: [1] }, "features", [[-190, 0, 0, 0]])).toThrow();
    expect(() => packSpatialSourcePayload({ features: Array(100_001).fill(1) }, "features", Array(100_001).fill(box(-121)))).toThrow();
  });

  it("enforces a shared decoded budget without debiting failed reads", () => {
    const stored = packed(), budget = { remaining: stored.rawPayloadBytes };
    expect(unpackSourcePayload(stored, budget)).toEqual(fixture().payload);
    expect(budget.remaining).toBe(0);
    expect(() => unpackSourcePayload(stored, budget)).toThrow();
    const failed = { remaining: stored.rawPayloadBytes };
    expect(() => unpackSourcePayload({ ...stored, rawPayloadHash: "0".repeat(64) }, failed)).toThrow();
    expect(failed.remaining).toBe(stored.rawPayloadBytes);
    expect(() => unpackSourcePayload(stored, { remaining: NaN })).toThrow();
  });

  it.each(["hash", "count", "position", "bytes", "bounds", "base", "field", "unknown-key"])("rejects index %s corruption before accepting coverage", field => {
    const stored = packed();
    const index = stored.rawPayloadSpatial;
    if (field === "hash") index.hash = "0".repeat(64);
    if (field === "count") index.count++;
    if (field === "position") index.chunks[0].position = 5;
    if (field === "bytes") index.chunks[0].bytes = 0;
    if (field === "bounds") index.chunks[0].bounds = [1, 1, 0, 0];
    if (field === "base") index.baseJson = "[]";
    if (field === "field") Object.assign(index, { field: "unsupported" });
    if (field === "unknown-key") Object.assign(index, { injected: true });
    expect(() => unpackSourcePayload(stored)).toThrow();
  });

  it.each(["gzip", "hash", "length", "bounds", "duplicate", "position", "unknown-key"])("rejects chunk %s corruption even with a resealed index", field => {
    const stored = packSpatialSourcePayload({ features: [{ id: 1 }, { id: 2 }] }, "features", [box(-121), box(-121)]);
    const chunk = stored.rawPayloadSpatial.chunks[0];
    if (field === "gzip") chunk.gzip = "bad encoding!";
    if (field === "hash") chunk.hash = "0".repeat(64);
    if (field === "length") chunk.bytes--;
    if (field === "bounds") chunk.bounds = box(-120);
    if (field === "duplicate" || field === "position" || field === "unknown-key") {
      const rows = entries(chunk);
      if (field === "duplicate") rows[1].position = rows[0].position;
      if (field === "position") rows[1].position = stored.rawPayloadSpatial.count;
      if (field === "unknown-key") rows[1].extra = true;
      replaceChunk(chunk, rows);
    }
    reseal(stored);
    expect(() => unpackSourcePayload(stored)).toThrow();
  });

  it("rejects repeated ordinals across otherwise valid chunks", () => {
    const stored = packed(2), chunk = stored.rawPayloadSpatial.chunks[1], rows = entries(chunk);
    rows[0].position = entries(stored.rawPayloadSpatial.chunks[0])[0].position;
    replaceChunk(chunk, rows); reseal(stored);
    expect(() => unpackSourcePayload(stored)).toThrow();
  });

  it("rejects missing records, recomputed record content and base metadata drift", () => {
    const missing = packed();
    missing.rawPayloadSpatial.chunks.pop(); reseal(missing);
    expect(() => unpackSourcePayload(missing)).toThrow();
    const changed = packed(), chunk = changed.rawPayloadSpatial.chunks[0], rows = entries(chunk);
    rows[0].record.name = "changed"; replaceChunk(chunk, rows); reseal(changed);
    expect(() => unpackSourcePayload(changed)).toThrow();
    const base = packed();
    base.rawPayloadSpatial.baseJson = base.rawPayloadSpatial.baseJson.replace("metadata", "modified"); reseal(base);
    expect(() => unpackSourcePayload(base)).toThrow();
  });

  it("bounds aggregate declared expansion before inflating any chunk", () => {
    const stored = packed();
    for (const chunk of stored.rawPayloadSpatial.chunks) { chunk.bytes = SOURCE_SPATIAL_CHUNK_BYTES; chunk.gzip = "not-gzip"; }
    reseal(stored);
    expect(() => readSourceSpatialIndex(stored)).toThrow(expect.objectContaining({ code: "read_budget" }));
  });

  it("bounds decompression even when bytes, counts and index hashes are plausible", () => {
    const stored = packed(1), chunk = stored.rawPayloadSpatial.chunks[0];
    chunk.gzip = gzipSync(Buffer.from("x".repeat(SOURCE_SPATIAL_CHUNK_BYTES * 2))).toString("base64");
    reseal(stored);
    expect(() => unpackSourcePayload(stored)).toThrow();
  });

  it("treats bbox overlap as candidate selection including boundary touches", () => {
    expect(spatialBoundsOverlap([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true);
    expect(spatialBoundsOverlap([0, 0, 1, 1], [1.01, 0, 2, 1])).toBe(false);
    expect(validSpatialBounds([-180, -90, 180, 90])).toBe(true);
    for (const value of [[], [0, 0, NaN, 1], [0, 0, Infinity, 1], [0, -91, 0, 0], [2, 0, 1, 0]]) expect(validSpatialBounds(value)).toBe(false);
  });
});
