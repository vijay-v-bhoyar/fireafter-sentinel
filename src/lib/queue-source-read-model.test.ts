import { afterEach, expect, it, vi } from "vitest";
import { buildSupabasePayload, mapSupabaseRowsToBundle } from "./fireafter-supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { queueSourceProjection, readQueueSourceModel, QUEUE_SOURCE_SELECT } from "./queue-source-read-model";
import { projectSourceFreshness } from "./source-freshness";
import { PWFDF_ANALYSIS_GEOMETRY_VERSION } from "./pwfdf-geometry";
import type { SourceSnapshot } from "./types";

afterEach(() => vi.restoreAllMocks());
const now = new Date("2026-10-08T12:00:00Z");
function fixture(change: Partial<SourceSnapshot> = {}) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const source: SourceSnapshot = { id: "source-model", incidentId: incident.id, sourceKey: "nws", sourceName: "NWS", sourceUrl: "https://api.weather.gov/",
    fetchedAt: "2026-10-08T11:55:00Z", sourceUpdatedAt: "2026-10-08T11:45:00Z", sourceTimeBasis: "provider", validUntil: "2026-10-08T13:00:00Z",
    status: "online", stale: false, freshnessLabel: "Recent", detail: "Published forecast", coverageStatus: "available", warnings: [], rawPayload: {}, ...change };
  const payload = buildSupabasePayload({ incident, sourceSnapshots: [source], recommendations: [] }, { assets: [], auditEvents: [] });
  return { payload, row: payload.sourceSnapshots[0], source };
}
function visible(source: SourceSnapshot) { const rest = { ...source }; delete rest.rawPayload; delete rest.derivedSignals; return rest; }
it.each([
  {}, { fetchedAt: "2026-10-08T10:00:00Z" }, { fetchedAt: "not a date" }, { fetchedAt: "2026-10-09T00:00:00Z" },
  { sourceUpdatedAt: "" }, { validUntil: "invalid" }, { validUntil: undefined }, { sourceTimeBasis: "retrieval" },
  { status: "offline", stale: true, coverageStatus: "error" },
  { sourceKey: "mtbs-burn-severity", rawPayload: {} },
  { sourceKey: "tiger-roads", rawPayload: { features: [{ geometry: { paths: [[[-120, 35], [-119, 35]]] } }] } },
  { sourceKey: "3dhp-flowlines", rawPayload: { available: false, status: "error", inventoryComplete: false, reason: "provider_error" } },
] as Partial<SourceSnapshot>[])("matches full-reader freshness and limitations for %j", change => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { payload, row } = fixture(change);
  const full = mapSupabaseRowsToBundle(payload).sourceSnapshots[0];
  const compact = readQueueSourceModel(queueSourceProjection(row))!;
  for (const time of [now, new Date("2026-10-08T14:00:00Z")]) expect(visible(projectSourceFreshness(compact, time))).toEqual(visible(projectSourceFreshness(full, time)));
});
it.each([undefined, [], [{ assessmentDate: "2026-10-07" }, { assessmentDate: "2026-10-09" }], [{ assessmentDate: "bad" }], [null], {},
  [{ assessmentDate: "2026-10-08T12:00:00+00:00" }]])("preserves every PWFDF publication-date decision for %j", basins => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const rawPayload = { analysisGeometryVersion: PWFDF_ANALYSIS_GEOMETRY_VERSION, assessment: { assessmentDate: "2026-10-07" },
    ...(basins === undefined ? {} : { basins }) };
  const { payload, row } = fixture({ sourceKey: "usgs-pwfdf", rawPayload });
  const full = mapSupabaseRowsToBundle(payload).sourceSnapshots[0], compact = readQueueSourceModel(queueSourceProjection(row))!;
  for (const time of [now, new Date("2026-10-09T12:00:00Z")]) expect(visible(projectSourceFreshness(compact, time))).toEqual(visible(projectSourceFreshness(full, time)));
  expect(JSON.stringify(compact)).not.toContain('"geometry"');
});
it("retains invalid assessment and analysis-version gates", () => {
  const { row } = fixture({ sourceKey: "usgs-pwfdf", rawPayload: { assessment: null, basins: [] } });
  expect(projectSourceFreshness(readQueueSourceModel(queueSourceProjection(row))!, now).freshness?.state).toBe("invalid");
});
it.each(["explicit", "legacy"])("withholds %s non-operational content after decoding and never returns its prose", kind => {
  const { row } = fixture({ rawPayload: { nested: { ...(kind === "explicit" ? { nonOperational: true } : { text: "FireAfter API smoke" }), large: "x".repeat(300000) } } });
  expect(row.raw_payload.rawPayloadEncoding).toBe("gzip-json-v1");
  expect(readQueueSourceModel(queueSourceProjection(row))).toBeNull();
  expect(JSON.stringify(row.raw_payload.queueReadModel)).not.toContain("API smoke");
});
it("retains existing FIRMS credential redaction in storage and the model without mutating input", () => {
  const { row, source } = fixture({ sourceKey: "firms", sourceUrl: "https://firms.modaps.eosdis.nasa.gov/api/area/csv/fixture-key/MODIS_NRT/USA/1",
    detail: "See https://firms.modaps.eosdis.nasa.gov/api/area/csv/fixture-key/MODIS_NRT/USA/1" });
  expect(JSON.stringify(readQueueSourceModel(queueSourceProjection(row)))).not.toContain("fixture-key");
  expect(row.source_url).not.toContain("fixture-key");
  expect(source.sourceUrl).toContain("fixture-key");
});
it("survives JSONB key order, omitted undefined values and normalized database timestamp spelling", () => {
  const { row } = fixture({ rawPayload: { z: [0, null, false], a: undefined, nested: { y: 1, x: "value" } } });
  const projected = JSON.parse(JSON.stringify(queueSourceProjection(row)));
  projected.fetched_at = "2026-10-08 11:55:00+00";
  projected.source_updated_at = "2026-10-08T11:45:00.000+00:00";
  projected.meta_rawPayload = { nested: { x: "value", y: 1 }, z: [0, null, false] };
  expect(readQueueSourceModel(projected)?.sourceName).toBe("NWS");
});
it.each(["missing", "version", "projection", "fetched_at", "status", "meta_detail", "meta_rawPayload", "source_name", "id", "incident_id", "meta_rawPayloadHash"])("rejects unverified or changed %s", defect => {
  const { row } = fixture(), projected = queueSourceProjection(row);
  if (defect === "missing") projected.queue_read = null;
  else if (defect === "version") (projected.queue_read as { version: string }).version = "old";
  else if (defect === "projection") (projected.queue_read as { source: { status: string } }).source.status = "offline";
  else projected[defect] = "changed";
  expect(() => readQueueSourceModel(projected)).toThrow(/inventory/i);
});
it("does not select compressed geometry and keeps a large saved source projection bounded", () => {
  const { row } = fixture({ rawPayload: { features: Array.from({ length: 20000 }, (_, n) => ({ geometry: { coordinates: [-119 + n / 100000, 34.1] } })) } });
  expect(QUEUE_SOURCE_SELECT).not.toContain("rawPayloadGzip");
  expect(QUEUE_SOURCE_SELECT).not.toContain("*");
  expect(JSON.stringify(queueSourceProjection(row)).length).toBeLessThan(4000);
  expect(readQueueSourceModel(queueSourceProjection(row))?.sourceName).toBe("NWS");
});
it("rejects oversized summaries rather than truncating source warnings", () => {
  expect(() => fixture({ warnings: ["x".repeat(262144)] })).toThrow(/inventory/i);
});
it("keeps full raw-source hydration available when a compact projection version is old", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { payload, row } = fixture();
  (payload.incident.selected_fire.inventoryManifest as { sourceQueueVersion: string }).sourceQueueVersion = "older-version";
  (row.raw_payload.queueReadModel as { version: string }).version = "older-version";
  expect(mapSupabaseRowsToBundle(payload).sourceSnapshots[0].sourceName).toBe("NWS");
  expect(() => readQueueSourceModel(queueSourceProjection(row))).toThrow(/inventory/i);
});
