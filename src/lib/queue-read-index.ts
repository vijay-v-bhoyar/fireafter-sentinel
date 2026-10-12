import { compareRecommendations } from "./recommendation-order";
import { gzipSync, gunzipSync } from "node:zlib";
import { SCORING_VERSION } from "./scoring";
import { InventoryCapacityError } from "./inventory-error";
import type { Recommendation } from "./types";

export const QUEUE_READ_INDEX_VERSION = "2026-10-08-queue-order-v1";
const MAX_ROWS = 100_000;
export type QueueOrderKey = Pick<Recommendation, "id" | "assetId" | "assetName" | "riskLevel" | "score100">;
export type QueueReadIndex = {
  version: typeof QUEUE_READ_INDEX_VERSION;
  scoringVersion: string;
  current: string | null;
  expired: string | null;
};

function encodePositions(positions: number[]) {
  if (positions.every((position, index) => position === index)) return null;
  const bytes = Buffer.alloc(positions.length * 4);
  // Sorted queues usually contain long runs; signed deltas compress without dropping positions.
  positions.forEach((position, index) => bytes.writeInt32LE(position - (positions[index - 1] ?? 0), index * 4));
  return gzipSync(bytes).toString("base64");
}

function decodePositions(value: unknown, count: number): number[] | null {
  if (value === null) return null;
  try {
    if (count === 0 || typeof value !== "string" || value.length > 600_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error();
    const encoded = Buffer.from(value, "base64");
    if (encoded.toString("base64") !== value) throw new Error();
    const bytes = gunzipSync(encoded, { maxOutputLength: count * 4 });
    if (bytes.length !== count * 4) throw new Error();
    let prior = 0;
    const positions = Array.from({ length: count }, (_, index) => { prior += bytes.readInt32LE(index * 4); return prior; });
    const seen = new Uint8Array(count);
    for (const position of positions) {
      if (position < 0 || position >= count || seen[position]) throw new Error();
      seen[position] = 1;
    }
    return positions;
  } catch { throw new InventoryCapacityError("read_invalid"); }
}

/** Positions refer to the manifest's existing recommendation IDs, never row order. */
export function createQueueReadIndex(keys: readonly QueueOrderKey[]): QueueReadIndex {
  if (keys.length > MAX_ROWS) throw new InventoryCapacityError("read_budget");
  const seen = new Set<string>();
  const items = keys.map((key, position) => {
    if (!key || typeof key.id !== "string" || !key.id || seen.has(key.id) ||
      typeof key.assetId !== "string" || !key.assetId || typeof key.assetName !== "string" ||
      !["Unknown", "Very High", "High", "Medium", "Low", "Very Low"].includes(key.riskLevel) ||
      !Number.isFinite(key.score100) || key.score100 < 0 || key.score100 > 100) throw new InventoryCapacityError("read_invalid");
    seen.add(key.id);
    return { key, position };
  });
  const current = [...items].sort((a, b) => compareRecommendations(a.key, b.key)).map(item => item.position);
  const expired = [...items].sort((a, b) => compareRecommendations(
    { ...a.key, riskLevel: "Unknown" }, { ...b.key, riskLevel: "Unknown" },
  )).map(item => item.position);
  return { version: QUEUE_READ_INDEX_VERSION, scoringVersion: SCORING_VERSION, current: encodePositions(current), expired: encodePositions(expired) };
}

export function parseQueueReadIndex(value: unknown, count: number): QueueReadIndex | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ROWS || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new InventoryCapacityError("read_invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== QUEUE_READ_INDEX_VERSION || typeof record.scoringVersion !== "string" || !record.scoringVersion || record.scoringVersion.length > 128 ||
    Object.keys(record).some(key => !["version", "scoringVersion", "current", "expired"].includes(key))) {
    throw new InventoryCapacityError("read_invalid");
  }
  for (const name of ["current", "expired"] as const) {
    decodePositions(record[name], count);
  }
  return record as QueueReadIndex;
}

export function queueReadPageIds(manifest: { revision: string; recommendationIds: string[]; queueIndex?: QueueReadIndex },
  query: { revision: string; state: "current" | "expired"; start: number; limit: number }) {
  if (query.revision !== manifest.revision) throw new InventoryCapacityError("read_generation");
  if (!["current", "expired"].includes(query.state) || !Number.isSafeInteger(query.start) || query.start < 0 ||
    !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50 ||
    (query.start !== 0 && query.start >= manifest.recommendationIds.length)) throw new InventoryCapacityError("read_invalid");
  const index = parseQueueReadIndex(manifest.queueIndex, manifest.recommendationIds.length);
  if (!index) throw new InventoryCapacityError("read_invalid");
  if (query.state === "current" && index.scoringVersion !== SCORING_VERSION) throw new InventoryCapacityError("read_unverified");
  const positions = decodePositions(index[query.state], manifest.recommendationIds.length);
  const end = Math.min(query.start + query.limit, manifest.recommendationIds.length);
  return Array.from({ length: end - query.start }, (_, offset) => manifest.recommendationIds[positions?.[query.start + offset] ?? query.start + offset]);
}

/** Decode once for a complete ordered scan, rather than once per exported page. */
export function queueReadOrderedIds(manifest: { recommendationIds: string[]; queueIndex?: QueueReadIndex }, state: "current" | "expired") {
  if (!["current", "expired"].includes(state)) throw new InventoryCapacityError("read_invalid");
  const index = parseQueueReadIndex(manifest.queueIndex, manifest.recommendationIds.length);
  if (!index || (state === "current" && index.scoringVersion !== SCORING_VERSION)) throw new InventoryCapacityError("read_unverified");
  const positions = decodePositions(index[state], manifest.recommendationIds.length);
  return positions ? positions.map(position => manifest.recommendationIds[position]) : [...manifest.recommendationIds];
}
