import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { stageIngestionPayload, stagePreparedIngestion, buildStagedHeader, STAGED_HEADER_KEY, STAGED_COMMIT_SECURITY_VERSION } from "./ingestion-staged";
import { prepareIngestionPayload } from "./ingestion-payload";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import type { Asset, SourceSnapshot } from "./types";
import type { IngestionJob } from "./ingestion-store";
import { SHARED_ROW_ENCODING, type SharedRowPage } from "./ingestion-row-page";
import { createLiveRecommendationScorer, prepareLiveRecommendationContext } from "./live-sources";
import { parseInventoryManifest } from "./inventory-manifest";

const state = vi.hoisted(() => ({ checkpoint: new Map<string, unknown>(), rpc: vi.fn() }));
vi.mock("./ingestion-store", () => ({ readCheckpoint: async (_id: string, key: string) => state.checkpoint.get(key) ?? null,
  putCheckpoint: async (_job: unknown, key: string, value: unknown) => { state.checkpoint.set(key, structuredClone(value)); },
  ingestionRpc: (...args: unknown[]) => state.rpc(...args) }));
const job = { id: randomUUID(), lease_id: randomUUID() } as IngestionJob;
beforeEach(() => { state.checkpoint.clear(); state.rpc.mockReset(); });
function fixture(count = 4300, withRecommendations = false, withSource = false) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const assets: Asset[] = Array.from({ length: count }, (_, index) => ({ id: `asset-${index}`, incidentId: incident.id, name: `Bridge ${index}`,
    type: "Bridge", locationLabel: "Test", coordinates: [-118.2, 34.2], source: "Fixture", confidence: "Low", localOrUploaded: false }));
  const scorer = createLiveRecommendationScorer(prepareLiveRecommendationContext(incident, {}, [], [], new Date("2026-10-08T11:00:00Z")));
  let rank = 0;
  const recommendations = withRecommendations ? scorer.finalizePage(scorer.scorePage(assets.slice(0, 3)), () => ++rank)
    .map((row, index) => ({ ...row, riskLevel: index === 1 ? "Unknown" as const : "High" as const, score100: [95, 30, 80][index] })) : [];
  const sourceSnapshots: SourceSnapshot[] = withSource ? [{ id: "source", incidentId: incident.id, sourceKey: "nws", sourceName: "NWS",
    fetchedAt: "2026-10-08T11:00:00Z", sourceUpdatedAt: "2026-10-08T10:00:00Z", status: "delayed", stale: true,
    freshnessLabel: "Limited", detail: "Source evidence unavailable", rawPayload: { available: false } }] : [];
  return prepareIngestionPayload(job.id, "final", { incident, assets, recommendations, sourceSnapshots },
    { operation: "create", actorId: randomUUID(), organizationId: randomUUID(), expectedRevision: null }, new Date("2026-10-08T11:00:00Z"));
}
function fakeSql() {
  const saved: Record<string, number> = { source: 0, asset: 0, recommendation: 0 };
  state.rpc.mockImplementation(async (name, input) => {
    if (name === "fireafter_staged_ingestion_security_version") return STAGED_COMMIT_SECURITY_VERSION;
    if (name === "fireafter_stage_ingestion_rows") saved[input.p_kind] += Array.isArray(input.p_rows) ? input.p_rows.length : input.p_rows.rows.length;
    return { ...saved };
  });
  return saved;
}
it("stages at most sixteen bounded pages and resumes from acknowledged counts", async () => {
  const payload = fixture(); fakeSql();
  expect(await stageIngestionPayload(job, payload)).toBe(false);
  expect(state.rpc.mock.calls.filter(([name]) => name === "fireafter_stage_ingestion_rows")).toHaveLength(16);
  expect(await stageIngestionPayload(job, payload)).toBe(true);
  const writes = state.rpc.mock.calls.filter(([name]) => name === "fireafter_stage_ingestion_rows");
  expect(writes.at(-1)?.[1]).toMatchObject({ p_position: 4096 });
  expect(writes.flatMap(([, args]) => args.p_rows)).toEqual(payload.assets);
  expect(state.checkpoint.has(STAGED_HEADER_KEY)).toBe(true);
});
it("recovers a lost staging acknowledgment without resending committed rows", async () => {
  const payload = fixture(300), saved = fakeSql(), normal = state.rpc.getMockImplementation()!;
  let failed = false;
  state.rpc.mockImplementation(async (name, input) => {
    const result = await normal(name, input);
    if (!failed && name === "fireafter_stage_ingestion_rows") { failed = true; throw new Error("lost response"); }
    return result;
  });
  await expect(stageIngestionPayload(job, payload)).rejects.toThrow("lost response");
  expect(saved.asset).toBe(256);
  expect(await stageIngestionPayload(job, payload)).toBe(true);
  expect(state.rpc.mock.calls.filter(([name]) => name === "fireafter_stage_ingestion_rows").map(([, args]) => args.p_position)).toEqual([0, 256]);
});
it.each(["already staged row", "incident metadata", "audit", "revision context"])("rejects changed %s rather than mixing generations", async field => {
  const payload = fixture(); fakeSql();
  await stageIngestionPayload(job, payload);
  if (field === "already staged row") payload.assets[0].name = "Changed";
  if (field === "incident metadata") payload.incident.title = "Changed";
  if (field === "audit") payload.auditEvents[0].summary = "Changed";
  if (field === "revision context") payload.write.expectedRevision = randomUUID();
  state.rpc.mockClear();
  await expect(stageIngestionPayload(job, payload)).rejects.toMatchObject({ code: "FB409" });
  expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(["fireafter_staged_ingestion_security_version"]);
});
it("pins the original manifest revision when payload mapping generates a new UUID on retry", async () => {
  const payload = fixture(); fakeSql();
  await stageIngestionPayload(job, payload);
  const copy = structuredClone(payload);
  (copy.incident.selected_fire.inventoryManifest as { revision: string }).revision = randomUUID();
  expect(await stageIngestionPayload(job, copy)).toBe(true);
  expect((state.checkpoint.get(STAGED_HEADER_KEY) as { incident: typeof payload.incident }).incident).toEqual(payload.incident);
});
it("resumes an already staged pre-index header without changing its persisted format", async () => {
  const payload = fixture(4300, true); fakeSql();
  const legacy = structuredClone(payload);
  const inventory = parseInventoryManifest(legacy.incident.selected_fire.inventoryManifest)!;
  delete inventory.queueIndex;
  inventory.recommendationIds = legacy.recommendations.map(row => row.id);
  expect(inventory.recommendationIds).not.toEqual(parseInventoryManifest(payload.incident.selected_fire.inventoryManifest)!.recommendationIds);
  await stageIngestionPayload(job, legacy);
  const savedHeader = structuredClone(state.checkpoint.get(STAGED_HEADER_KEY));
  expect(await stageIngestionPayload(job, payload)).toBe(true);
  expect(state.checkpoint.get(STAGED_HEADER_KEY)).toEqual(savedHeader);
  expect((payload.incident.selected_fire.inventoryManifest as { queueIndex?: unknown }).queueIndex).toBeDefined();
});
it.each(["replace", "remove", "duplicate", "row change"])("rejects changed pre-index membership or content: %s", async defect => {
  const payload = fixture(4300, true); fakeSql();
  const legacy = structuredClone(payload), original = parseInventoryManifest(legacy.incident.selected_fire.inventoryManifest)!;
  delete original.queueIndex;
  original.recommendationIds = legacy.recommendations.map(row => row.id);
  await stageIngestionPayload(job, legacy);
  const inventory = parseInventoryManifest(payload.incident.selected_fire.inventoryManifest)!;
  if (defect === "replace") inventory.recommendationIds[0] = randomUUID();
  if (defect === "remove") inventory.recommendationIds.pop();
  if (defect === "duplicate") inventory.recommendationIds[0] = inventory.recommendationIds[1];
  if (defect === "row change") payload.recommendations[0].score_100 = 5;
  state.rpc.mockClear();
  await expect(stageIngestionPayload(job, payload)).rejects.toMatchObject({ code: "FB409" });
  expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(["fireafter_staged_ingestion_security_version"]);
});
it.each([false, true])("resumes pre-source-model rows without retrofitting already staged data (change=%s)", async changed => {
  const payload = fixture(4300, true, true); fakeSql();
  const legacy = structuredClone(payload);
  delete parseInventoryManifest(legacy.incident.selected_fire.inventoryManifest)!.sourceQueueVersion;
  delete (legacy.sourceSnapshots[0].raw_payload as Record<string, unknown>).queueReadModel;
  expect(await stageIngestionPayload(job, legacy)).toBe(false);
  const header = structuredClone(state.checkpoint.get(STAGED_HEADER_KEY));
  if (changed) {
    payload.sourceSnapshots[0].source_name = "Changed";
    await expect(stageIngestionPayload(job, payload)).rejects.toMatchObject({ code: "FB409" });
  } else {
    expect(await stageIngestionPayload(job, payload)).toBe(true);
    const sources = state.rpc.mock.calls.filter(([name, input]) => name === "fireafter_stage_ingestion_rows" && input.p_kind === "source").flatMap(([, input]) => input.p_rows);
    expect(sources).toEqual(legacy.sourceSnapshots);
  }
  expect(state.checkpoint.get(STAGED_HEADER_KEY)).toEqual(header);
  expect(payload.sourceSnapshots[0].raw_payload.queueReadModel).toBeDefined();
});
it.each([null, {}, { asset: -1, source: 0, recommendation: 0 }, { asset: 9000, source: 0, recommendation: 0 }])("rejects malformed server progress %j", async result => {
  state.rpc.mockImplementation(async name => name === "fireafter_staged_ingestion_security_version" ? STAGED_COMMIT_SECURITY_VERSION : result);
  await expect(stageIngestionPayload(job, fixture())).rejects.toMatchObject({ code: "FB503" });
});
it("rejects a stage response that did not acknowledge exactly the submitted page", async () => {
  state.rpc.mockImplementation(async name => name === "fireafter_staged_ingestion_security_version"
    ? STAGED_COMMIT_SECURITY_VERSION : { asset: 0, source: 0, recommendation: 0 });
  await expect(stageIngestionPayload(job, fixture(300))).rejects.toMatchObject({ code: "FB503" });
});
it("refuses to stage when migration security is missing or drifted", async () => {
  state.rpc.mockResolvedValue(null);
  await expect(stageIngestionPayload(job, fixture(2))).rejects.toMatchObject({ code: "FB503" });
  expect(state.checkpoint.size).toBe(0);
  expect(state.rpc).toHaveBeenCalledTimes(1);
});
it.each([undefined, SHARED_ROW_ENCODING] as const)("stages prepared pages with %s by acknowledged position without reading the entire payload", async encoding => {
  const payload = fixture(4300), header = buildStagedHeader(payload), saved = fakeSql();
  const read = vi.fn(async (_kind, position) => payload.assets.slice(position, position + 128));
  const total = { source: 0, asset: 4300, recommendation: 0 };
  expect(await stagePreparedIngestion(job, header, total, read, encoding)).toBe(false);
  expect(read).toHaveBeenCalledTimes(16); expect(saved.asset).toBe(2048);
  expect(await stagePreparedIngestion(job, header, total, read, encoding)).toBe(false);
  expect(await stagePreparedIngestion(job, header, total, read, encoding)).toBe(true);
  const pages = state.rpc.mock.calls.filter(([name]) => name === "fireafter_stage_ingestion_rows").map(([, args]) => args.p_rows);
  expect(pages.flatMap((page: unknown[] | SharedRowPage) => Array.isArray(page) ? page : page.rows.map(row => ({ ...page.shared, ...row })))).toEqual(payload.assets);
  expect(pages.every(page => encoding ? page.format === encoding : Array.isArray(page))).toBe(true);
});
it.each([undefined, SHARED_ROW_ENCODING] as const)("reconciles lost %s prepared-row acknowledgments and rejects header changes before reading another page", async encoding => {
  const payload = fixture(300), header = buildStagedHeader(payload), saved = fakeSql();
  const normal = state.rpc.getMockImplementation()!, read = vi.fn(async (_kind, position) => payload.assets.slice(position, position + 128));
  const total = { source: 0, asset: 300, recommendation: 0 };
  let lost = false;
  state.rpc.mockImplementation(async (name, input) => {
    const result = await normal(name, input);
    if (!lost && name === "fireafter_stage_ingestion_rows") { lost = true; throw new Error("lost response"); }
    return result;
  });
  await expect(stagePreparedIngestion(job, header, total, read, encoding)).rejects.toThrow("lost response");
  expect(saved.asset).toBe(128);
  expect(await stagePreparedIngestion(job, header, total, read, encoding)).toBe(true);
  expect(read.mock.calls.map(([, position]) => position)).toEqual([0, 128, 256]);
  read.mockClear();
  await expect(stagePreparedIngestion(job, { ...header, rowsDigest: "f".repeat(64) }, total, read, encoding)).rejects.toMatchObject({ code: "FB409" });
  expect(read).not.toHaveBeenCalled();
});
it("accounts for encoded transfer bytes without counting shared fields once per row", async () => {
  const payload = fixture(300);
  for (const row of payload.assets) row.confidence_reason = "x".repeat(100_000);
  expect(Buffer.byteLength(JSON.stringify(payload.assets))).toBeGreaterThan(24 * 1024 * 1024);
  fakeSql();
  const read = vi.fn(async (_kind, position) => payload.assets.slice(position, position + 128));
  expect(await stagePreparedIngestion(job, buildStagedHeader(payload), { source: 0, asset: 300, recommendation: 0 }, read, SHARED_ROW_ENCODING)).toBe(true);
  const pages: SharedRowPage[] = state.rpc.mock.calls.filter(([name]) => name === "fireafter_stage_ingestion_rows").map(([, args]) => args.p_rows);
  expect(pages).toHaveLength(3);
  expect(pages.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify(page)), 0)).toBeLessThan(24 * 1024 * 1024);
  expect(pages.flatMap(page => page.rows.map(row => ({ ...page.shared, ...row })))).toEqual(payload.assets);
});
