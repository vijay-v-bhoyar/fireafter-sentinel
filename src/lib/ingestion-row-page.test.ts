import { expect, it } from "vitest";
import { encodeStagedRows, SHARED_ROW_ENCODING, type StagedRowPage } from "./ingestion-row-page";
import { jsonbTextBytes } from "./ingestion-jsonb-size";

const expand = (page: StagedRowPage) => Array.isArray(page) ? page : page.rows.map(row => ({ ...page.shared, ...row }));
it("factors repeated fields losslessly while keeping child/incident/asset identifiers explicit", () => {
  const rows = Array.from({ length: 128 }, (_, index) => ({ id: String(index), incident_id: "same", asset_id: `asset-${index}`,
    status: "Unknown", action: "Review evidence before use. ".repeat(30), missing: null,
    active: false, zero: 0, evidence: [{ source: "Test", limitations: ["Unverified"] }], unique: `Details ${index}` }));
  const page = encodeStagedRows(rows, SHARED_ROW_ENCODING);
  expect(Array.isArray(page)).toBe(false);
  if (Array.isArray(page)) throw new Error("not compact");
  expect(page.shared).not.toHaveProperty("id"); expect(page.shared).not.toHaveProperty("incident_id"); expect(page.shared).not.toHaveProperty("asset_id");
  expect(page.rows.every(row => Object.hasOwn(row, "id") && Object.hasOwn(row, "incident_id") && Object.hasOwn(row, "asset_id"))).toBe(true);
  expect(expand(page)).toEqual(rows);
  expect(jsonbTextBytes(JSON.stringify(page))).toBeLessThan(jsonbTextBytes(JSON.stringify(rows)) / 4);
  expect(rows[0]).toHaveProperty("action");
});
it("distinguishes absent, null, false and zero and preserves escaped text", () => {
  const rows = [{ id: "1", absent: null, value: false, shared: "repeat \\".repeat(100) },
    { id: "2", value: 0, shared: "repeat \\".repeat(100) }];
  const page = encodeStagedRows(rows, SHARED_ROW_ENCODING);
  expect(expand(page)).toEqual(rows);
  if (!Array.isArray(page)) { expect(page.shared).not.toHaveProperty("absent"); expect(page.shared).not.toHaveProperty("value"); }
});
it("uses arrays for legacy mode, single rows, non-beneficial packing or oversized shared objects", () => {
  const rows = [{ id: "1", v: "x" }, { id: "2", v: "x" }];
  expect(encodeStagedRows(rows)).toBe(rows);
  expect(encodeStagedRows(rows, SHARED_ROW_ENCODING)).toBe(rows);
  expect(encodeStagedRows(rows.slice(0, 1), SHARED_ROW_ENCODING)).toEqual(rows.slice(0, 1));
  const big = [{ id: "1", v: "x".repeat(1024 * 1024) }, { id: "2", v: "x".repeat(1024 * 1024) }];
  expect(encodeStagedRows(big, SHARED_ROW_ENCODING)).toBe(big);
});
it("preserves own special keys without prototype mutation and rejects unsupported encodings", () => {
  const rows = JSON.parse('[{"id":"1","__proto__":{"test":"' + "a".repeat(200) + '"}},{"id":"2","__proto__":{"test":"' + "a".repeat(200) + '"}}]');
  expect(expand(encodeStagedRows(rows, SHARED_ROW_ENCODING))).toEqual(rows);
  expect(Object.prototype).not.toHaveProperty("test");
  expect(() => encodeStagedRows(rows, "other" as never)).toThrow();
  expect(() => encodeStagedRows([null, []], SHARED_ROW_ENCODING)).toThrow();
});
