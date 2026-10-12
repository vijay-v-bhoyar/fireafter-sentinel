import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildSupabasePayload, getSupabaseRefreshHeader, verifySupabaseRefreshHeader, readSupabaseRefreshPage, mapSupabaseRowsToBundle } from "./fireafter-supabase";
import { getSupabaseAdminClient } from "./supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { HYDRATION_HEADER, HYDRATION_STATE, hydratePreviousIncident } from "./ingestion-hydration";
import { previousRecommendation, previousSource, previousTerrain } from "./refresh-history";
import { encodeCheckpoint, decodeCheckpoint } from "./ingestion-checkpoint";
import { inventoryUser } from "../test/asset-page-fixture";
import { queuePage } from "../test/queue-page-fixture";
import { hydrationFixture } from "../test/refresh-hydration-fixture";
import { compactRefreshSqlFixture } from "../test/compact-refresh-sql-fixture";
import { COMPACT_REFRESH_TRANSPORT } from "./compact-refresh-page";
import { packSourcePayload } from "./source-payload-storage";
import { isUploadedAsset } from "./asset-import-validation";
import { createLiveRecommendationScorer, prepareLiveRecommendationContext, sourceFailureResult } from "./live-sources";
import { reuseTerrainSamples } from "./terrain-cache";
import type { Asset, SourceSnapshot } from "./types";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn() }));
beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function payloadFixture(count = 30) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const recommendations = queuePage(0, count, count).items.flatMap(item => item.status === "available" ? [{ ...item.recommendation,
    incidentId: incident.id, coordinates: [-118.25, 34.05] as [number, number], score100: item.position % 3 ? 80 : 20,
    riskLevel: item.position % 4 ? "High" as const : "Unknown" as const,
  }] : []);
  const assets: Asset[] = recommendations.map((rec, index) => ({ id: rec.assetId, incidentId: incident.id, name: rec.assetName, type: "Bridge",
    locationLabel: "County creek", coordinates: rec.coordinates, geometry: { type: "Point", coordinates: rec.coordinates },
    source: "Official bridge data", sourceKey: index === 0 ? "local-upload" : "fhwa-nbi-bridges", confidence: "Medium",
    localOrUploaded: index === 0, origin: index === 0 ? "uploaded" : "source",
    metrics: { slopeTerrain: 0.4, elevationSampleMeters: [100, 125], elevationChangeMeters: 25, elevationSampledAt: "2026-10-08T12:00:00Z", pwfdfCombinedHazard: "High" },
    evidence: [{ sourceKey: "usgs-epqs", sourceName: "USGS 3DEP", summary: "Saved terrain" }, { sourceKey: "nws", sourceName: "Weather", summary: "Do not reuse weather evidence" }],
  }));
  const sourceSnapshots: SourceSnapshot[] = [{ id: "source-nws", incidentId: incident.id, sourceKey: "nws", sourceName: "NWS", fetchedAt: "2026-10-08T12:00:00Z",
    sourceUpdatedAt: "2026-10-08T11:00:00Z", status: "online", stale: false, freshnessLabel: "Current", detail: "Saved weather", rawPayload: { values: [1, 2, 3] } }];
  return buildSupabasePayload({ incident, sourceSnapshots, recommendations }, { assets, auditEvents: [], write: {
    actorId: inventoryUser.id, organizationId: inventoryUser.organizationId, operation: "create", expectedRevision: null,
  } });
}
function checkpointStore() {
  const data = new Map<string, ReturnType<typeof encodeCheckpoint>>();
  let fail = "";
  const store = { read: async (key: string) => {
    const saved = data.get(key);
    return saved ? decodeCheckpoint(saved.manifest, saved.parts.map((value, part) => ({ part, value }))) : null;
  }, write: async (key: string, value: unknown) => {
    const encoded = encodeCheckpoint(value);
    if (key === HYDRATION_STATE) expect(encoded.parts.length).toBe(1);
    data.set(key, encoded);
    if (fail === key || (fail === "page" && key.startsWith("hp:")) || (fail === "index" && key.startsWith("hi:"))) { fail = ""; throw new Error("Lost storage acknowledgment"); }
  } };
  return { ...store, data, lose: (key: string) => { fail = key; } };
}
function inputFor(payload: ReturnType<typeof payloadFixture>) {
  return { scope: createHash("sha256").update("one-job-scope").digest("hex"),
    open: () => getSupabaseRefreshHeader(payload.incident.id, payload.incident.organization_id, true),
    verify: verifySupabaseRefreshHeader, page: readSupabaseRefreshPage };
}
let compactSql: Awaited<ReturnType<typeof compactRefreshSqlFixture>>;
beforeAll(async () => { compactSql = await compactRefreshSqlFixture(); }, 30_000);
afterAll(async () => { await compactSql?.close(); });
async function compactServer(payload: ReturnType<typeof payloadFixture>, cap = 2) {
  await compactSql.db.exec("begin");
  await compactSql.load(payload);
  const server = await hydrationFixture(payload, { cap, rpc: (name, args) => compactSql.rpc(name,
    name === "fireafter_read_refresh_recommendations" ? { ...args, p_limit: cap } : args) });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  return { ...server, close: async () => { await server.close(); await compactSql.db.exec("rollback"); } };
}

it.each(["ordinary", "lost-page", "lost-state", "flag-disabled-after-pin"])("hydrates full provenance through production SQL and real SDK: %s", async scenario => {
  vi.stubEnv("FIREAFTER_COMPACT_REFRESH_READS_ENABLED", "true");
  const payload = payloadFixture(8);
  payload.recommendations[1].evidence = [{ nested: { non_operational: true } }];
  payload.recommendations[2].score_breakdown.scoringVersion = "old";
  payload.recommendations[4].limitations.push("FireAfter browser smoke");
  payload.assets[3].properties.nested = { non_operational: true };
  const server = await compactServer(payload);
  try {
    const store = checkpointStore(), input = inputFor(payload);
    if (scenario.startsWith("lost-")) {
      store.lose(scenario === "lost-page" ? "page" : HYDRATION_STATE);
      await expect(hydratePreviousIncident(store, input)).rejects.toThrow("Lost storage acknowledgment");
    } else {
      await hydratePreviousIncident(store, input);
      if (scenario === "flag-disabled-after-pin") vi.stubEnv("FIREAFTER_COMPACT_REFRESH_READS_ENABLED", "false");
    }
    const result = await finish(store, input);
    expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("No result");
    const expected = mapSupabaseRowsToBundle(payload);
    expect(result.value.recommendations).toEqual(expected.recommendations.map(previousRecommendation));
    expect(result.value.persistence).toEqual(expected.persistence);
    expect(result.value.assets).toEqual(expected.assets.filter(isUploadedAsset));
    const saved = await store.read(HYDRATION_HEADER) as { header: { rowTransport: string } };
    expect(saved.header.rowTransport).toBe(COMPACT_REFRESH_TRANSPORT);
    const state = await store.read(HYDRATION_STATE) as { rawBytes: number; expandedBytes: number };
    expect(state.rawBytes).toBeGreaterThan(0); expect(state.expandedBytes).toBeGreaterThan(0);
    expect(server.requests.some(url => url.pathname.endsWith("rpc/fireafter_read_refresh_recommendations"))).toBe(true);
  } finally { await server.close(); }
});

it("does not promote an existing legacy header when the flag is enabled", async () => {
  vi.stubEnv("FIREAFTER_COMPACT_REFRESH_READS_ENABLED", "false");
  const payload = payloadFixture(8), server = await hydrationFixture(payload, { cap: 2 });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try {
    const store = checkpointStore(), input = inputFor(payload);
    await hydratePreviousIncident(store, input);
    vi.stubEnv("FIREAFTER_COMPACT_REFRESH_READS_ENABLED", "true");
    expect((await finish(store, input)).status).toBe("ready");
    expect(server.requests.some(url => url.pathname.includes("/rpc/"))).toBe(false);
    expect(await store.read(HYDRATION_STATE)).not.toHaveProperty("expandedBytes");
  } finally { await server.close(); }
});

it.each(["missing-expanded-size", "expanded-work-yield"])("requires expanded accounting and yields on expanded work: %s", async scenario => {
  vi.stubEnv("FIREAFTER_COMPACT_REFRESH_READS_ENABLED", "true");
  const payload = payloadFixture(20), server = await compactServer(payload);
  try {
    const store = checkpointStore(), input = inputFor(payload), actualPage = input.page;
    const page = vi.fn(async (...args: Parameters<typeof actualPage>) => {
      const result = await actualPage(...args);
      return { ...result, expandedBytes: scenario === "missing-expanded-size" ? undefined : 8 * 1024 * 1024 };
    });
    if (scenario === "missing-expanded-size") {
      await expect(hydratePreviousIncident(store, { ...input, page })).rejects.toThrow("hydration_checkpoint_invalid");
    } else {
      expect((await hydratePreviousIncident(store, { ...input, page })).status).toBe("pending");
      expect(page).toHaveBeenCalledTimes(1);
      expect(await store.read(HYDRATION_STATE)).toMatchObject({ expandedBytes: 8 * 1024 * 1024 });
    }
  } finally { await server.close(); }
});

it("refuses a new compact header when the private attestation is unavailable", async () => {
  vi.stubEnv("FIREAFTER_COMPACT_REFRESH_READS_ENABLED", "true");
  const payload = payloadFixture(2), server = await hydrationFixture(payload);
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try {
    const store = checkpointStore();
    await expect(hydratePreviousIncident(store, inputFor(payload))).rejects.toMatchObject({ code: "FB503" });
    expect(store.data.size).toBe(0);
  } finally { await server.close(); }
});

it.each(["rawBytes", "expandedBytes", "compactBytes"])("keeps the new %s budget independently enforced", async field => {
  vi.stubEnv("FIREAFTER_COMPACT_REFRESH_READS_ENABLED", "true");
  const payload = payloadFixture(20), server = await compactServer(payload);
  try {
    const store = checkpointStore(), input = inputFor(payload);
    await hydratePreviousIncident(store, input);
    const state = await store.read(HYDRATION_STATE) as Record<string, unknown>;
    state[field] = (field === "rawBytes" ? 512 : field === "expandedBytes" ? 768 : 64) * 1024 * 1024;
    await store.write(HYDRATION_STATE, state);
    await expect(hydratePreviousIncident(store, input)).rejects.toThrow("hydration_checkpoint_capacity");
    expect(await store.read(HYDRATION_STATE)).toEqual(state);
  } finally { await server.close(); }
});

it.each(["missing-expanded-counter", "bad-attestation", "foreign-related-asset"])("rejects compact read corruption: %s", async defect => {
  vi.stubEnv("FIREAFTER_COMPACT_REFRESH_READS_ENABLED", "true");
  const payload = payloadFixture(8), server = await compactServer(payload);
  try {
    const store = checkpointStore(), input = inputFor(payload);
    await hydratePreviousIncident(store, input);
    if (defect === "missing-expanded-counter") {
      const state = await store.read(HYDRATION_STATE) as Record<string, unknown>; delete state.expandedBytes;
      await store.write(HYDRATION_STATE, state);
    } else if (defect === "bad-attestation") {
      await compactSql.db.exec("alter function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer) security definer");
    } else {
      const other = { ...payload.incident, id: randomUUID(), created_at: "2026-10-08T12:00:00Z" };
      await compactSql.db.query("insert into public.incidents select * from jsonb_populate_record(null::public.incidents,$1)", [JSON.stringify(other)]);
      await compactSql.db.query("update public.assets set incident_id=$1 where id=$2", [other.id, payload.assets[0].id]);
    }
    await expect(finish(store, input)).rejects.toBeInstanceOf(Error);
  } finally { await server.close(); }
});
async function finish(store: ReturnType<typeof checkpointStore>, input: ReturnType<typeof inputFor>) {
  for (let call = 0; call < 150; call++) {
    const result = await hydratePreviousIncident(store, input);
    if (result.status !== "pending") return result;
  }
  throw new Error("Hydration did not finish within fixture step bound");
}
it("matches the full mapper through capped real-SDK HTTP pages and encoded checkpoints", async () => {
  const payload = payloadFixture();
  const retired = structuredClone(payload.assets[4]); retired.id = randomUUID(); retired.properties.domainAssetId = "retired-asset";
  payload.assets.push(retired);
  const retiredRec = structuredClone(payload.recommendations[4]); retiredRec.id = randomUUID(); retiredRec.asset_id = retired.id; retiredRec.score_breakdown.domainRecommendationId = "retired-recommendation";
  payload.recommendations.push(retiredRec);
  const retiredSource = structuredClone(payload.sourceSnapshots[0]); retiredSource.id = randomUUID(); retiredSource.raw_payload.domainSourceId = "retired-source";
  retiredSource.raw_payload.rawPayloadEncoding = "do-not-decode-retired-payload"; payload.sourceSnapshots.push(retiredSource);
  // Preserve non-operational filtering even for nested markers and old scoring.
  payload.recommendations[2].score_breakdown.scoringVersion = "old";
  payload.assets[3].properties.marker = { non_operational: true };
  payload.recommendations[5].limitations.push("FireAfter browser smoke");
  const server = await hydrationFixture(payload, { cap: 2 });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try {
    const store = checkpointStore(), result = await finish(store, inputFor(payload));
    expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("No refresh seed");
    const expected = mapSupabaseRowsToBundle(payload);
    expect(result.value.incident).toEqual(expected.incident);
    expect(result.value.persistence).toEqual(expected.persistence);
    expect(result.value.assets).toEqual(expected.assets.filter(isUploadedAsset));
    expect(result.value.recommendations).toEqual(expected.recommendations.map(previousRecommendation));
    expect(result.value.sourceSnapshots).toEqual(expected.sourceSnapshots.map(previousSource));
    expect(result.value.previousTerrain).toEqual(expected.assets.filter(asset => !isUploadedAsset(asset)).sort((a, b) =>
      expected.persistence.rowIds.asset[a.id].localeCompare(expected.persistence.rowIds.asset[b.id])).flatMap(asset => previousTerrain(asset) ?? []));
    expect(result.value.inventorySources).toEqual(["fhwa-nbi-bridges"]);
    expect(result.value.persistence.rowIds!.asset["retired-asset"]).toBe(retired.id);
    expect(result.value.assets.some(asset => asset.id === "retired-asset")).toBe(false);
    expect([...store.data.keys()].filter(key => key.startsWith("hp:")).length).toBeGreaterThan(16);
    expect(server.requests.every(url => !/audit|responder/.test(url.pathname))).toBe(true);
    const now = new Date("2026-10-08T13:00:00Z"), source = sourceFailureResult("nws", now);
    const fullContext = prepareLiveRecommendationContext(expected.incident, {}, [source], [], now, expected.recommendations, expected.sourceSnapshots);
    const compactContext = prepareLiveRecommendationContext(expected.incident, {}, [source], [], now, result.value.recommendations, result.value.sourceSnapshots);
    expect(compactContext).toEqual(fullContext);
    const scorer = createLiveRecommendationScorer(compactContext);
    expect(scorer.scorePage(expected.assets)).toEqual(createLiveRecommendationScorer(fullContext).scorePage(expected.assets));
    const nextAssets = expected.assets.map(asset => ({ ...asset, metrics: undefined, evidence: [] }));
    expect(reuseTerrainSamples(nextAssets, result.value.previousTerrain, now.getTime())).toEqual(reuseTerrainSamples(nextAssets, expected.assets, now.getTime()));
  } finally { await server.close(); }
}, 30_000);

it.each([HYDRATION_HEADER, HYDRATION_STATE, "page"])("resumes lost %s acknowledgment without losing membership or repinning", async key => {
  const payload = payloadFixture(6), server = await hydrationFixture(payload, { cap: 2 });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try {
    const store = checkpointStore(), input = inputFor(payload); store.lose(key);
    await expect(hydratePreviousIncident(store, input)).rejects.toThrow("Lost storage acknowledgment");
    const result = await finish(store, input);
    expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("Missing result");
    expect(result.value.recommendations).toEqual(mapSupabaseRowsToBundle(payload).recommendations.map(previousRecommendation));
    expect(result.value.persistence.rowIds).toEqual(mapSupabaseRowsToBundle(payload).persistence.rowIds);
  } finally { await server.close(); }
});

it.each(["foreign", "drift", "authority-drift", "wrong-count", "wrong-final-count", "empty-page", "duplicate", "wrong-incident", "missing-related"])("rejects %s without a usable refresh seed", async defect => {
  const payload = payloadFixture(6), server = await hydrationFixture(payload, { cap: 2, defect });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try { await expect(finish(checkpointStore(), inputFor(payload))).rejects.toBeInstanceOf(Error); }
  finally { await server.close(); }
});

it.each(["scope", "cursor", "page"])("rejects changed saved %s instead of starting again", async defect => {
  const payload = payloadFixture(20), server = await hydrationFixture(payload, { cap: 2 });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try {
    const store = checkpointStore(), input = inputFor(payload);
    await hydratePreviousIncident(store, input);
    if (defect === "scope") input.scope = "0".repeat(64);
    else if (defect === "cursor") {
      const state = await store.read(HYDRATION_STATE) as { cursors: { asset: { count: number } } }; state.cursors.asset.count = -1;
      await store.write(HYDRATION_STATE, state);
    } else {
      const pageKey = [...store.data.keys()].find(key => key.startsWith("hp:"))!;
      await store.write(pageKey, { changed: true });
    }
    await expect(finish(store, input)).rejects.toThrow("hydration_checkpoint_invalid");
  } finally { await server.close(); }
});

it("checks compressed-source markers before retaining their historical identity", async () => {
  const payload = payloadFixture(2);
  payload.sourceSnapshots[0].raw_payload = { ...payload.sourceSnapshots[0].raw_payload, ...packSourcePayload({
    pad: "x".repeat(300_000), nested: { non_operational: true },
  }) };
  const server = await hydrationFixture(payload); vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try {
    const result = await finish(checkpointStore(), inputFor(payload));
    expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("No result");
    expect(result.value.sourceSnapshots).toEqual([]); expect(result.value.persistence.rowIds!.source).toEqual({});
  } finally { await server.close(); }
});

it("does not turn a missing incident into another county", async () => {
  const payload = payloadFixture(2), server = await hydrationFixture(payload, { defect: "missing-incident" });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try { expect(await finish(checkpointStore(), inputFor(payload))).toEqual({ status: "missing" }); }
  finally { await server.close(); }
});

it.each(["membership", "alias", "upload", "source-integrity"])("rejects invalid persisted %s before returning refresh inputs", async defect => {
  const payload = payloadFixture(4);
  if (defect === "membership") { payload.assets.pop(); payload.recommendations.pop(); }
  if (defect === "alias") payload.assets[2].properties.domainAssetId = payload.assets[1].properties.domainAssetId;
  if (defect === "upload") payload.assets[0].geometry_geojson = { type: "Point", coordinates: [0, 0] };
  if (defect === "source-integrity") payload.sourceSnapshots[0].raw_payload = { rawPayloadEncoding: "gzip-json-v1", rawPayloadBytes: 10, rawPayloadGzip: "eA==", rawPayloadHash: "0".repeat(64) };
  const server = await hydrationFixture(payload); vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try { await expect(finish(checkpointStore(), inputFor(payload))).rejects.toBeInstanceOf(Error); }
  finally { await server.close(); }
});

it.each(["rawBytes", "compactBytes"])("enforces the resumable %s capacity instead of truncating", async field => {
  const payload = payloadFixture(20), server = await hydrationFixture(payload, { cap: 2 });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try {
    const store = checkpointStore(), input = inputFor(payload);
    await hydratePreviousIncident(store, input);
    const state = await store.read(HYDRATION_STATE) as Record<string, unknown>;
    state[field] = (field === "rawBytes" ? 512 : 64) * 1024 * 1024;
    await store.write(HYDRATION_STATE, state);
    await expect(hydratePreviousIncident(store, input)).rejects.toThrow("hydration_checkpoint_capacity");
  } finally { await server.close(); }
});

it.each(["page", HYDRATION_STATE])("recovers lost merge %s acknowledgment with the original rank context", async key => {
  const payload = payloadFixture(30), server = await hydrationFixture(payload, { cap: 2 });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try {
    const store = checkpointStore(), input = inputFor(payload);
    for (let i = 0; i < 30; i++) {
      await hydratePreviousIncident(store, input);
      if ((await store.read(HYDRATION_STATE) as { phase: string }).phase === "merge") break;
    }
    expect((await store.read(HYDRATION_STATE) as { phase: string }).phase).toBe("merge");
    store.lose(key);
    await expect(hydratePreviousIncident(store, input)).rejects.toThrow("Lost storage acknowledgment");
    const result = await finish(store, input);
    expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("No result");
    expect(result.value.recommendations).toEqual(mapSupabaseRowsToBundle(payload).recommendations.map(previousRecommendation));
  } finally { await server.close(); }
});

it.each(["lost-index", "lost-cursor", "corrupt-index"])("safely handles %s at the validated-asset join boundary", async defect => {
  const payload = payloadFixture(8), server = await hydrationFixture(payload, { cap: 2 });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(server.client);
  try {
    const store = checkpointStore(), input = inputFor(payload);
    for (let i = 0; i < 20; i++) {
      await hydratePreviousIncident(store, input);
      if ((await store.read(HYDRATION_STATE) as { phase: string }).phase === "index") break;
    }
    expect((await store.read(HYDRATION_STATE) as { phase: string }).phase).toBe("index");
    if (defect === "corrupt-index") {
      await hydratePreviousIncident(store, input);
      const state = await store.read(HYDRATION_STATE) as { assetsIndex: { hash: string } };
      const indexKey = `hi:${state.assetsIndex.hash}`;
      const index = await store.read(indexKey) as { ids: string[] }; index.ids.pop();
      await store.write(indexKey, index);
      await expect(finish(store, input)).rejects.toThrow("hydration_checkpoint_invalid");
    } else {
      store.lose(defect === "lost-index" ? "index" : HYDRATION_STATE);
      await expect(hydratePreviousIncident(store, input)).rejects.toThrow("Lost storage acknowledgment");
      const result = await finish(store, input);
      expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("No result");
      expect(result.value.recommendations).toEqual(mapSupabaseRowsToBundle(payload).recommendations.map(previousRecommendation));
    }
  } finally { await server.close(); }
});
