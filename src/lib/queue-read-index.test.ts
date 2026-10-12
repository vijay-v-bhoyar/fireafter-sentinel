import { expect, it } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import { createQueueReadIndex, parseQueueReadIndex, queueReadPageIds, queueReadOrderedIds, type QueueOrderKey } from "./queue-read-index";
import { compareRecommendations } from "./recommendation-order";
import { createInventoryManifest, parseInventoryManifest } from "./inventory-manifest";

function key(n: number, change: Partial<QueueOrderKey> = {}): QueueOrderKey {
  return { id: `rec-${n}`, assetId: `asset-${n}`, assetName: `Bridge ${n}`, riskLevel: n % 3 ? "High" : "Unknown", score100: n % 101, ...change };
}
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function positions(value: string | null, count: number) {
  const bytes = value && gunzipSync(Buffer.from(value, "base64"));
  let prior = 0;
  return Array.from({ length: count }, (_, index) => { if (!bytes) return index; prior += bytes.readInt32LE(index * 4); return prior; });
}
function manifest(keys: QueueOrderKey[]) {
  return createInventoryManifest({ assetIds: [], sourceSnapshotIds: [], recommendationIds: keys.map((_, n) => id(n)), queueIndex: createQueueReadIndex(keys) });
}
it("separates current Unknown-first order from expired all-Unknown order without changing input", () => {
  const keys = [key(1, { score100: 95 }), key(2, { riskLevel: "Unknown", score100: 30 }), key(3, { riskLevel: "Low", score100: 10 })];
  const original = structuredClone(keys), index = createQueueReadIndex(keys);
  expect(positions(index.current, 3)).toEqual([1, 0, 2]); expect(index.expired).toBeNull(); expect(keys).toEqual(original);
});
it("uses the exact existing text and ID tie-breaks, not locale/provider order", () => {
  const keys = [key(9, { assetName: " z ", score100: 50 }), key(4, { assetName: "Alpha", score100: 50 }),
    key(2, { assetName: " alpha ", score100: 50 }), key(1, { assetId: "asset-2", assetName: " ALPHA", score100: 50 })];
  for (const state of ["current", "expired"] as const) {
    const index = createQueueReadIndex(keys);
    const expected = keys.map(row => state === "expired" ? { ...row, riskLevel: "Unknown" as const } : row).sort(compareRecommendations).map(row => row.id);
    expect(positions(index[state], keys.length).map(position => keys[position].id)).toEqual(expected);
  }
});
it("walks the full 100000-record order without omissions or duplicated IDs at page boundaries", () => {
  const keys = Array.from({ length: 100000 }, (_, n) => key(n));
  const value = manifest(keys), index = value.queueIndex!;
  for (const state of ["current", "expired"] as const) {
    const all: string[] = [];
    // Validate every index member, then test first/middle/end page selection independently.
    const order = positions(index[state], keys.length);
    expect(new Set(order).size).toBe(keys.length);
    for (let offset = 0; offset < keys.length; offset += 50) all.push(...order.slice(offset, offset + 50).map(position => value.recommendationIds[position]));
    const expected = keys.map(row => state === "expired" ? { ...row, riskLevel: "Unknown" as const } : row).sort(compareRecommendations)
      .map(row => id(Number(row.id.slice(4))));
    expect(all).toEqual(expected); expect(new Set(all).size).toBe(keys.length);
    for (const start of [0, 49975, 99975]) expect(queueReadPageIds(value, { revision: value.revision, state, start, limit: 50 })).toEqual(expected.slice(start, start + 50));
  }
  expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThan(600000);
});
it("accepts an empty index, but never infers order for legacy manifests", () => {
  const empty = manifest([]); expect(queueReadPageIds(empty, { revision: empty.revision, state: "current", start: 0, limit: 25 })).toEqual([]);
  const legacy = createInventoryManifest({ assetIds: [], recommendationIds: [id(1)], sourceSnapshotIds: [] });
  expect(parseInventoryManifest(legacy)).toEqual(legacy); expect(parseQueueReadIndex(undefined, 1)).toBeNull();
  expect(() => queueReadPageIds(legacy, { revision: legacy.revision, state: "current", start: 0, limit: 25 })).toThrow(/inventory/i);
});
it.each(["current", "expired"] as const)("decodes the complete %s scan in the same order as bounded pages", state => {
  const value = manifest(Array.from({ length: 157 }, (_, index) => key(index)));
  const paged = [];
  for (let start = 0; start < 157; start += 50) paged.push(...queueReadPageIds(value, { revision: value.revision, state, start, limit: 50 }));
  expect(queueReadOrderedIds(value, state)).toEqual(paged);
  const legacy = { ...value, queueIndex: undefined };
  expect(() => queueReadOrderedIds(legacy, state)).toThrow();
});
it.each([null, false, [], { version: "future" }, { scoringVersion: "" }, { scoringVersion: false }, { current: [0] }, { current: [0, 0] },
  { expired: [0, -1] }, { expired: [0, 2] }, { current: [0, 0.5] }, { current: [0, "1"] }, { extra: true }])("rejects corrupt index %j", change => {
  const value = manifest([key(1), key(2)]);
  const candidate = change && typeof change === "object" && !Array.isArray(change) ? { ...value.queueIndex, ...change } : change;
  expect(() => parseInventoryManifest({ ...value, queueIndex: candidate })).toThrow(/inventory/i);
});
it.each([{ start: -1 }, { start: 2 }, { start: 0.5 }, { limit: 0 }, { limit: 51 }, { revision: "other" }, { state: "bad" }])("rejects unsafe page query %j", change => {
  const value = manifest([key(1), key(2)]);
  expect(() => queueReadPageIds(value, { revision: value.revision, state: "current", start: 0, limit: 25, ...change } as Parameters<typeof queueReadPageIds>[1])).toThrow(/inventory/i);
});
it.each([{ id: "" }, { assetId: "" }, { assetName: null }, { score100: NaN }, { score100: Infinity }, { score100: -1 }, { score100: 101 }, { riskLevel: "bad" }])("does not certify malformed order key %j", change => {
  expect(() => createQueueReadIndex([key(1, change as Partial<QueueOrderKey>)])).toThrow(/inventory/i);
});
it("rejects duplicate domain identities and oversized inventories", () => {
  expect(() => createQueueReadIndex([key(1), key(1)])).toThrow(/inventory/i);
  expect(() => createQueueReadIndex(Array(100001).fill(key(1)))).toThrow(/inventory/i);
});
it("keeps old scoring metadata readable but refuses to reuse its current-risk order", () => {
  const value = manifest([key(1), key(2)]);
  value.queueIndex!.scoringVersion = "older-scoring-version";
  expect(parseInventoryManifest(value)).toEqual(value);
  expect(() => queueReadPageIds(value, { revision: value.revision, state: "current", start: 0, limit: 25 })).toThrow(/inventory/i);
  expect(queueReadPageIds(value, { revision: value.revision, state: "expired", start: 0, limit: 25 })).toEqual([id(1), id(0)]);
});
it.each(["duplicate", "range", "short", "long", "checksum", "oversize"])("rejects corrupt compressed positions: %s", defect => {
  const value = manifest([key(1), key(2)]), bytes = Buffer.alloc(defect === "short" ? 4 : defect === "long" ? 12 : 8);
  bytes.writeInt32LE(1); if (bytes.length >= 8) bytes.writeInt32LE(defect === "duplicate" ? 0 : defect === "range" ? 2 : -1, 4);
  const encoded = gzipSync(bytes); if (defect === "checksum") encoded[encoded.length - 5] ^= 255;
  expect(() => parseQueueReadIndex({ ...value.queueIndex, current: defect === "oversize" ? "A".repeat(600001) : encoded.toString("base64") }, 2)).toThrow(/inventory/i);
});
