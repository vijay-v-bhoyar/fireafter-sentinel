import "server-only";
import { BundleWriteError } from "./bundle-write";
import { jsonbTextBytes } from "./ingestion-jsonb-size";

export const SHARED_ROW_ENCODING = "shared-row-fields-v1";
export type RowEncoding = typeof SHARED_ROW_ENCODING;
export type SharedRowPage = { format: RowEncoding; shared: Record<string, unknown>; rows: Record<string, unknown>[] };
export type StagedRowPage = unknown[] | SharedRowPage;
const reserved = new Set(["id", "incident_id", "asset_id"]);

/** Factor only exactly equal own fields; absence, null, false and zero remain distinct. */
export function encodeStagedRows(rows: unknown[], encoding?: RowEncoding): StagedRowPage {
  if (encoding === undefined) return rows;
  if (encoding !== SHARED_ROW_ENCODING || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new BundleWriteError("FB400");
  }
  if (rows.length < 2) return rows;
  const raw = JSON.stringify(rows);
  const values = JSON.parse(raw) as Record<string, unknown>[];
  const keys = Object.keys(values[0]).filter(key => {
    if (reserved.has(key)) return false;
    const reference = JSON.stringify(values[0][key]);
    return values.every(row => Object.hasOwn(row, key) && JSON.stringify(row[key]) === reference);
  });
  const shared = Object.fromEntries(keys.map(key => [key, values[0][key]]));
  if (!keys.length || jsonbTextBytes(JSON.stringify(shared)) > 1024 * 1024) return rows;
  const common = new Set(keys);
  const packed: SharedRowPage = { format: SHARED_ROW_ENCODING, shared,
    rows: values.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !common.has(key)))) };
  return jsonbTextBytes(JSON.stringify(packed)) < jsonbTextBytes(raw) ? packed : rows;
}
