import "server-only";
import { z } from "zod";
import { InventoryCapacityError } from "./inventory-error";

export const COMPACT_REFRESH_TRANSPORT = "shared-refresh-rows-v1";
export const COMPACT_REFRESH_SECURITY_VERSION = "20261008190000";
export const COMPACT_REFRESH_EXPANDED_LIMIT = 768 * 1024 * 1024;
const PAGE_LIMIT = 8 * 1024 * 1024;
const record = z.record(z.string(), z.unknown());
const rows = z.array(record).max(500);
const envelope = z.object({
  format: z.literal(COMPACT_REFRESH_TRANSPORT), incidentId: z.uuid(),
  remaining: z.number().int().min(0).max(100_000),
  page: z.union([rows, z.object({ format: z.literal("shared-row-fields-v1"), shared: record, rows }).strict()]),
}).strict();
function size(value: unknown) {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { invalid(); }
  if (text === undefined) invalid();
  return Buffer.byteLength(text);
}
function invalid(): never { throw new InventoryCapacityError("read_invalid"); }
function capacity(): never { throw new InventoryCapacityError("read_budget"); }

export function decodeCompactRefreshPage(value: unknown, incidentId: string) {
  const bytes = size(value);
  if (bytes > PAGE_LIMIT) capacity();
  const parsed = envelope.safeParse(value);
  if (!parsed.success || parsed.data.incidentId !== incidentId) invalid();
  const { page, remaining } = parsed.data;
  let data: Record<string, unknown>[], expandedBytes = 2;
  if (Array.isArray(page)) { data = page; expandedBytes = size(page); }
  else {
    const keys = Object.keys(page.shared);
    if (!keys.length || !page.rows.length || keys.some(key => ["id", "incident_id", "asset_id"].includes(key))) invalid();
    const sharedBytes = size(page.shared);
    if (sharedBytes > 1024 * 1024) capacity();
    data = [];
    for (const row of page.rows) {
      if (keys.some(key => Object.hasOwn(row, key))) invalid();
      // Account for repeated fields before constructing the expanded array.
      expandedBytes += size(row) + sharedBytes - 2 + Number(Object.keys(row).length > 0) + Number(data.length > 0);
      if (expandedBytes > PAGE_LIMIT) capacity();
      data.push(Object.fromEntries([...Object.entries(page.shared), ...Object.entries(row)]));
    }
  }
  if (expandedBytes > PAGE_LIMIT) capacity();
  if (data.length > remaining || (remaining > 0 && !data.length)) invalid();
  return { data, count: remaining, bytes, expandedBytes };
}
