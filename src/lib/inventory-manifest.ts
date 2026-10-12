import { randomUUID } from "node:crypto";
import { InventoryCapacityError } from "./inventory-error";
import { parseQueueReadIndex, type QueueReadIndex } from "./queue-read-index";

const INVENTORY_VERSION = "2026-09-13-inventory-v1";
const MAX_INVENTORY_ROWS = 100_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type InventoryManifest = {
  version: typeof INVENTORY_VERSION;
  revision: string;
  assetIds: string[];
  recommendationIds: string[];
  sourceSnapshotIds: string[];
  queueIndex?: QueueReadIndex;
  sourceQueueVersion?: string;
};

export function createInventoryManifest(ids: Pick<InventoryManifest, "assetIds" | "recommendationIds" | "sourceSnapshotIds" | "queueIndex" | "sourceQueueVersion">): InventoryManifest {
  return parseInventoryManifest({ ...ids, version: INVENTORY_VERSION, revision: randomUUID() })!;
}

export function parseInventoryManifest(value: unknown): InventoryManifest | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InventoryCapacityError("read_invalid");
  const record = value as Record<string, unknown>;
  if (record.version !== INVENTORY_VERSION || typeof record.revision !== "string" || !uuid.test(record.revision)) {
    throw new InventoryCapacityError("read_invalid");
  }
  for (const key of ["assetIds", "recommendationIds", "sourceSnapshotIds"] as const) {
    const ids = record[key];
    if (!Array.isArray(ids) || ids.length > MAX_INVENTORY_ROWS ||
      ids.some((id) => typeof id !== "string" || !uuid.test(id)) ||
      new Set(ids.map((id: string) => id.toLowerCase())).size !== ids.length) {
      throw new InventoryCapacityError("read_invalid");
    }
  }
  parseQueueReadIndex(record.queueIndex, (record.recommendationIds as string[]).length);
  if (record.sourceQueueVersion !== undefined && (typeof record.sourceQueueVersion !== "string" || !record.sourceQueueVersion || record.sourceQueueVersion.length > 128)) throw new InventoryCapacityError("read_invalid");
  return record as InventoryManifest;
}

export function selectInventoryRows<T extends { id: string; incident_id: string }>(rows: T[], ids: string[], incidentId: string): T[] {
  const expected = new Set(ids.map((id) => id.toLowerCase()));
  const seen = new Set<string>();
  const current = rows.filter((row) => {
    if (typeof row.id !== "string" || !uuid.test(row.id)) throw new InventoryCapacityError("read_invalid");
    const id = row.id.toLowerCase();
    if (!expected.has(id)) return false;
    if (seen.has(id) || row.incident_id !== incidentId) throw new InventoryCapacityError("read_invalid");
    seen.add(id);
    return true;
  });
  if (seen.size !== expected.size) throw new InventoryCapacityError("read_invalid");
  return current;
}
