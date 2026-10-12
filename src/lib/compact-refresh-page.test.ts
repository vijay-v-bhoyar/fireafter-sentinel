import { expect, it } from "vitest";
import { COMPACT_REFRESH_TRANSPORT, decodeCompactRefreshPage } from "./compact-refresh-page";
import { isNonOperationalRecommendationRecord } from "./non-operational-records";

const id = "10000000-0000-4000-8000-000000000001";
const envelope = (page: unknown, remaining = 2) => ({ format: COMPACT_REFRESH_TRANSPORT, incidentId: id, remaining, page });
const packed = (shared: Record<string, unknown>, rows: Record<string, unknown>[] = [{ id: "a" }, { id: "b" }]) =>
  envelope({ format: "shared-row-fields-v1", shared, rows }, rows.length);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

it("restores every shared and per-row field with exact expanded byte accounting", () => {
  const shared = { evidence: [{ text: 'quote " and \\ and \n and \u00e9', nested: [null, false, 0, {}, []] }], absentAlternative: null };
  const rows = [{ id: "a", own: false }, { id: "b", own: 0 }, {}];
  const value = packed(shared, rows), result = decodeCompactRefreshPage(value, id);
  expect(result.data).toEqual(rows.map(row => ({ ...shared, ...row })));
  expect(result.bytes).toBe(size(value));
  expect(result.expandedBytes).toBe(size(result.data));
  expect(Object.hasOwn(result.data[2], "own")).toBe(false);
});

it.each([{ rows: [] }, { rows: [{ id: "a", evidence: [null], extra: false }] }])("accepts raw fallback and empty pages: %j", ({ rows }) => {
  const value = envelope(rows, rows.length), result = decodeCompactRefreshPage(value, id);
  expect(result).toEqual({ data: rows, count: rows.length, bytes: size(value), expandedBytes: size(rows) });
});

it("retains markers in shared and row-specific nested provenance", () => {
  const value = packed({ evidence: [{ detail: { non_operational: true } }] });
  expect(decodeCompactRefreshPage(value, id).data.every(isNonOperationalRecommendationRecord)).toBe(true);
  const mixed = packed({ confidence_level: "Low" }, [{ limitations: ["FireAfter browser smoke"] }, { limitations: [] }]);
  expect(decodeCompactRefreshPage(mixed, id).data.map(isNonOperationalRecommendationRecord)).toEqual([true, false]);
});

it.each([
  undefined, null, [], {}, envelope([], 1), envelope([{}, {}], 1), envelope([], -1), envelope([], 100001),
  { ...envelope([]), format: "other" }, { ...envelope([]), incidentId: "20000000-0000-4000-8000-000000000001" },
  { ...envelope([]), ignored: true }, packed({}), packed({ x: 1 }, []), packed({ id: "shared" }),
  packed({ incident_id: id }), packed({ asset_id: id }), packed({ x: null }, [{ x: null }]),
  envelope({ format: "other", shared: { x: 1 }, rows: [{}] }), envelope(Array.from({ length: 501 }, () => ({})), 501),
])("rejects malformed, ambiguous or out-of-scope envelopes (%#)", value => {
  expect(() => decodeCompactRefreshPage(value, id)).toThrowError(expect.objectContaining({ code: "read_invalid" }));
});

it("rejects cyclic input without leaking a raw serializer error", () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(() => decodeCompactRefreshPage(cycle, id)).toThrowError(expect.objectContaining({ code: "read_invalid" }));
});

it("rejects excessive serialized, shared, and expanded page sizes", () => {
  for (const value of [envelope([{ value: "x".repeat(8 * 1024 * 1024) }], 1),
    packed({ value: "x".repeat(1024 * 1024) }),
    packed({ value: "x".repeat(100_000) }, Array.from({ length: 100 }, () => ({})))]) {
    expect(() => decodeCompactRefreshPage(value, id)).toThrowError(expect.objectContaining({ code: "read_budget" }));
  }
});
