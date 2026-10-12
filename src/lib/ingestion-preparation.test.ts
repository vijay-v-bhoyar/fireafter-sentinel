import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareIngestionPages, PREPARATION_STATE, PREPARATION_READY, preparedCounts, readPreparedRows,
  readPreparedTransferRows, readPreparedPlan, type PreparationInput, type PreparedPlan } from "./ingestion-preparation";
import { prepareIngestionPayload } from "./ingestion-payload";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { INGESTION_SOURCES } from "./ingestion-contract";
import { runLiveSourceRefresh, sourceFailureResult, type AdapterMap, type LiveRecommendationContext } from "./live-sources";
import { encodeCheckpoint } from "./ingestion-checkpoint";
import type { Asset } from "./types";
import type { BundleWrite } from "./bundle-write";
import { parseInventoryManifest } from "./inventory-manifest";
import { queueReadPageIds } from "./queue-read-index";
import { MAP_VIEW_VERSION } from "./map-viewport-contract";
import { SOURCE_SPATIAL_ENCODING } from "./source-spatial-storage";
import { SOURCE_VIEW_VERSION } from "./source-viewport-contract";
import { SOURCE_LINE_GEOMETRY_VERSION } from "./source-line-geometry";
import { unpackSourcePayload } from "./source-payload-storage";
import { jsonbTextBytes } from "./ingestion-jsonb-size";
import { encodeStagedRows } from "./ingestion-row-page";

beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function fixture(count = 270) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const assets: Asset[] = Array.from({ length: count }, (_, index) => ({ id: `asset-${index}`, incidentId: incident.id,
    name: `Bridge ${String(count - index).padStart(6, "0")}`, type: "Bridge", source: "Fixture", locationLabel: `Stream ${index}`,
    coordinates: [-118.2, 34.2], localOrUploaded: false, origin: "source", confidence: "Low", sourceFeatureId: String(index),
    sourceKey: "fhwa-nbi-bridges", coverageStatus: "available", metrics: { slopeTerrain: index % 2 ? 0.7 : undefined, downstreamExposure: 0.6 } }));
  const write: BundleWrite = { actorId: randomUUID(), organizationId: randomUUID(), expectedRevision: randomUUID(),
    databaseIncidentId: randomUUID(), operation: "refresh", rowIds: { asset: { "asset-0": randomUUID() },
      recommendation: { [`rec-${incident.id}-asset-0`]: randomUUID() }, source: {} } };
  const saved = new Map<string, unknown>(), reads: string[] = [], terrainReads: number[] = [];
  let failKey = "", failAfter = true, contextCalls = 0;
  const store = { read: async (key: string) => { reads.push(key); return structuredClone(saved.get(key) ?? null); },
    write: async (key: string, value: unknown) => {
      if (key === PREPARATION_STATE) expect(encodeCheckpoint(value).parts).toHaveLength(1);
      const failed = failKey && (key === failKey || key.startsWith(failKey));
      if (failed && !failAfter) { failKey = ""; throw new Error("storage unavailable"); }
      saved.set(key, structuredClone(value));
      if (failed) { failKey = ""; throw new Error("lost acknowledgment"); }
    } };
  const assemble = async (now: Date, pageAssets: Asset[], unavailable: boolean, capture?: (value: LiveRecommendationContext) => void) => {
    const adapters: Partial<AdapterMap> = Object.fromEntries(INGESTION_SOURCES.map(key => [key, async () => sourceFailureResult(key, now)]));
    return runLiveSourceRefresh({ incident, assets: [], adapters, now, derivedAssets: { assets: pageAssets, batchElevationUnavailable: unavailable },
      onRecommendationContext: capture });
  };
  const input: PreparationInput = { jobId: randomUUID(), scope: "test-scope", layout: "test-layout", totalPages: Math.ceil(count / 128),
    readTerrain: async index => { terrainReads.push(index); return { assets: structuredClone(assets.slice(index * 128, (index + 1) * 128)),
      batchElevationUnavailable: index === 1 }; },
    createContext: async (unavailable, now) => {
      contextCalls++;
      let context: LiveRecommendationContext | undefined;
      const derived = await assemble(now, [], unavailable, value => { context = value; });
      return { context: context!, derived, write };
    } };
  const tick = () => prepareIngestionPages(store, input);
  const finish = async () => {
    for (let index = 0; index < 500; index++) { const result = await tick(); if (result) return result; }
    throw new Error("preparation did not finish");
  };
  return { assets, write, saved, store, input, tick, finish, terrainReads, reads, contextCalls: () => contextCalls,
    fail: (key: string, after = true) => { failKey = key; failAfter = after; },
    reference: async () => {
      const time = (saved.get(PREPARATION_STATE) as { time: string }).time;
      return prepareIngestionPayload(input.jobId, "final", await assemble(new Date(time), assets, count > 128), write, new Date(time));
    } };
}
async function rows(f: ReturnType<typeof fixture>, plan: PreparedPlan, kind: "asset" | "recommendation" | "source") {
  const result: { id: string }[] = [];
  while (result.length < preparedCounts(plan)[kind]) result.push(...await readPreparedRows(f.store, plan, kind, result.length));
  return result;
}
it("prepares exact full persistence rows, global rank explanations and alias IDs without collecting terrain pages", async () => {
  const f = fixture(2307), plan = await f.finish(), expected = await f.reference();
  const actualAssets = await rows(f, plan, "asset"), actualRecommendations = await rows(f, plan, "recommendation");
  expect(actualAssets).toEqual(JSON.parse(JSON.stringify(expected.assets)));
  const byId = (items: { id: string }[]) => new Map(items.map(item => [item.id, item]));
  expect(byId(actualRecommendations)).toEqual(byId(JSON.parse(JSON.stringify(expected.recommendations))));
  expect(await rows(f, plan, "source")).toEqual(JSON.parse(JSON.stringify(expected.sourceSnapshots)));
  const expectedInventory = expected.incident.selected_fire.inventoryManifest as { revision: string };
  expectedInventory.revision = (plan.header.incident.selected_fire.inventoryManifest as { revision: string }).revision;
  expect(plan.header.incident).toEqual(JSON.parse(JSON.stringify(expected.incident)));
  const inventory = parseInventoryManifest(plan.header.incident.selected_fire.inventoryManifest)!;
  const expectedIds = expected.recommendations.map(row => row.id);
  for (const start of [0, 1150, 2300]) expect(queueReadPageIds(inventory, { revision: inventory.revision, state: "current", start, limit: 25 })).toEqual(expectedIds.slice(start, start + 25));
  expect(plan.header.auditEvents).toEqual(JSON.parse(JSON.stringify(expected.auditEvents)));
  expect(f.contextCalls()).toBe(1);
  expect(f.terrainReads).toHaveLength(f.input.totalPages * 3);
  expect((await f.tick())?.header).toEqual(plan.header);
  expect(f.contextCalls()).toBe(1);
});
it("binds every paged asset map projection to the single published revision", async () => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "true");
  const f = fixture(259), plan = await f.finish();
  const inventory = parseInventoryManifest(plan.header.incident.selected_fire.inventoryManifest)!;
  const assets = await rows(f, plan, "asset") as { id: string; properties: Record<string, unknown> }[];
  expect(plan.header.incident.selected_fire.mapReadContext).toMatchObject({ version: MAP_VIEW_VERSION });
  expect(assets).toHaveLength(259);
  for (const asset of assets) expect(asset.properties.mapReadModel).toMatchObject({ version: MAP_VIEW_VERSION, revision: inventory.revision });
});
it.each([true, false])("pins map projection enabled=%s across flag changes before context and between pages", async enabled => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", String(enabled));
  const f = fixture(1160);
  await f.tick();
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", String(!enabled));
  while ((f.saved.get(PREPARATION_STATE) as { phase: string }).phase !== "finalize") await f.tick();
  await f.tick();
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", String(enabled));
  const plan = await f.finish(), assets = await rows(f, plan, "asset") as { id: string; properties: Record<string, unknown> }[];
  const revision = parseInventoryManifest(plan.header.incident.selected_fire.inventoryManifest)!.revision;
  expect(Boolean(plan.header.incident.selected_fire.mapReadContext)).toBe(enabled);
  for (const asset of assets) {
    if (enabled) expect(asset.properties.mapReadModel).toMatchObject({ version: MAP_VIEW_VERSION, revision });
    else expect(asset.properties.mapReadModel).toBeUndefined();
  }
});
it("does not retrofit map projections into a legacy saved preparation", async () => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "true");
  const f = fixture(259); await f.tick();
  delete (f.saved.get(PREPARATION_STATE) as { assetMapVersion?: string }).assetMapVersion;
  const plan = await f.finish(), assets = await rows(f, plan, "asset") as { id: string; properties: Record<string, unknown> }[];
  expect(plan.header.incident.selected_fire.mapReadContext).toBeUndefined();
  expect(assets.every(asset => asset.properties.mapReadModel === undefined)).toBe(true);
});
it("reuses identical map page content after a lost write acknowledgment", async () => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "true");
  const f = fixture(259);
  while ((f.saved.get(PREPARATION_STATE) as { phase: string } | undefined)?.phase !== "finalize") await f.tick();
  const keys = new Set(f.saved.keys());
  f.fail("pp:"); await expect(f.tick()).rejects.toThrow("lost acknowledgment");
  const written = [...f.saved.keys()].filter(key => !keys.has(key));
  expect(written).toHaveLength(1);
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "false");
  const plan = await f.finish();
  expect(`pp:${plan.pages.asset[0].hash}`).toBe(written[0]);
  expect((await f.tick())?.header).toEqual(plan.header);
});
it("rejects an unsupported saved map projection version before building pages", async () => {
  const f = fixture(); await f.tick();
  Object.assign(f.saved.get(PREPARATION_STATE)!, { assetMapVersion: "unknown-version" });
  await expect(f.finish()).rejects.toThrow("preparation_checkpoint_invalid");
  expect(f.saved.has(PREPARATION_READY)).toBe(false);
});
it.each(["enabled", "disabled", "legacy"] as const)("pins %s spatial source storage through flag changes and lost acknowledgments", async mode => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", String(mode !== "disabled"));
  const f = fixture(3), originalCreate = f.input.createContext;
  const payload = { geometryVersion: SOURCE_LINE_GEOMETRY_VERSION, featureCount: 1, inventoryComplete: true,
    features: [{ id: "road-1", sourceKey: "tiger-roads", sourceName: "Census TIGERweb", paths: [[[-118.2, 34.2], [-118.1, 34.3]]] }] };
  f.input.createContext = async (...args) => {
    const result = (await originalCreate(...args))!;
    const source = result.derived.sourceSnapshots.find(row => row.sourceKey === "tiger-roads")!;
    Object.assign(source, { sourceName: "Census TIGERweb", coverageStatus: "available", status: "online", stale: false,
      warnings: [], detail: "Complete roads", rawPayload: payload });
    return result;
  };
  await f.tick();
  if (mode === "legacy") delete (f.saved.get(PREPARATION_STATE) as { sourceSpatialEncoding?: string }).sourceSpatialEncoding;
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", String(mode === "disabled"));
  // Failed acknowledgment after persisting the source page, before the checkpoint advances.
  f.fail("pp:"); await expect(f.tick()).rejects.toThrow("lost acknowledgment");
  const existingKeys = [...f.saved.keys()].filter(key => key.startsWith("pp:"));
  const plan = await f.finish();
  for (const key of existingKeys) expect(plan.pages.source.some(page => `pp:${page.hash}` === key)).toBe(true);
  const sources = await rows(f, plan, "source") as { id: string; source_key: string; raw_payload: Record<string, unknown> }[];
  const source = sources.find(row => row.source_key === "tiger-roads")!;
  expect(source.raw_payload.rawPayloadEncoding).toBe(mode === "enabled" ? SOURCE_SPATIAL_ENCODING : undefined);
  expect(unpackSourcePayload(source.raw_payload)).toEqual(payload);
});
it("rejects unsupported source chunk encoding in a saved job", async () => {
  const f = fixture(); await f.tick();
  Object.assign(f.saved.get(PREPARATION_STATE)!, { sourceSpatialEncoding: "future" });
  await expect(f.finish()).rejects.toThrow("preparation_checkpoint_invalid");
  expect(f.saved.has(PREPARATION_READY)).toBe(false);
});
it.each([true, false])("pins source map projection enabled=%s without retrofitting old chunk jobs", async enabled => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "true");
  const f = fixture(3); await f.tick();
  if (!enabled) {
    delete (f.saved.get(PREPARATION_STATE) as { sourceMapVersion?: string }).sourceMapVersion;
    delete (f.saved.get(PREPARATION_STATE) as { publicationRevision?: string }).publicationRevision;
  }
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "false");
  const plan = await f.finish(), sourceRows = await rows(f, plan, "source") as { id: string; raw_payload: { sourceMapReadModel?: unknown } }[];
  const revision = parseInventoryManifest(plan.header.incident.selected_fire.inventoryManifest)!.revision;
  for (const row of sourceRows) {
    if (enabled) expect(row.raw_payload.sourceMapReadModel).toMatchObject({ version: SOURCE_VIEW_VERSION, revision, projection: { id: row.id } });
    else expect(row.raw_payload.sourceMapReadModel).toBeUndefined();
  }
});
it.each([undefined, "not-a-revision"])("rejects a source-index job with invalid initial revision %s", async revision => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "true");
  const f = fixture(3); await f.tick();
  Object.assign(f.saved.get(PREPARATION_STATE)!, { publicationRevision: revision });
  await expect(f.finish()).rejects.toThrow("preparation_checkpoint_invalid");
});
it("packs at most two prepared pages without dropping rows or changing their order", async () => {
  const f = fixture(259), plan = await f.finish();
  expect(plan.transferRows).toBe(256);
  const first = await readPreparedTransferRows(f.store, plan, "asset", 0);
  const last = await readPreparedTransferRows(f.store, plan, "asset", first.length);
  expect(first).toHaveLength(256); expect(last).toHaveLength(3);
  expect([...first, ...last]).toEqual(await rows(f, plan, "asset"));
  expect(await readPreparedTransferRows(f.store, plan, "asset", 128)).toEqual((await rows(f, plan, "asset")).slice(128));
});
it.each([true, false])("keeps global ranks exact with compact lookup enabled=%s and preserves legacy preparation", async compact => {
  const f = fixture(2307); await f.tick();
  if (!compact) delete (f.saved.get(PREPARATION_STATE) as { rankLookupVersion?: number }).rankLookupVersion;
  while ((f.saved.get(PREPARATION_STATE) as { phase: string }).phase !== "finalize") await f.tick();
  const state = f.saved.get(PREPARATION_STATE) as { root: { hash: string }; rankLookup?: { hash: string } };
  f.reads.length = 0;
  await f.tick();
  expect(f.reads.includes(`pp:${state.root.hash}`)).toBe(!compact);
  if (compact) expect(f.reads).toContain(`pp:${state.rankLookup!.hash}`);
  const plan = await f.finish(), expected = await f.reference();
  const byId = (items: { id: string }[]) => new Map(items.map(item => [item.id, item]));
  expect(byId(await rows(f, plan, "recommendation"))).toEqual(byId(JSON.parse(JSON.stringify(expected.recommendations))));
});
it("rejects a non-permutation compact rank lookup even when its content descriptor matches", async () => {
  const f = fixture(259);
  while ((f.saved.get(PREPARATION_STATE) as { phase: string } | undefined)?.phase !== "finalize") await f.tick();
  const state = f.saved.get(PREPARATION_STATE) as { rankLookup: { hash: string; bytes: number; jsonbBytes: number; count: number } };
  const invalid = Array.from({ length: 259 }, () => 1), text = JSON.stringify(invalid);
  state.rankLookup = { hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), jsonbBytes: jsonbTextBytes(text), count: invalid.length };
  f.saved.set(`pp:${state.rankLookup.hash}`, invalid);
  await expect(f.finish()).rejects.toThrow("preparation_checkpoint_invalid");
});
it("checks a valid lookup permutation against the complete ranking before sealing", async () => {
  const f = fixture(259);
  while ((f.saved.get(PREPARATION_STATE) as { phase: string } | undefined)?.phase !== "finalize") await f.tick();
  const state = f.saved.get(PREPARATION_STATE) as { rankLookup: { hash: string; bytes: number; jsonbBytes: number; count: number } };
  const wrong = structuredClone(f.saved.get(`pp:${state.rankLookup.hash}`)) as number[];
  [wrong[0], wrong[1]] = [wrong[1], wrong[0]];
  const text = JSON.stringify(wrong);
  state.rankLookup = { hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), jsonbBytes: jsonbTextBytes(text), count: wrong.length };
  f.saved.set(`pp:${state.rankLookup.hash}`, wrong);
  await expect(f.finish()).rejects.toThrow("preparation_checkpoint_invalid");
  expect(f.saved.has(PREPARATION_READY)).toBe(false);
});
it("keeps legacy page boundaries and binds new transfer packing into the sealed digest", async () => {
  const old = fixture(259); await old.tick();
  delete (old.saved.get(PREPARATION_STATE) as { transferRows?: number }).transferRows;
  const legacy = await old.finish();
  expect(legacy.transferRows).toBeUndefined();
  expect(await readPreparedTransferRows(old.store, legacy, "asset", 0)).toHaveLength(128);
  const f = fixture(259); await f.finish();
  delete (f.saved.get(PREPARATION_READY) as PreparedPlan).transferRows;
  await expect(readPreparedPlan(f.store, f.input.scope, f.input.layout)).rejects.toThrow("preparation_checkpoint_invalid");
});
it("retains separate pages when combining them would exceed the sealed encoded byte accounting", async () => {
  const f = fixture(256);
  for (const [index, asset] of f.assets.entries()) asset.source = (index < 128 ? "a" : "b").repeat(10_000);
  const plan = await f.finish();
  expect(await readPreparedTransferRows(f.store, plan, "asset", 0)).toHaveLength(128);
});
it("does not let compact shared fields conceal an oversized expanded transfer", async () => {
  const f = fixture(192), plan = await f.finish(), original = await rows(f, plan, "asset");
  const expanded = original.map(row => ({ ...row, repeated: "x".repeat(200_000) }));
  plan.pages.asset = [expanded.slice(0, 96), expanded.slice(96)].map(page => {
    const text = JSON.stringify(page), hash = createHash("sha256").update(text).digest("hex");
    f.saved.set(`pp:${hash}`, page);
    return { hash, count: page.length, bytes: Buffer.byteLength(text), jsonbBytes: jsonbTextBytes(text),
      stagedBytes: jsonbTextBytes(JSON.stringify(encodeStagedRows(page, plan.rowEncoding))) };
  });
  expect(jsonbTextBytes(JSON.stringify(expanded))).toBeGreaterThan(32 * 1024 * 1024);
  expect(await readPreparedTransferRows(f.store, plan, "asset", 0)).toEqual(expanded.slice(0, 96));
}, 20_000);
it("bounds each scan and scoring invocation and does not reread sources after context preparation", async () => {
  const f = fixture(2200);
  await f.tick(); expect(f.terrainReads).toHaveLength(8);
  await f.tick(); expect(f.terrainReads).toHaveLength(16);
  await f.tick(); expect(f.terrainReads).toHaveLength(18);
  await f.tick(); expect(f.contextCalls()).toBe(1);
  f.terrainReads.length = 0;
  await f.tick(); expect(f.terrainReads).toHaveLength(8);
  await f.finish(); expect(f.contextCalls()).toBe(1);
});
it("waits for resumable context prerequisites without rescanning terrain or resetting time", async () => {
  const f = fixture(270), create = f.input.createContext;
  await f.tick();
  const before = structuredClone(f.saved.get(PREPARATION_STATE));
  const reads = [...f.terrainReads];
  f.input.createContext = vi.fn().mockResolvedValue(null);
  for (let step = 0; step < 3; step++) expect(await f.tick()).toBeNull();
  expect(f.saved.get(PREPARATION_STATE)).toEqual(before);
  expect(f.terrainReads).toEqual(reads);
  expect([...f.saved.keys()]).toEqual([PREPARATION_STATE]);
  f.input.createContext = create;
  const plan = await f.finish();
  expect(await rows(f, plan, "asset")).toEqual(JSON.parse(JSON.stringify((await f.reference()).assets)));
  expect(f.contextCalls()).toBe(1);
  expect((f.saved.get(PREPARATION_STATE) as { time: string }).time).toBe((before as { time: string }).time);
});
it.each([true, false])("recovers a page write failure after-save=%s with original time and exact rows", async after => {
  const f = fixture();
  await f.tick(); await f.tick();
  const time = (f.saved.get(PREPARATION_STATE) as { time: string }).time;
  f.fail("pp:", after);
  await expect(f.tick()).rejects.toThrow(after ? "lost acknowledgment" : "storage unavailable");
  const plan = await f.finish();
  expect((f.saved.get(PREPARATION_STATE) as { time: string }).time).toBe(time);
  expect(await rows(f, plan, "asset")).toEqual(JSON.parse(JSON.stringify((await f.reference()).assets)));
});
it("recovers a lost atomic cursor response without rescoring acknowledged pages", async () => {
  const f = fixture(2200); await f.tick(); await f.tick(); await f.tick(); await f.tick();
  f.fail(PREPARATION_STATE); await expect(f.tick()).rejects.toThrow("lost acknowledgment");
  const count = f.terrainReads.length;
  await f.tick(); expect(f.terrainReads.slice(count)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  await f.finish(); expect(f.contextCalls()).toBe(1);
});
it("replays a lost sealed-plan response with the original revision and audit timestamp", async () => {
  const f = fixture();
  f.fail(PREPARATION_READY);
  await expect(f.finish()).rejects.toThrow("lost acknowledgment");
  const original = structuredClone(f.saved.get(PREPARATION_READY));
  expect(await f.finish()).toEqual(original);
});
it.each(["scope", "layout"])("rejects changed %s rather than mixing generations", async field => {
  const f = fixture(); await f.tick();
  f.input[field as "scope" | "layout"] = "changed";
  await expect(f.tick()).rejects.toThrow("preparation_checkpoint_invalid");
  expect(f.saved.has(PREPARATION_READY)).toBe(false);
});
it("rejects changed terrain bytes after the global unavailable flag has been captured", async () => {
  const f = fixture(); await f.tick(); await f.tick();
  f.assets[0].name = "changed";
  await expect(f.tick()).rejects.toThrow("preparation_checkpoint_invalid");
});
it("rejects corrupted content-addressed pages before publication", async () => {
  const f = fixture(); await f.tick(); await f.tick(); await f.tick();
  const state = f.saved.get(PREPARATION_STATE) as { runs: { hash: string }[] };
  f.saved.set(`pp:${state.runs[0].hash}`, []);
  await expect(f.tick()).rejects.toThrow("preparation_checkpoint_invalid");
});
it("rejects duplicate identities across pages before sealing a complete inventory", async () => {
  const f = fixture(); f.assets[129].id = f.assets[0].id;
  await expect(f.finish()).rejects.toThrow("preparation_checkpoint_invalid");
  expect(f.saved.has(PREPARATION_READY)).toBe(false);
});
it("handles a verified empty inventory without fabricating candidates", async () => {
  const f = fixture(0), plan = await f.finish();
  expect(preparedCounts(plan)).toEqual({ asset: 0, recommendation: 0, source: 12 });
});
it("preserves a saved legacy preparation encoding instead of silently changing an in-flight plan", async () => {
  const f = fixture(); await f.tick();
  const state = f.saved.get(PREPARATION_STATE) as { rowEncoding?: string };
  delete state.rowEncoding;
  const plan = await f.finish();
  expect(plan.rowEncoding).toBeUndefined();
  expect(plan.pages.asset.every(page => page.stagedBytes === undefined)).toBe(true);
  expect(await rows(f, plan, "asset")).toEqual(JSON.parse(JSON.stringify((await f.reference()).assets)));
});
it("preserves an in-flight pre-index job instead of retrofitting its header", async () => {
  const f = fixture(); await f.tick();
  const state = f.saved.get(PREPARATION_STATE) as { queueIndexVersion?: string; queueScoringVersion?: string };
  delete state.queueIndexVersion; delete state.queueScoringVersion;
  const plan = await f.finish();
  expect(parseInventoryManifest(plan.header.incident.selected_fire.inventoryManifest)?.queueIndex).toBeUndefined();
  const actual = await rows(f, plan, "recommendation"), expected = JSON.parse(JSON.stringify((await f.reference()).recommendations)) as { id: string }[];
  expect(actual).toHaveLength(expected.length);
  expect(new Map(actual.map(row => [row.id, row]))).toEqual(new Map(expected.map(row => [row.id, row])));
});
it("preserves pre-source-model preparation and complete original source rows", async () => {
  const f = fixture(); await f.tick();
  delete (f.saved.get(PREPARATION_STATE) as { sourceQueueVersion?: string }).sourceQueueVersion;
  const plan = await f.finish();
  expect(parseInventoryManifest(plan.header.incident.selected_fire.inventoryManifest)?.sourceQueueVersion).toBeUndefined();
  const expected = (await f.reference()).sourceSnapshots;
  for (const row of expected) delete (row.raw_payload as Record<string, unknown>).queueReadModel;
  expect(await rows(f, plan, "source")).toEqual(JSON.parse(JSON.stringify(expected)));
});
it("carries uploaded-geometry validation work across pages rather than resetting its budget", async () => {
  const f = fixture(259);
  for (const asset of f.assets) {
    asset.origin = "uploaded"; asset.localOrUploaded = true; asset.sourceKey = "local-upload";
    asset.geometry = { type: "Point", coordinates: asset.coordinates };
  }
  await f.finish();
  expect((f.saved.get(PREPARATION_STATE) as { budget: { vertices: number } }).budget.vertices).toBe(259);
});
it("rejects prepared row content drift and invalid replay positions", async () => {
  const f = fixture(), plan = await f.finish();
  await expect(readPreparedRows(f.store, plan, "asset", -1)).rejects.toThrow("preparation_checkpoint_invalid");
  await expect(readPreparedRows(f.store, plan, "asset", 0.5)).rejects.toThrow("preparation_checkpoint_invalid");
  f.saved.set(`pp:${plan.pages.asset[0].hash}`, []);
  await expect(readPreparedRows(f.store, plan, "asset", 0)).rejects.toThrow("preparation_checkpoint_invalid");
});
it("rejects invalid cursors, unsupported versions and over-capacity terrain pages", async () => {
  const f = fixture(); await f.tick();
  const original = structuredClone(f.saved.get(PREPARATION_STATE));
  for (const bad of [{ version: 2 }, { cursor: -1 }, { phase: "oops" }, { totalBytes: NaN }, { queueIndexVersion: "future" }, { queueScoringVersion: "older" }, { sourceQueueVersion: "old" }]) {
    f.saved.set(PREPARATION_STATE, { ...(original as object), ...bad });
    await expect(f.tick()).rejects.toThrow("preparation_checkpoint_invalid");
  }
  const large = fixture(1); large.assets[0].name = "x".repeat(4 * 1024 * 1024);
  await expect(large.tick()).rejects.toThrow("preparation_checkpoint_capacity");
});
