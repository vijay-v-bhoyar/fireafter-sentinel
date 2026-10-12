import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { IngestionJob } from "./ingestion-store";
import type { LiveSourceResult } from "./live-sources";
import { CORE_SOURCES, EXTRA_SOURCES, TERRAIN_CHUNK_SIZE } from "./ingestion-contract";
import type { LocationCandidate } from "./types";
import { ArcgisCheckpointError, ArcgisInventoryError, ArcgisInventoryPending } from "./arcgis-inventory";
import { CrossingCheckpointError, CrossingInferencePending } from "./crossing-checkpoint";
import { InventoryCapacityError } from "./inventory-error";
import { DERIVED_ASSET_STATE } from "./ingestion-assets";
import * as preparation from "./ingestion-preparation";
import * as hydration from "./ingestion-hydration";
import * as database from "./supabase";
import * as supabaseBundle from "./fireafter-supabase";
import { hydrationFixture } from "../test/refresh-hydration-fixture";
import { queuePage } from "../test/queue-page-fixture";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { parseInventoryManifest } from "./inventory-manifest";
import { prepareIngestionPayload } from "./ingestion-payload";
import {sealNativeAcquisition,verifiedNativeAcquisition} from "./sentinel/native-provenance";

const state = vi.hoisted(() => ({ job: {} as IngestionJob, checkpoints: new Map<string, unknown>(),
  previousCheckpoints: new Map<string, unknown>(), previousJobs: vi.fn(), failure: vi.fn(), receipt: vi.fn(),
  verifyStaged: vi.fn(), stageRows: vi.fn(), stagePrepared: vi.fn(), stagedCommit: vi.fn(), reads: vi.fn(), fetches: vi.fn(), search: vi.fn(), assemble: vi.fn(), terrain: vi.fn(), commit: vi.fn(), persisted: vi.fn(), noteError: vi.fn(), failCheckpoint: "" }));
vi.mock("./ingestion-staged", () => ({ STAGED_HEADER_KEY: "commit:staged:header",
  verifyStagedCommitSecurity: (...args: unknown[]) => state.verifyStaged(...args),
  stageIngestionPayload: (...args: unknown[]) => state.stageRows(...args),
  stagePreparedIngestion: (...args: unknown[]) => state.stagePrepared(...args) }));
vi.mock("./ingestion-store", () => ({
  readIngestionJob: async () => state.job,
  previousIngestionJobs: (...args: unknown[]) => state.previousJobs(...args),
  readCheckpoint: async (id: string, key: string) => {
    state.reads(key);
    return (id === "previous" ? state.previousCheckpoints : state.checkpoints).get(key) ?? null;
  },
  putCheckpoint: async (_job: IngestionJob, key: string, value: unknown) => {
    state.checkpoints.set(key, value);
    if (state.failCheckpoint === key) { state.failCheckpoint = ""; throw new Error("lost checkpoint acknowledgment"); }
  },
  putAtomicCheckpoint: async (_job: IngestionJob, key: string, value: unknown) => { state.checkpoints.set(key, value); },
  readCommitReceipt: (...args: unknown[]) => state.receipt(...args),
  ingestionRpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "fireafter_claim_ingestion") return ["completed", "failed"].includes(state.job.status) ? null : { ...state.job, lease_id: args.p_lease };
    if (name === "fireafter_advance_ingestion") {
      state.job.stage = String(args.p_stage); state.job.progress = args.p_progress as IngestionJob["progress"];
      state.job.status = args.p_error ? "failed" : args.p_stage === "done" ? "completed" : "queued";
      state.job.error_code = args.p_error as string | null;
    }
    if (name === "fireafter_commit_ingestion") { state.commit(args); return "30000000-0000-4000-a000-000000000001"; }
    if (name === "fireafter_commit_staged_ingestion") { state.stagedCommit(args); return "30000000-0000-4000-a000-000000000001"; }
    if (name === "fireafter_note_ingestion_error") state.noteError(args);
    return null;
  },
}));
vi.mock("./fireafter-supabase", async importOriginal => ({
  ...await importOriginal<typeof import("./fireafter-supabase")>(),
  getSupabaseIncidentBundle: async () => null,
  getSupabaseRefreshHeader: async () => null,
  readSupabaseRefreshPage: vi.fn(), verifySupabaseRefreshHeader: vi.fn(),
  getSupabaseIncidentBundleByDatabaseId: (...args: unknown[]) => state.persisted(...args),
  buildSupabasePayload: (value: object) => ({ ...value, auditEvents: [] }),
}));
vi.mock("./live-sources", async importOriginal => ({
  ...await importOriginal<typeof import("./live-sources")>(),
  searchLocationsLive: (...args: unknown[]) => state.search(...args),
  applyLiveSignalsToIncident: (value: unknown) => value,
  enrichAssetsWithElevation: (...args: unknown[]) => state.terrain(...args),
  runLiveSourceRefresh: (...args: unknown[]) => state.assemble(...args),
  sourceFailureResult: (...args: unknown[]) => state.failure(...args),
  ...Object.fromEntries(["fetch3dhpFlowlinesSource", "fetchEpqsSource", "fetchFirmsSource", "fetchMtbsBurnSeveritySource", "fetchNbiBridgeSource", "fetchNwsObservationsSource", "fetchNwsSource", "fetchPwfdfSource", "fetchTigerRoadsSource", "fetchTnmStructuresSource", "fetchWfigsSource", "fetchWfigsYearToDateSource"]
    .map(key => [key, (...args: unknown[]) => state.fetches(key, ...args)])),
}));
import { runIngestionStep, reusableSource } from "./ingestion-worker";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  state.checkpoints.clear(); state.fetches.mockReset(); state.commit.mockReset(); state.persisted.mockReset(); state.terrain.mockReset(); state.assemble.mockReset();
  state.search.mockReset(); state.failCheckpoint = "";
  state.reads.mockReset();
  state.stageRows.mockReset(); state.stagedCommit.mockReset();
  state.stagePrepared.mockReset();
  state.verifyStaged.mockReset().mockResolvedValue(undefined);
  state.noteError.mockReset();
  state.receipt.mockReset().mockResolvedValue({ incident_id: "30000000-0000-4000-a000-000000000001", revision: "40000000-0000-4000-a000-000000000001" });
  state.previousCheckpoints.clear(); state.previousJobs.mockReset().mockResolvedValue([]);
  state.failure.mockReset().mockImplementation((key: string, _now: Date, error?: ArcgisInventoryError) => ({
    sourceKey: key, status: "offline", stale: true, rawPayload: { reason: error?.code ?? "upstream_unavailable" }, derivedSignals: {},
  }));
  state.job = { id: "50000000-0000-4000-a000-000000000001", actor_id: "10000000-0000-4000-a000-000000000001",
    organization_id: "20000000-0000-4000-a000-000000000001", incident_key: "incident-test", kind: "create", stage: "initialize", status: "queued", progress: {}, attempts: 0,
    seed: { incident: { id: "incident-test", county: "Test", state: "CA", locationContext: { id: "test" } } as IngestionJob["seed"]["incident"] },
    lease_id: null, error_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  state.fetches.mockResolvedValue({ sourceKey: "test", status: "online", stale: false, derivedSignals: {}, rawPayload: {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function nativeSigningFixture(){
  vi.stubEnv("SENTINEL_NATIVE_SIGNING_KEY_ID","74000000-0000-4000-8000-000000000001");
  vi.stubEnv("SENTINEL_NATIVE_SIGNING_ORGANIZATION_ID",state.job.organization_id);
  vi.stubEnv("SENTINEL_NATIVE_SIGNING_KEY_HEX","ad".repeat(32));
  return {sourceKey:"nbi-bridges",sourceName:"Synthetic bridge adapter",sourceUrl:"https://example.gov/bridges",fetchedAt:new Date().toISOString(),
    sourceUpdatedAt:"",sourceTimeBasis:"unknown" as const,validUntil:new Date(Date.now()+3600000).toISOString(),status:"online" as const,stale:false,
    coverageStatus:"available" as const,freshnessLabel:"Fixture",detail:"Synthetic",warnings:[],rawPayload:{features:[]},derivedSignals:{}};
}
it("seals fresh worker acquisition once and preserves its receipt after a lost checkpoint acknowledgment",async()=>{
  const source=nativeSigningFixture();await runIngestionStep(state.job.id);state.job.stage="source:bridges";
  state.fetches.mockResolvedValue(source);state.failCheckpoint="source:bridges";
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  const saved=state.checkpoints.get("source:bridges") as LiveSourceResult;
  expect(verifiedNativeAcquisition(saved,state.job.incident_key,state.job.organization_id)).not.toBeNull();
  expect(await runIngestionStep(state.job.id)).toBe("continue");expect(state.fetches).toHaveBeenCalledOnce();
  expect(state.checkpoints.get("source:bridges")).toEqual(saved);expect(saved.fetchedAt).toBe(source.fetchedAt);
});
it.each([false,true])("worker cache does not manufacture authority; existing signed=%s",async signed=>{
  const source=nativeSigningFixture();await runIngestionStep(state.job.id);state.job.stage="source:bridges";
  const cached=signed?sealNativeAcquisition(source,state.job.incident_key,"live"):source;
  state.previousJobs.mockResolvedValue([{id:"previous"}]);state.previousCheckpoints.set("source:bridges",cached);
  expect(await runIngestionStep(state.job.id)).toBe("continue");expect(state.fetches).not.toHaveBeenCalled();
  const saved=state.checkpoints.get("source:bridges") as LiveSourceResult;expect(saved).toEqual(cached);
  expect(Boolean(verifiedNativeAcquisition(saved,state.job.incident_key,state.job.organization_id))).toBe(signed);
});
it("worker resumes an old unsigned checkpoint without relabeling it as newly acquired evidence",async()=>{
  const source=nativeSigningFixture();await runIngestionStep(state.job.id);state.job.stage="source:bridges";state.checkpoints.set("source:bridges",source);
  expect(await runIngestionStep(state.job.id)).toBe("continue");expect(state.fetches).not.toHaveBeenCalled();
  expect((state.checkpoints.get("source:bridges") as LiveSourceResult).nativeAcquisition).toBeUndefined();
});

function compactCountyJob() {
  const location: LocationCandidate = { id: "el-dorado-county-ca", county: "El Dorado County", state: "CA", fips: "06017",
    label: "El Dorado County, CA", centroid: [-120.5, 38.8], fireWeatherZone: "", population: 0, wildfireContext: "Live Census",
    boundary: { type: "Polygon", coordinates: [Array.from({ length: 20_000 }, () => [-120.5, 38.8] as [number, number])] } };
  state.job.incident_key = `incident-${location.id}`;
  state.job.seed = { location: { id: location.id, county: location.county, state: location.state, fips: location.fips } };
  state.search.mockResolvedValue([location]);
  return location;
}

it("resolves a compact county seed and checkpoints its full geometry, not an envelope", async () => {
  const location = compactCountyJob();
  expect(Buffer.byteLength(JSON.stringify(location))).toBeGreaterThan(65_536);
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.search).toHaveBeenCalledWith(location.id);
  expect(state.checkpoints.get("base")).toMatchObject({ incident: { id: state.job.incident_key, locationContext: location } });
  expect(state.job.stage).toBe("source:wfigs");
  expect(state.commit).not.toHaveBeenCalled();
});
it("pins the expanded candidate policy only after staged security passes and preserves it after response loss", async () => {
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  state.failCheckpoint = "base";
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  expect(state.checkpoints.get("base")).toMatchObject({ stagedPublication: true });
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "false");
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.verifyStaged).toHaveBeenCalledTimes(1);
  state.job.stage = "derive:final";
  state.assemble.mockRejectedValue(new CrossingInferencePending(12, 21_000));
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.assemble).toHaveBeenCalledWith(expect.objectContaining({ crossingMaxCandidates: 100_000 }));
});
it("does not promote an existing legacy job when the operator later enables staged publication", async () => {
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "false");
  state.failCheckpoint = "base";
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  state.job.stage = "derive:final";
  state.assemble.mockRejectedValue(new CrossingInferencePending(1, 1));
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.assemble.mock.calls[0][0].crossingMaxCandidates).toBeUndefined();
});
it("does not initialize expanded ingestion when the staged security gate is unavailable", async () => {
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  state.verifyStaged.mockRejectedValue(new Error("security unavailable"));
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  expect(state.checkpoints.has("base")).toBe(false);
  expect(state.fetches).not.toHaveBeenCalled();
});
it("resumes prior-inventory hydration without loading the whole bundle or starting providers", async () => {
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  state.job.kind = "refresh";
  state.job.seed.targetId = "30000000-0000-4000-a000-000000000001";
  vi.spyOn(hydration, "hydratePreviousIncident").mockResolvedValue({ status: "pending", kind: "asset", saved: 500, total: 91_511 });
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.job.stage).toBe("initialize");
  expect(state.job.progress.inventory).toEqual({ source: "saved asset", saved: 500, total: 91_511 });
  expect(state.persisted).not.toHaveBeenCalled();
  expect(state.fetches).not.toHaveBeenCalled();
  expect(state.checkpoints.has("base")).toBe(false);
});
it("uses compact hydrated history and retains the point-inventory outage guard", async () => {
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  state.job.kind = "refresh";
  const value = { incident: state.job.seed.incident!, assets: [], previousTerrain: [], inventorySources: ["fhwa-nbi-bridges"],
    recommendations: [], sourceSnapshots: [], persistence: { organizationId: state.job.organization_id,
      expectedRevision: "40000000-0000-4000-a000-000000000001", databaseIncidentId: "30000000-0000-4000-a000-000000000001",
      rowIds: { asset: {}, source: {}, recommendation: {} } } };
  vi.spyOn(hydration, "hydratePreviousIncident").mockResolvedValue({ status: "ready", value });
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.checkpoints.get("base")).toMatchObject({ previousTerrain: [], inventorySources: value.inventorySources, write: value.persistence });
  state.job.stage = "source:bridges";
  state.fetches.mockResolvedValue({ status: "offline", rawPayload: {} });
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  expect(state.job.stage).toBe("source:bridges");
  expect(state.checkpoints.has("source:bridges")).toBe(false);
  expect(state.commit).not.toHaveBeenCalled();
});
it("stops a corrupt hydration checkpoint without publishing or falling back", async () => {
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  vi.spyOn(hydration, "hydratePreviousIncident").mockRejectedValue(new hydration.HydrationCheckpointError("invalid"));
  expect(await runIngestionStep(state.job.id)).toBe("stop");
  expect(state.job.error_code).toBe("hydration_checkpoint_invalid");
  expect(state.persisted).not.toHaveBeenCalled(); expect(state.commit).not.toHaveBeenCalled();
});
it("runs leased initialization through the real SDK reader and compact hydration until the next source stage", async () => {
  const actual = await vi.importActual<typeof import("./fireafter-supabase")>("./fireafter-supabase");
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const recommendations = queuePage(0, 20, 20).items.flatMap(item => item.status === "available" ? [{ ...item.recommendation,
    incidentId: incident.id, coordinates: [-118.25, 34.05] as [number, number] }] : []);
  const assets = recommendations.map(rec => ({ id: rec.assetId, incidentId: incident.id, name: rec.assetName, type: "Bridge" as const,
    coordinates: rec.coordinates, locationLabel: rec.locationLabel, source: "National Bridge Inventory", sourceKey: "fhwa-nbi-bridges",
    localOrUploaded: false, confidence: "Medium" as const }));
  const payload = actual.buildSupabasePayload({ incident, recommendations, sourceSnapshots: [] }, { assets, auditEvents: [],
    write: { actorId: state.job.actor_id, organizationId: state.job.organization_id, operation: "create", expectedRevision: null } });
  const server = await hydrationFixture(payload, { cap: 2, bounded: true });
  vi.spyOn(database, "getSupabaseAdminClient").mockReturnValue(server.client);
  vi.spyOn(supabaseBundle, "getSupabaseRefreshHeader").mockImplementation(actual.getSupabaseRefreshHeader);
  vi.spyOn(supabaseBundle, "readSupabaseRefreshPage").mockImplementation(actual.readSupabaseRefreshPage);
  vi.spyOn(supabaseBundle, "verifySupabaseRefreshHeader").mockImplementation(actual.verifySupabaseRefreshHeader);
  state.job.incident_key = incident.id; state.job.kind = "refresh"; state.job.seed = { targetId: payload.incident.id };
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  try {
    let calls = 0;
    do {
      expect(await runIngestionStep(state.job.id)).toBe("continue"); calls++;
      // The initialized job retains the admitted protocol if deployment flags change.
      vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "false");
    } while (state.job.stage === "initialize" && calls < 40);
    expect(state.job.stage).toBe("source:wfigs"); expect(calls).toBeGreaterThan(2);
    const full = actual.mapSupabaseRowsToBundle(payload);
    expect(state.checkpoints.get("base")).toMatchObject({ assets: [], inventorySources: ["fhwa-nbi-bridges"],
      write: full.persistence, previousRecommendations: full.recommendations.map(({ id, assetId, assetName, assetType, locationLabel, riskLevel, score100 }) =>
        ({ id, assetId, assetName, assetType, locationLabel, riskLevel, score100 })), stagedPublication: true, pagedPreparation: true });
    expect(state.verifyStaged).toHaveBeenCalledTimes(1);
    expect(state.persisted).not.toHaveBeenCalled(); expect(state.fetches).not.toHaveBeenCalled(); expect(state.commit).not.toHaveBeenCalled();
  } finally { await server.close(); }
}, 30_000);
it.each(["incident", "actor", "organization"])("rejects a changed saved %s scope during initialization recovery", async defect => {
  state.failCheckpoint = "base";
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  const base = state.checkpoints.get("base") as { incident: { id: string }; write: { actorId: string; organizationId: string } };
  if (defect === "incident") base.incident = { ...base.incident, id: "other" };
  if (defect === "actor") base.write.actorId = "other";
  if (defect === "organization") base.write.organizationId = "other";
  expect(await runIngestionStep(state.job.id)).toBe("stop");
  expect(state.job.error_code).toBe("FB400");
  expect(state.fetches).not.toHaveBeenCalled();
});
it.each(["fips", "state", "incident_key"])("rejects a county %s identity mismatch before saving evidence", async field => {
  const location = compactCountyJob();
  if (field === "incident_key") state.job.incident_key = "incident-other-county-ca";
  else state.search.mockResolvedValue([{ ...location, [field]: "wrong" }]);
  expect(await runIngestionStep(state.job.id)).toBe("stop");
  expect(state.job.error_code).toBe("FB400");
  expect(state.checkpoints.has("base")).toBe(false);
  expect(state.commit).not.toHaveBeenCalled();
});
it("waits for exact Census resolution after an outage, without inventing county geometry", async () => {
  const location = compactCountyJob();
  state.search.mockResolvedValueOnce([{ ...location, id: "wrong-county-ca" }]);
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  expect(state.job.stage).toBe("initialize");
  expect(state.checkpoints.has("base")).toBe(false);
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.job.stage).toBe("source:wfigs");
});

it("resumes from a saved source after a lost checkpoint acknowledgment without redownloading", async () => {
  await runIngestionStep(state.job.id);
  state.failCheckpoint = "source:wfigs";
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.fetches).toHaveBeenCalledTimes(1);
  expect(state.job.stage).toBe("source:nws");
});
it("keeps derivation on the same fenced stage while crossing pages are incomplete", async () => {
  await runIngestionStep(state.job.id);
  state.job.stage = "derive:final";
  state.assemble.mockRejectedValueOnce(new CrossingInferencePending(41, 1744));
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.job.stage).toBe("derive:final");
  expect(state.job.progress.crossings).toEqual({ roadsCompleted: 41, candidatesSaved: 1744 });
  expect(state.checkpoints.has("derived:final")).toBe(false);
  expect(state.commit).not.toHaveBeenCalled();
  const input = state.assemble.mock.calls[0][0];
  await input.crossingCheckpoint.write("crossings:test:state", { pages: 1 });
  await input.crossingCheckpoint.write("crossings:test:page:0", { candidates: [] });
  expect(await input.crossingCheckpoint.read("crossings:test:state")).toEqual({ pages: 1 });
  expect(await input.crossingCheckpoint.read("crossings:test:page:0")).toEqual({ candidates: [] });
  state.assemble.mockResolvedValueOnce({ assets: [] });
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.job.stage).toBe("prepare:final");
  expect(state.job.progress.crossings).toBeUndefined();
});
it("stops a deterministic candidate-capacity failure without retrying or publishing partial assets", async () => {
  await runIngestionStep(state.job.id);
  state.job.stage = "derive:final";
  state.assemble.mockRejectedValueOnce(new InventoryCapacityError("inference_candidates"));
  expect(await runIngestionStep(state.job.id)).toBe("stop");
  expect(state.job).toMatchObject({ status: "failed", stage: "derive:final", error_code: "inference_candidates" });
  expect(state.commit).not.toHaveBeenCalled();
  expect(state.checkpoints.has("derived:final")).toBe(false);
  expect(state.noteError).not.toHaveBeenCalled();
});
it.each(["invalid", "expired", "unavailable"] as const)("handles %s crossing checkpoints without publishing an incomplete derivation", async reason => {
  await runIngestionStep(state.job.id);
  state.job.stage = "derive:final";
  state.assemble.mockRejectedValueOnce(new CrossingCheckpointError(reason));
  expect(await runIngestionStep(state.job.id)).toBe(reason === "unavailable" ? "wait" : "stop");
  if (reason === "unavailable") expect(state.noteError).toHaveBeenCalledWith(expect.objectContaining({ p_code: "crossing_checkpoint_unavailable" }));
  else expect(state.job.error_code).toBe(`crossing_checkpoint_${reason}`);
  expect(state.commit).not.toHaveBeenCalled();
  expect(state.checkpoints.has("derived:final")).toBe(false);
});
it("records a provider outage and continues other sources", async () => {
  await runIngestionStep(state.job.id);
  state.fetches.mockRejectedValueOnce(new Error("provider offline"));
  await runIngestionStep(state.job.id);
  expect(state.checkpoints.get("source:wfigs")).toMatchObject({ status: "offline", stale: true });
  await runIngestionStep(state.job.id);
  expect(state.job.stage).toBe("source:observations");
});
it("preserves known inventory capacity reasons while withholding unexpected provider diagnostics", async () => {
  await runIngestionStep(state.job.id);
  state.job.stage = "source:hydro";
  const capacity = new ArcgisInventoryError("limit_exceeded");
  state.fetches.mockRejectedValueOnce(capacity);
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.failure).toHaveBeenCalledWith("hydro", expect.any(Date), capacity);
  expect(state.checkpoints.get("source:hydro")).toMatchObject({ rawPayload: { reason: "limit_exceeded" } });
  state.job.stage = "source:epqs";
  state.fetches.mockRejectedValueOnce(new Error("secret upstream body"));
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.failure).toHaveBeenLastCalledWith("epqs", expect.any(Date), undefined);
  expect(JSON.stringify(state.checkpoints.get("source:epqs"))).not.toContain("secret upstream body");
});

it.each(["bridges", "structures"])("keeps the committed inventory during a %s outage and retries the same stage", async key => {
  const sourceKey = key === "bridges" ? "fhwa-nbi-bridges" : "tnm-structures";
  const existing = { id: "known-asset", sourceKey, origin: "source" };
  const base = { incident: state.job.seed.incident, assets: [existing], write: { operation: "refresh" } };
  state.checkpoints.set("base", base);
  state.job.stage = `source:${key}`;
  state.fetches.mockRejectedValueOnce(new ArcgisInventoryError("timeout"));
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  expect(state.job.stage).toBe(`source:${key}`);
  expect(state.checkpoints.has(`source:${key}`)).toBe(false);
  expect(state.commit).not.toHaveBeenCalled();
  expect(state.noteError).toHaveBeenCalledWith(expect.objectContaining({ p_code: "inventory_refresh_unavailable" }));
  expect(base.assets).toEqual([existing]);
  const recovered = { sourceKey, status: "online", rawPayload: { assets: [existing], inventoryComplete: true } };
  state.fetches.mockResolvedValueOnce(recovered);
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.checkpoints.get(`source:${key}`)).toEqual(recovered);
  expect(state.job.stage).not.toBe(`source:${key}`);
  expect(state.fetches).toHaveBeenCalledTimes(2);
});

it.each(["partial", "missing completeness", "missing assets"])("refuses a %s point-inventory replacement without checkpointing it", async mode => {
  state.checkpoints.set("base", { incident: state.job.seed.incident, assets: [{ sourceKey: "tnm-structures" }], write: { operation: "refresh" } });
  state.job.stage = "source:structures";
  state.fetches.mockResolvedValueOnce({ status: mode === "partial" ? "delayed" : "online", rawPayload: {
    ...(mode === "missing completeness" ? {} : { inventoryComplete: mode !== "partial" }),
    ...(mode === "missing assets" ? {} : { assets: [] }),
  } });
  expect(await runIngestionStep(state.job.id)).toBe("wait");
  expect(state.checkpoints.has("source:structures")).toBe(false);
  expect(state.commit).not.toHaveBeenCalled();
});

it("accepts a verified complete-empty inventory without reviving retired assets", async () => {
  state.checkpoints.set("base", { incident: state.job.seed.incident, assets: [{ sourceKey: "fhwa-nbi-bridges" }], write: { operation: "refresh" } });
  state.job.stage = "source:bridges";
  const empty = { status: "online", stale: true, coverageStatus: "not_available", rawPayload: { inventoryComplete: true, assets: [] } };
  state.fetches.mockResolvedValueOnce(empty);
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.checkpoints.get("source:bridges")).toEqual(empty);
});

it("checkpoints hydro page progress on the same stage without publishing incomplete evidence", async () => {
  state.checkpoints.set("base", { incident: state.job.seed.incident, assets: [], write: { operation: "create" } });
  state.job.stage = "source:hydro";
  state.fetches.mockRejectedValueOnce(new ArcgisInventoryPending(800, 1601));
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.job.stage).toBe("source:hydro");
  expect(state.job.progress.inventory).toEqual({ source: "hydro", saved: 800, total: 1601 });
  expect(state.checkpoints.has("source:hydro")).toBe(false);
  expect(state.failure).not.toHaveBeenCalled();
  expect(state.commit).not.toHaveBeenCalled();
  const complete = { status: "online", rawPayload: { inventoryComplete: true, features: [] } };
  state.fetches.mockResolvedValueOnce(complete);
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.job.stage).toBe("source:epqs");
  expect(state.job.progress.inventory).toBeUndefined();
  expect(state.checkpoints.get("source:hydro")).toEqual(complete);
});

it.each([new ArcgisCheckpointError(), new ArcgisInventoryError("timeout"), new ArcgisInventoryError("provider_error")])(
  "keeps hydro checkpoint or transient failures retryable without recording an empty replacement: %s", async error => {
    state.checkpoints.set("base", { incident: state.job.seed.incident, assets: [], write: { operation: "create" } });
    state.job.stage = "source:hydro";
    state.fetches.mockRejectedValueOnce(error);
    expect(await runIngestionStep(state.job.id)).toBe("wait");
    expect(state.job.stage).toBe("source:hydro");
    expect(state.failure).not.toHaveBeenCalled();
    expect(state.checkpoints.has("source:hydro")).toBe(false);
    expect(state.commit).not.toHaveBeenCalled();
  },
);

it.each(["create", "no prior source assets", "uploaded"])("keeps degraded source behavior for %s", async mode => {
  state.checkpoints.set("base", { incident: state.job.seed.incident,
    assets: mode === "no prior source assets" ? [] : [{ sourceKey: "fhwa-nbi-bridges", origin: mode === "uploaded" ? "uploaded" : "source" }],
    write: { operation: mode === "create" ? "create" : "refresh" } });
  state.job.stage = "source:bridges";
  state.fetches.mockRejectedValueOnce(new ArcgisInventoryError("timeout"));
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.checkpoints.get("source:bridges")).toMatchObject({ status: "offline" });
});

it("reacquires an incomplete legacy checkpoint rather than advancing it over existing inventory", async () => {
  state.checkpoints.set("base", { incident: state.job.seed.incident, assets: [{ sourceKey: "fhwa-nbi-bridges" }], write: { operation: "refresh" } });
  state.checkpoints.set("source:bridges", { status: "offline", rawPayload: {} });
  state.job.stage = "source:bridges";
  const complete = { status: "online", rawPayload: { inventoryComplete: true, assets: [] } };
  state.fetches.mockResolvedValueOnce(complete);
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.checkpoints.get("source:bridges")).toEqual(complete);
  expect(state.fetches).toHaveBeenCalledOnce();
});
it("publishes core evidence before terrain and processes all 5,665 assets in bounded batches", async () => {
  const assets = Array.from({ length: 5665 }, (_, index) => ({ id: `asset-${index}`, origin: "inferred" }));
  const derived = { incident: state.job.seed.incident, assets, sourceSnapshots: [], recommendations: [] };
  state.assemble.mockImplementation(async input => ({ ...derived, assets: input.derivedAssets?.assets ?? assets }));
  state.terrain.mockImplementation(async assets => ({ assets, batchElevationUnavailable: false }));
  state.persisted.mockResolvedValue({ persistence: { databaseIncidentId: "30000000-0000-4000-a000-000000000001",
    organizationId: state.job.organization_id, expectedRevision: "40000000-0000-4000-a000-000000000001" } });
  for (let count = 0; count < 100; count++) {
    if (await runIngestionStep(state.job.id) === "stop") break;
    if (state.job.progress.published && state.terrain.mock.calls.length === 0) expect(state.commit).toHaveBeenCalledTimes(1);
  }
  expect(state.job.status).toBe("completed");
  expect(state.fetches).toHaveBeenCalledTimes(CORE_SOURCES.length + EXTRA_SOURCES.length);
  expect(state.terrain).toHaveBeenCalledTimes(Math.ceil(5665 / TERRAIN_CHUNK_SIZE));
  expect(state.terrain.mock.calls.flatMap(call => call[0])).toHaveLength(5665);
  expect(state.terrain.mock.calls.every(call => call[0].length <= TERRAIN_CHUNK_SIZE)).toBe(true);
  expect(state.terrain.mock.calls.every(call => call[2]?.retryTransient === true)).toBe(true);
  expect(state.commit).toHaveBeenCalledTimes(2);
  expect(state.assemble.mock.calls.at(-1)?.[0].derivedAssets.assets).toHaveLength(5665);
});
it("refuses to rebase a final enrichment over a changed incident revision", async () => {
  state.job.stage = "prepare:final";
  state.checkpoints.set("base", { incident: state.job.seed.incident, write: { operation: "create" } });
  state.checkpoints.set("derived:final", { assets: [] });
  state.persisted.mockResolvedValue({ persistence: { organizationId: state.job.organization_id, expectedRevision: "changed" } });
  expect(await runIngestionStep(state.job.id)).toBe("stop");
  expect(state.job.error_code).toBe("FB409");
  expect(state.commit).not.toHaveBeenCalled();
});
it("resumes legacy paged final staging with one preparation time and publishes only after every page is acknowledged", async () => {
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "false");
  await runIngestionStep(state.job.id);
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  const incident = state.job.seed.incident;
  const derived = { incident, assets: [], sourceSnapshots: [], recommendations: [] };
  state.assemble.mockResolvedValue(derived);
  state.persisted.mockResolvedValue({ persistence: { databaseIncidentId: "30000000-0000-4000-a000-000000000001",
    organizationId: state.job.organization_id, expectedRevision: "40000000-0000-4000-a000-000000000001" } });
  state.stageRows.mockImplementation(async () => {
    state.checkpoints.set("commit:staged:header", { incident });
    return state.stageRows.mock.calls.length > 1;
  });
  for (let count = 0; count < 30 && state.stageRows.mock.calls.length === 0; count++) await runIngestionStep(state.job.id);
  expect(state.job.stage).toBe("prepare:final");
  expect(state.stagedCommit).not.toHaveBeenCalled();
  expect(state.checkpoints.has("commit:final")).toBe(false);
  const time = state.checkpoints.get("commit:staged:time");
  expect(typeof time).toBe("string");
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "false");
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.job.stage).toBe("commit:final");
  expect(state.checkpoints.get("commit:staged:time")).toBe(time);
  const preparations = state.assemble.mock.calls.filter(([input]) => input.now);
  expect(preparations).toHaveLength(2);
  expect(preparations[0][0].now.toISOString()).toBe(time);
  expect(preparations[1][0].now.toISOString()).toBe(time);
  await runIngestionStep(state.job.id);
  expect(state.job.status).toBe("completed");
  expect(state.commit).toHaveBeenCalledTimes(1);
  expect(state.stagedCommit).toHaveBeenCalledTimes(1);
});
it("pins resumable preparation for new staged jobs and never invokes whole-payload staging", async () => {
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  await runIngestionStep(state.job.id);
  expect(state.checkpoints.get("base")).toMatchObject({ pagedPreparation: true });
  state.job.stage = "derive:final";
  state.assemble.mockResolvedValue({ assets: [] });
  await runIngestionStep(state.job.id);
  expect(state.job.stage).toBe("prepare:final");
  const prepare = vi.spyOn(preparation, "prepareIngestionPages").mockResolvedValueOnce(null);
  state.assemble.mockClear();
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "false");
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.assemble).not.toHaveBeenCalled();
  expect(state.stageRows).not.toHaveBeenCalled();
  expect(state.stagePrepared).not.toHaveBeenCalled();
  const plan = { version: 1, scope: "test", layout: "test", header: { incident: {} }, pages: { source: [], asset: [], recommendation: [] } } as unknown as preparation.PreparedPlan;
  prepare.mockResolvedValue(plan);
  state.stagePrepared.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await runIngestionStep(state.job.id); expect(state.job.stage).toBe("prepare:final");
  await runIngestionStep(state.job.id); expect(state.job.stage).toBe("commit:final");
  expect(state.stagePrepared).toHaveBeenCalledTimes(2);
  expect(state.stageRows).not.toHaveBeenCalled();
  expect(state.checkpoints.has("commit:final")).toBe(false);
});
async function firstPublicationFixture(defect?: string) {
  const actual = await vi.importActual<typeof import("./fireafter-supabase")>("./fireafter-supabase");
  vi.spyOn(supabaseBundle, "buildSupabasePayload").mockImplementation(actual.buildSupabasePayload);
  const live = await vi.importActual<typeof import("./live-sources")>("./live-sources");
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const assets = Array.from({ length: 20 }, (_, index) => ({ id: `bridge-${index}`, incidentId: incident.id,
    name: `Bridge ${index}`, type: "Bridge" as const, coordinates: [-118.25, 34.05] as [number, number],
    source: "National Bridge Inventory", sourceKey: "fhwa-nbi-bridges", locationLabel: "County creek",
    localOrUploaded: false, origin: "source" as const, confidence: "Low" as const }));
  const adapters = Object.fromEntries([...CORE_SOURCES, ...EXTRA_SOURCES].map(key => {
    const source = live.sourceFailureResult(key, new Date());
    state.checkpoints.set(`source:${key}`, source);
    return [key, async () => source];
  }));
  const derived = await live.runLiveSourceRefresh({ incident, assets: [], adapters, derivedAssets: { assets, batchElevationUnavailable: false } });
  const write = { actorId: state.job.actor_id, organizationId: state.job.organization_id, operation: "create" as const, expectedRevision: null };
  const payload = actual.buildSupabasePayload(derived, { assets, auditEvents: [], write });
  const server = await hydrationFixture(payload, { cap: 2, bounded: true, defect });
  vi.spyOn(database, "getSupabaseAdminClient").mockReturnValue(server.client);
  vi.spyOn(supabaseBundle, "getSupabaseRefreshHeader").mockImplementation(actual.getSupabaseRefreshHeader);
  vi.spyOn(supabaseBundle, "readSupabaseRefreshPage").mockImplementation(actual.readSupabaseRefreshPage);
  vi.spyOn(supabaseBundle, "verifySupabaseRefreshHeader").mockImplementation(actual.verifySupabaseRefreshHeader);
  state.job.incident_key = incident.id; state.job.seed = { incident }; state.job.stage = "derive:final";
  state.job.progress = { published: true };
  state.checkpoints.set("base", { incident, assets: [], previousRecommendations: [], previousSourceSnapshots: [], write,
    stagedPublication: true, pagedPreparation: true });
  // A different protocol's saved header must not be mistaken for the initial publication.
  state.checkpoints.set(hydration.HYDRATION_HEADER, { unrelatedInitialization: true });
  state.receipt.mockResolvedValue({ incident_id: payload.incident.id, revision: parseInventoryManifest(payload.incident.selected_fire.inventoryManifest)!.revision });
  state.assemble.mockImplementation(live.runLiveSourceRefresh).mockResolvedValueOnce(derived);
  state.terrain.mockImplementation(async assets => ({ assets, batchElevationUnavailable: false }));
  state.stagePrepared.mockResolvedValue(true);
  return { ...server, payload, actual, live, assets, incident };
}
it.each([false, true])("seals final preparation from a resumable first-publication read, lost-header-ack=%s", async loseAck => {
  const f = await firstPublicationFixture();
  if (loseAck) state.failCheckpoint = `enrich:${hydration.HYDRATION_HEADER}`;
  try {
    let waiting = 0, sawProgress = false, originalTime: string | undefined;
    for (let calls = 0; calls < 80 && state.job.stage !== "commit:final"; calls++) {
      const result = await runIngestionStep(state.job.id);
      expect(result, `${state.job.stage}:${state.job.error_code}`).not.toBe("stop"); waiting += Number(result === "wait");
      sawProgress ||= state.job.progress.inventory?.source.startsWith("published ") === true;
      const saved = state.checkpoints.get(preparation.PREPARATION_STATE) as { time: string } | undefined;
      if (saved) { originalTime ??= saved.time; expect(saved.time).toBe(originalTime); }
    }
    expect(state.job.stage).toBe("commit:final"); expect(waiting).toBe(Number(loseAck)); expect(sawProgress).toBe(true);
    expect(state.job.progress.inventory).toBeUndefined();
    expect(state.persisted).not.toHaveBeenCalled(); expect(state.fetches).not.toHaveBeenCalled();
    expect(state.commit).not.toHaveBeenCalled(); expect(state.stageRows).not.toHaveBeenCalled();
    expect(state.stagePrepared).toHaveBeenCalledOnce();
    const header = state.stagePrepared.mock.calls[0][1];
    const persistence = f.actual.mapSupabaseRowsToBundle(f.payload).persistence;
    expect(header.write).toEqual({ databaseIncidentId: persistence.databaseIncidentId, organizationId: persistence.organizationId,
      expectedRevision: persistence.expectedRevision, actorId: state.job.actor_id, operation: "refresh" });
    const inventory = parseInventoryManifest(header.incident.selected_fire.inventoryManifest)!;
    expect(new Set(inventory.assetIds)).toEqual(new Set(f.payload.assets.map(row => row.id)));
    const capture = state.assemble.mock.calls.find(([input]) => input.onRecommendationContext)?.[0];
    expect(capture.now.toISOString()).toBe(originalTime);
    const expected = prepareIngestionPayload(state.job.id, "final", await f.live.runLiveSourceRefresh({ ...capture,
      onRecommendationContext: undefined, derivedAssets: { assets: f.assets, batchElevationUnavailable: false } }),
    { actorId: state.job.actor_id, operation: "refresh", ...persistence }, new Date(originalTime!));
    const readPage = state.stagePrepared.mock.calls[0][3];
    for (const [kind, rows] of [["asset", expected.assets], ["recommendation", expected.recommendations]] as const) {
      const actual: unknown[] = [];
      while (actual.length < rows.length) actual.push(...await readPage(kind, actual.length));
      expect(new Map(actual.map(row => [(row as { id: string }).id, row]))).toEqual(new Map(JSON.parse(JSON.stringify(rows)).map((row: { id: string }) => [row.id, row])));
    }
    expect(state.checkpoints.get(hydration.HYDRATION_HEADER)).toEqual({ unrelatedInitialization: true });
    expect([...state.checkpoints.keys()].filter(key => key.startsWith("enrich:")).every(key => /^[a-zA-Z0-9:_-]{1,80}$/.test(key))).toBe(true);
  } finally { await f.close(); }
}, 30_000);
it.each(["revision", "wrong-target", "authority", "missing", "receipt-drift", "parent-drift", "missing-receipt"])("does not prepare final writes after first-publication %s", async defect => {
  const f = await firstPublicationFixture(defect === "authority" ? "foreign" : defect === "missing" ? "missing-incident" : undefined);
  try {
    if (defect === "revision") state.receipt.mockResolvedValue({ incident_id: f.payload.incident.id, revision: "40000000-0000-4000-a000-000000000001" });
    if (defect === "wrong-target") state.receipt.mockResolvedValue({ incident_id: "30000000-0000-4000-a000-000000000001", revision: parseInventoryManifest(f.payload.incident.selected_fire.inventoryManifest)!.revision });
    if (defect === "missing-receipt") state.receipt.mockResolvedValue(null);
    let result: string | undefined;
    for (let calls = 0; calls < 30; calls++) {
      result = await runIngestionStep(state.job.id);
      if (result !== "continue") break;
      if (state.checkpoints.has(`enrich:${hydration.HYDRATION_STATE}`)) {
        if (defect === "receipt-drift") state.receipt.mockResolvedValue({ incident_id: f.payload.incident.id, revision: "40000000-0000-4000-a000-000000000001" });
        if (defect === "parent-drift") f.payload.incident.title = "Changed after initial publication";
      }
    }
    expect(result).toBe(defect === "missing-receipt" ? "wait" : "stop");
    if (defect !== "missing-receipt") expect(state.job.error_code).toBe(defect === "authority" ? "FB401" : defect === "missing" ? "FB404" : defect === "receipt-drift" ? "hydration_checkpoint_invalid" : "FB409");
    expect(state.persisted).not.toHaveBeenCalled(); expect(state.commit).not.toHaveBeenCalled();
    expect(state.stageRows).not.toHaveBeenCalled(); expect(state.stagePrepared).not.toHaveBeenCalled();
  } finally { await f.close(); }
}, 30_000);
it("stops corrupt prepared-page state without publishing or falling back to whole payloads", async () => {
  vi.stubEnv("FIREAFTER_STAGED_COMMIT_ENABLED", "true");
  await runIngestionStep(state.job.id); state.job.stage = "derive:final";
  state.assemble.mockResolvedValue({ assets: [] }); await runIngestionStep(state.job.id);
  vi.spyOn(preparation, "prepareIngestionPages").mockRejectedValue(new preparation.PreparationCheckpointError("invalid"));
  expect(await runIngestionStep(state.job.id)).toBe("stop");
  expect(state.job.error_code).toBe("preparation_checkpoint_invalid");
  expect(state.stageRows).not.toHaveBeenCalled(); expect(state.stagePrepared).not.toHaveBeenCalled();
});
it("reads only one derived asset page during a terrain step, not source or recommendation payloads", async () => {
  await runIngestionStep(state.job.id);
  state.job.stage = "derive:final";
  const assets = Array.from({ length: 259 }, (_, index) => ({ id: `asset-${index}`, origin: "inferred" }));
  state.assemble.mockResolvedValue({ assets });
  state.terrain.mockImplementation(async assets => ({ assets, batchElevationUnavailable: false }));
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.checkpoints.has("derived:final")).toBe(false);
  expect(state.job.stage).toBe("terrain:0");
  state.job.stage = "terrain:1";
  state.reads.mockClear();
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.terrain.mock.calls[0][0]).toEqual(assets.slice(128, 256));
  expect(state.reads.mock.calls.map(call => call[0])).toEqual([DERIVED_ASSET_STATE, "terrain:1", expect.stringMatching(/^da:[a-f0-9]{64}$/)]);
});
it("uses a sealed page manifest after an advance acknowledgment is lost, without deriving again", async () => {
  await runIngestionStep(state.job.id);
  state.job.stage = "derive:final";
  state.assemble.mockResolvedValue({ assets: [{ id: "a", origin: "inferred" }] });
  await runIngestionStep(state.job.id);
  state.job.stage = "derive:final";
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.assemble).toHaveBeenCalledTimes(1);
  expect(state.job.stage).toBe("terrain:0");
});
it("resumes an existing legacy terrain job without requiring a new-format manifest", async () => {
  state.job.stage = "terrain:0";
  state.checkpoints.set("derived:final", { assets: [{ id: "a" }] });
  state.terrain.mockImplementation(async assets => ({ assets, batchElevationUnavailable: false }));
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  expect(state.job.stage).toBe("prepare:final");
  expect(state.terrain.mock.calls[0][0]).toEqual([{ id: "a" }]);
});
it("does not fall back to a legacy inventory when a new-format manifest is corrupt", async () => {
  state.job.stage = "terrain:0";
  state.checkpoints.set("derived:final", { assets: [{ id: "a" }] });
  state.checkpoints.set(DERIVED_ASSET_STATE, { version: 1 });
  expect(await runIngestionStep(state.job.id)).toBe("stop");
  expect(state.job.error_code).toBe("derived_asset_checkpoint_invalid");
  expect(state.terrain).not.toHaveBeenCalled();
  expect(state.commit).not.toHaveBeenCalled();
});
it.each(["new", "saved"])("rejects %s terrain results that omit or substitute input assets", async mode => {
  state.job.stage = "terrain:0";
  state.checkpoints.set("derived:final", { assets: [{ id: "a" }] });
  const wrong = { assets: [{ id: "another" }], batchElevationUnavailable: false };
  if (mode === "saved") state.checkpoints.set("terrain:0", wrong);
  else state.terrain.mockResolvedValue(wrong);
  expect(await runIngestionStep(state.job.id)).toBe("stop");
  expect(state.job.error_code).toBe("derived_asset_checkpoint_invalid");
  expect(state.commit).not.toHaveBeenCalled();
});
it("does not renew cached evidence timestamps or accept expired/future evidence", () => {
  const now = Date.now();
  const source = { fetchedAt: new Date(now - 60_000).toISOString(), status: "online", stale: false, coverageStatus: "available" } as LiveSourceResult;
  expect(reusableSource(source, now)).toBe(true);
  expect(reusableSource({ ...source, fetchedAt: new Date(now - 2 * 24 * 3600_000).toISOString() }, now)).toBe(false);
  expect(reusableSource({ ...source, fetchedAt: new Date(now + 60_000).toISOString() }, now)).toBe(false);
});

it("requires ten minutes of remaining retrieval and provider validity without renewing timestamps", () => {
  vi.stubEnv("FIREAFTER_CACHE_TTL_MINUTES", "30");
  const now = Date.now();
  const source = Object.freeze({ fetchedAt: new Date(now - 60_000).toISOString(), status: "online", stale: false, coverageStatus: "available" }) as LiveSourceResult;
  const atAge = (minutes: number) => ({ ...source, fetchedAt: new Date(now - minutes * 60_000).toISOString() });
  expect(reusableSource(atAge(19), now)).toBe(true);
  expect(reusableSource(atAge(20), now)).toBe(false);
  expect(reusableSource(atAge(28), now)).toBe(false);
  expect(reusableSource({ ...source, validUntil: new Date(now + 9 * 60_000).toISOString() }, now)).toBe(false);
  expect(reusableSource({ ...source, validUntil: new Date(now + 11 * 60_000).toISOString() }, now)).toBe(true);
  expect(reusableSource({ ...source, validUntil: "invalid" }, now)).toBe(false);
  expect(reusableSource(source, now)).toBe(true);
  expect(source.fetchedAt).toBe(new Date(now - 60_000).toISOString());
  vi.stubEnv("FIREAFTER_CACHE_TTL_MINUTES", "5");
  expect(reusableSource(source, now)).toBe(false);
});

it.each([1, 28])("worker reuses only safe cache entries and fetches nearly expired bridges (age %s minutes)", async age => {
  vi.stubEnv("FIREAFTER_CACHE_TTL_MINUTES", "30");
  await runIngestionStep(state.job.id);
  state.job.stage = "source:bridges";
  const source = { fetchedAt: new Date(Date.now() - age * 60_000).toISOString(), status: "online", stale: false,
    coverageStatus: "available", rawPayload: {}, derivedSignals: {} } as LiveSourceResult;
  state.previousJobs.mockResolvedValue([{ id: "previous" }]);
  state.previousCheckpoints.set("source:bridges", source);
  expect(await runIngestionStep(state.job.id)).toBe("continue");
  if (age === 1) {
    expect(state.fetches).not.toHaveBeenCalled();
    expect(state.checkpoints.get("source:bridges")).toEqual(source);
  } else {
    expect(state.fetches).toHaveBeenCalledOnce();
    expect(state.fetches.mock.calls[0][0]).toBe("fetchNbiBridgeSource");
    expect(state.checkpoints.get("source:bridges")).not.toEqual(source);
  }
});
