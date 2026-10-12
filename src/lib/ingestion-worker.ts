import "server-only";
import {sealNativeAcquisition} from "./sentinel/native-provenance";
import { createHash, randomUUID } from "node:crypto";
import { BundleWriteError, bundleWrite, type BundleWrite, type BundlePersistence } from "./bundle-write";
import { getSupabaseIncidentBundle, getSupabaseIncidentBundleByDatabaseId, getSupabaseRefreshHeader, readSupabaseRefreshPage, verifySupabaseRefreshHeader } from "./fireafter-supabase";
import { HYDRATION_HEADER, HYDRATION_STATE, HydrationCheckpointError, hydratePreviousIncident } from "./ingestion-hydration";
import type { PreviousRecommendation, PreviousSource, PreviousTerrain } from "./refresh-history";
import { parseInventoryManifest } from "./inventory-manifest";
import { createIncidentFromLocation } from "./fireafter-store";
import { prepareIngestionPayload } from "./ingestion-payload";
import { STAGED_HEADER_KEY, stageIngestionPayload, stagePreparedIngestion, verifyStagedCommitSecurity } from "./ingestion-staged";
import { PREPARATION_STATE, PreparationCheckpointError, prepareIngestionPages, preparedCounts, readPreparedTransferRows } from "./ingestion-preparation";
import { reuseTerrainSamples } from "./terrain-cache";
import { evidenceMaxAgeMinutes } from "./source-freshness";
import { ArcgisCheckpointError, ArcgisInventoryError, ArcgisInventoryPending } from "./arcgis-inventory";
import { CrossingCheckpointError, CrossingInferencePending, COUNTY_CROSSING_MAX_CANDIDATES } from "./crossing-checkpoint";
import { DERIVED_ASSET_STATE, DerivedAssetCheckpointError, readDerivedAssetManifest, readDerivedAssetPage, stageDerivedAssets, validateDerivedAssetIds } from "./ingestion-assets";
import { InventoryCapacityError } from "./inventory-error";
import { withRefreshOperation, RefreshOperationError } from "./refresh-operation";
import { CORE_SOURCES, EXTRA_SOURCES, INGESTION_SOURCES, TERRAIN_CHUNK_SIZE } from "./ingestion-contract";
import { ingestionRpc, putAtomicCheckpoint, putCheckpoint, readCheckpoint, readCommitReceipt, readIngestionJob, previousIngestionJobs, type IngestionJob } from "./ingestion-store";
import {
  applyLiveSignalsToIncident, enrichAssetsWithElevation, fetch3dhpFlowlinesSource,
  fetchEpqsSource, fetchFirmsSource, fetchMtbsBurnSeveritySource, fetchNbiBridgeSource,
  fetchNwsObservationsSource, fetchNwsSource, fetchPwfdfSource, fetchTigerRoadsSource,
  fetchTnmStructuresSource, fetchWfigsSource, fetchWfigsYearToDateSource,
  runLiveSourceRefresh, searchLocationsLive, sourceFailureResult, type AdapterMap, type LiveSourceResult, type LiveRecommendationContext,
} from "./live-sources";
import type { Asset, Incident } from "./types";

type SourceKey = keyof AdapterMap;
type Base = { incident: Incident; assets: Asset[]; previousRecommendations: PreviousRecommendation[];
    previousSourceSnapshots: PreviousSource[]; previousTerrain?: PreviousTerrain[]; inventorySources?: string[];
    write: BundleWrite; stagedPublication?: true; pagedPreparation?: true };
type Derived = Awaited<ReturnType<typeof runLiveSourceRefresh>>;
type Terrain = { assets: Asset[]; batchElevationUnavailable: boolean };

class InventoryRefreshUnavailableError extends Error {}

function requiresCompleteInventory(base: Base, key: SourceKey) {
  const sourceKey = key === "bridges" ? "fhwa-nbi-bridges" : key === "structures" ? "tnm-structures" : undefined;
  return base.write.operation === "refresh" && sourceKey !== undefined &&
    (base.inventorySources?.includes(sourceKey) || base.assets.some(asset => asset.sourceKey === sourceKey && !asset.localOrUploaded && asset.origin !== "uploaded"));
}

function isCompletePointInventory(result: LiveSourceResult) {
  // A verified empty response can remove retired assets; an outage cannot.
  return result.status === "online" && result.rawPayload.inventoryComplete === true &&
    Array.isArray(result.rawPayload.assets);
}

async function required<T>(id: string, key: string): Promise<T> {
  const value = await readCheckpoint<T>(id, key);
  if (!value) throw new Error("checkpoint_missing");
  return value;
}
async function advance(job: IngestionJob, stage: string, progress = job.progress, error: string | null = null) {
  await ingestionRpc("fireafter_advance_ingestion", { p_id: job.id, p_lease: job.lease_id, p_stage: stage, p_progress: progress, p_error: error });
}
function derivedAssetStore(job: IngestionJob) {
  return { read: (key: string) => readCheckpoint(job.id, key),
    write: (key: string, value: unknown) => key === DERIVED_ASSET_STATE
      ? putAtomicCheckpoint(job, key, value) : putCheckpoint(job, key, value) };
}
async function initialize(job: IngestionJob) {
  const saved = await readCheckpoint<Base>(job.id, "base");
  if (saved) {
    if (saved.incident?.id !== job.incident_key || saved.write?.actorId !== job.actor_id ||
      saved.write.organizationId !== job.organization_id) throw new BundleWriteError("FB400");
    await advance(job, "source:wfigs", { ...job.progress, published: saved.write.operation !== "create" });
    return;
  }
  const hydrating = await readCheckpoint(job.id, HYDRATION_HEADER);
  const stagedPublication = Boolean(hydrating) || process.env.FIREAFTER_STAGED_COMMIT_ENABLED === "true";
  if (stagedPublication && !hydrating) await verifyStagedCommitSecurity();
  let existing: { incident: Incident; assets: Asset[]; recommendations: PreviousRecommendation[];
    sourceSnapshots: PreviousSource[]; persistence: BundlePersistence; previousTerrain?: PreviousTerrain[]; inventorySources?: string[] } | null;
  if (stagedPublication) {
    const scope = createHash("sha256").update(JSON.stringify([job.id, job.actor_id, job.organization_id, job.incident_key, job.kind, job.seed.targetId ?? null])).digest("hex");
    const result = await hydratePreviousIncident({ read: key => readCheckpoint(job.id, key),
      write: (key, value) => key === HYDRATION_STATE ? putAtomicCheckpoint(job, key, value) : putCheckpoint(job, key, value) }, {
      scope, open: () => getSupabaseRefreshHeader(job.seed.targetId ?? job.incident_key, job.organization_id, Boolean(job.seed.targetId)),
      verify: verifySupabaseRefreshHeader, page: readSupabaseRefreshPage,
    });
    if (result.status === "pending") {
      await advance(job, "initialize", { ...job.progress, published: true,
        inventory: { source: `saved ${result.kind}`, saved: result.saved, total: result.total } });
      return;
    }
    existing = result.status === "ready" ? result.value : null;
  } else existing = job.seed.targetId ? await getSupabaseIncidentBundleByDatabaseId(job.seed.targetId)
    : await getSupabaseIncidentBundle(job.incident_key);
  if (existing && existing.persistence.organizationId !== job.organization_id) throw new BundleWriteError("FB401");
  if (!existing && job.kind === "refresh") throw new BundleWriteError("FB404");
  let incident = existing?.incident ?? job.seed.incident;
  if (!incident && job.seed.location) {
    const seed = job.seed.location;
    const candidates = await searchLocationsLive(seed.id);
    const location = candidates.find(candidate => candidate.id === seed.id);
    if (!location) throw new Error("county_resolution_unavailable");
    if (location.fips !== seed.fips || location.state !== seed.state) throw new BundleWriteError("FB400");
    incident = createIncidentFromLocation(location);
  }
  if (!incident || incident.id !== job.incident_key) throw new BundleWriteError("FB400");
  const principal = { kind: "user" as const, actorId: job.actor_id, organizationId: job.organization_id };
  const base: Base = { incident, assets: existing?.assets ?? [],
    ...(stagedPublication ? { stagedPublication: true, pagedPreparation: true } : {}),
    ...(existing?.previousTerrain ? { previousTerrain: existing.previousTerrain, inventorySources: existing.inventorySources } : {}),
    previousRecommendations: existing?.recommendations ?? [], previousSourceSnapshots: existing?.sourceSnapshots ?? [],
    write: bundleWrite(principal, existing?.persistence ?? { organizationId: job.organization_id, expectedRevision: null }, existing ? "refresh" : "create") };
  await putCheckpoint(job, "base", base);
  await advance(job, "source:wfigs", { ...job.progress, inventory: undefined, published: Boolean(existing) });
}
async function sourceContext(job: IngestionJob, base: Base) {
  const fire = await readCheckpoint<LiveSourceResult>(job.id, "source:wfigs");
  return fire && base.incident.locationContext
    ? applyLiveSignalsToIncident(base.incident, base.incident.locationContext, fire.derivedSignals, [fire], new Date())
    : base.incident;
}

export function reusableSource(result: LiveSourceResult, now: number) {
  const fetched = Date.parse(result.fetchedAt);
  const maxAgeMs = evidenceMaxAgeMinutes() * 60_000;
  const expires = Math.min(fetched + maxAgeMs, result.validUntil === undefined ? Infinity : Date.parse(result.validUntil));
  // Reserve processing/review time instead of publishing almost-expired cache entries.
  // This is not an extension of the original retrieval or provider validity window.
  const headroomMs = Math.min(10 * 60_000, maxAgeMs);
  return result.status === "online" && !result.stale && result.coverageStatus === "available" &&
    Number.isFinite(fetched) && fetched <= now && expires - now > headroomMs;
}
async function acquireSource(job: IngestionJob, key: SourceKey, base: Base): Promise<LiveSourceResult> {
  if (["roads", "hydro", "bridges", "structures", "mtbs"].includes(key)) {
    for (const prior of await previousIngestionJobs(job)) {
      const cached = await readCheckpoint<LiveSourceResult>(prior.id, `source:${key}`);
      if (cached && reusableSource(cached, Date.now()) &&
        (!requiresCompleteInventory(base, key) || isCompletePointInventory(cached))) return cached;
    }
  }
  const incident = await sourceContext(job, base);
  const location = incident.locationContext;
  if (!location) throw new Error("county_context_missing");
  const options = { now: new Date() };
  const adapters: AdapterMap = {
    wfigs: () => fetchWfigsSource(location, incident, options),
    nws: () => fetchNwsSource(location, options), observations: () => fetchNwsObservationsSource(location, options),
    pwfdf: () => fetchPwfdfSource(location, incident, options), bridges: () => fetchNbiBridgeSource(location, options),
    structures: () => fetchTnmStructuresSource(location, options), wfigsYtd: () => fetchWfigsYearToDateSource(location, incident, options),
    firms: () => fetchFirmsSource(location, { ...options, firmsMapKey: process.env.NASA_FIRMS_MAP_KEY, firmsSource: process.env.NASA_FIRMS_SOURCE }),
    mtbs: () => fetchMtbsBurnSeveritySource(location, options), roads: () => fetchTigerRoadsSource(location, options),
    hydro: () => fetch3dhpFlowlinesSource(location, { ...options, checkpoint: {
      read: key => readCheckpoint(job.id, key),
      write: (key, value) => key.endsWith(":state") ? putAtomicCheckpoint(job, key, value) : putCheckpoint(job, key, value),
    } }), epqs: () => fetchEpqsSource(location, options),
  };
  try { return sealNativeAcquisition(await adapters[key](incident),base.incident.id,"live"); }
  catch (error) {
    if (error instanceof ArcgisInventoryPending || error instanceof ArcgisCheckpointError) throw error;
    if (error instanceof RefreshOperationError) throw error;
    if (key === "hydro" && error instanceof ArcgisInventoryError && ["timeout", "provider_error"].includes(error.code)) {
      throw new InventoryRefreshUnavailableError();
    }
    console.warn("[fireafter] ingestion provider unavailable", { source: key, error: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ArcgisInventoryError ? { inventoryErrorCode: error.code } : {}) });
    return sourceFailureResult(key, options.now, error instanceof ArcgisInventoryError ? error : undefined);
  }
}
async function sourceStep(job: IngestionJob, key: SourceKey) {
  const base = await required<Base>(job.id, "base");
  const preserveInventory = requiresCompleteInventory(base, key);
  const saved = await readCheckpoint<LiveSourceResult>(job.id, `source:${key}`);
  // Do not commit a partial replacement over known source assets. Leave this
  // stage retryable and the old revision untouched, with its original dates.
  if (!saved || (preserveInventory && !isCompletePointInventory(saved))) {
    let result: LiveSourceResult;
    try { result = await acquireSource(job, key, base); }
    catch (error) {
      if (!(error instanceof ArcgisInventoryPending)) throw error;
      await advance(job, job.stage, { ...job.progress, inventory: { source: key, saved: error.saved, total: error.total } });
      return;
    }
    if (preserveInventory && !isCompletePointInventory(result)) throw new InventoryRefreshUnavailableError();
    await putCheckpoint(job, `source:${key}`, result);
  }
  const group: readonly SourceKey[] = (CORE_SOURCES as readonly string[]).includes(key) ? CORE_SOURCES : EXTRA_SOURCES;
  const index = group.indexOf(key);
  await advance(job, index + 1 < group.length ? `source:${group[index + 1]}` : `derive:${group === CORE_SOURCES ? "initial" : "final"}`,
    { ...job.progress, inventory: undefined });
}
async function assemble(job: IngestionJob, assets?: Terrain, now?: Date, onRecommendationContext?: (context: LiveRecommendationContext) => void): Promise<Derived> {
  const base = await required<Base>(job.id, "base");
  const adapters: Partial<AdapterMap> = {};
  for (const key of INGESTION_SOURCES) {
    const source = await readCheckpoint<LiveSourceResult>(job.id, `source:${key}`);
    const result = source ?? { ...sourceFailureResult(key, now ?? new Date()), detail: "Not processed yet; background ingestion is continuing.",
      warnings: ["This source has not been processed yet. Do not infer low risk from missing evidence."] };
    adapters[key] = async () => result;
  }
  return runLiveSourceRefresh({ incident: base.incident, assets: base.assets,
    previousRecommendations: base.previousRecommendations, previousSourceSnapshots: base.previousSourceSnapshots,
    adapters, now, onRecommendationContext, skipElevation: true, ...(assets ? { derivedAssets: assets } : {
      ...(base.stagedPublication ? { crossingMaxCandidates: COUNTY_CROSSING_MAX_CANDIDATES } : {}), crossingCheckpoint: {
      read: key => readCheckpoint(job.id, key),
      write: (key, value) => key.endsWith(":state") ? putAtomicCheckpoint(job, key, value) : putCheckpoint(job, key, value),
    } }) });
}
async function deriveStep(job: IngestionJob, phase: "initial" | "final") {
  const base = await required<Base>(job.id, "base");
  if (phase === "initial" && base.write.operation !== "create") {
    // A refresh must not replace a usable inventory with a partial first pass.
    // Keep the last committed revision visible until the complete replacement is ready.
    await advance(job, `source:${EXTRA_SOURCES[0]}`);
    return;
  }
  const store = derivedAssetStore(job);
  const saved = phase === "final" ? await readDerivedAssetManifest(store) : null;
  if (saved && saved.next === saved.pages.length) {
    await advanceToTerrain(job, saved.pages.length);
    return;
  }
  let derived: Derived;
  try { derived = await assemble(job); }
  catch (error) {
    if (!(error instanceof CrossingInferencePending)) throw error;
    await advance(job, job.stage, { ...job.progress, crossings: {
      roadsCompleted: error.roadsCompleted, candidatesSaved: error.candidatesSaved,
    } });
    return;
  }
  derived.assets = reuseTerrainSamples(derived.assets, base.previousTerrain ?? base.assets);
  if (phase === "initial") {
    await putCheckpoint(job, "derived:initial", derived);
    await advance(job, "prepare:initial", { ...job.progress, crossings: undefined });
  } else {
    // Source evidence already has separate checkpoints. Final recommendations
    // are recomputed after terrain; do not duplicate both in every terrain read.
    const manifest = await stageDerivedAssets(store, derived.assets);
    if (manifest.next !== manifest.pages.length) {
      await advance(job, job.stage, { ...job.progress, crossings: undefined });
      return;
    }
    await advanceToTerrain(job, manifest.pages.length);
  }
}
async function advanceToTerrain(job: IngestionJob, chunks: number) {
  await advance(job, chunks ? "terrain:0" : "prepare:final", { ...job.progress, crossings: undefined, terrainTotal: chunks, terrainCompleted: 0 });
}
async function derivedAssetLayout(job: IngestionJob) {
  const store = derivedAssetStore(job);
  const manifest = await readDerivedAssetManifest(store);
  if (manifest) {
    if (manifest.next !== manifest.pages.length) throw new DerivedAssetCheckpointError("invalid");
    return { total: manifest.pages.length, page: (index: number) => readDerivedAssetPage(store, manifest, index),
      check: (index: number, assets: Asset[]) => validateDerivedAssetIds(manifest, index, assets) };
  }
  // Existing durable jobs may already be at terrain/prepare with the old format.
  const legacy = await required<Derived>(job.id, "derived:final");
  return { total: Math.ceil(legacy.assets.length / TERRAIN_CHUNK_SIZE),
    page: async (index: number) => legacy.assets.slice(index * TERRAIN_CHUNK_SIZE, (index + 1) * TERRAIN_CHUNK_SIZE),
    check: (index: number, assets: Asset[]) => {
      const original = legacy.assets.slice(index * TERRAIN_CHUNK_SIZE, (index + 1) * TERRAIN_CHUNK_SIZE);
      if (!Array.isArray(assets) || assets.length !== original.length || assets.some((asset, position) => asset.id !== original[position].id)) {
        throw new DerivedAssetCheckpointError("invalid");
      }
    } };
}
async function terrainStep(job: IngestionJob, index: number) {
  const layout = await derivedAssetLayout(job);
  const total = layout.total;
  if (!Number.isSafeInteger(index) || index < 0 || index >= total) throw new Error("terrain_index_invalid");
  const key = `terrain:${index}`;
  const saved = await readCheckpoint<Terrain>(job.id, key);
  if (!saved) {
    const assets = await layout.page(index);
    const enriched = await enrichAssetsWithElevation(assets, fetch, { retryTransient: true });
    layout.check(index, enriched.assets);
    await putCheckpoint(job, key, enriched);
  } else layout.check(index, saved.assets);
  await advance(job, index + 1 < total ? `terrain:${index + 1}` : "prepare:final",
    { ...job.progress, terrainTotal: total, terrainCompleted: index + 1 });
}
async function prepareStep(job: IngestionJob, phase: "initial" | "final") {
  const base = await required<Base>(job.id, "base");
  if (phase === "final" && base.pagedPreparation) {
    await preparePagedStep(job, base);
    return;
  }
  let derived: Derived;
  let write = base.write;
  const staged = phase === "final" && (base.stagedPublication || process.env.FIREAFTER_STAGED_COMMIT_ENABLED === "true" || Boolean(await readCheckpoint(job.id, "commit:staged:time")));
  let preparedAt: Date | undefined;
  if (staged) {
    let time = await readCheckpoint<string>(job.id, "commit:staged:time");
    if (!time) { time = new Date().toISOString(); await putAtomicCheckpoint(job, "commit:staged:time", time); }
    preparedAt = new Date(time);
    if (!Number.isFinite(preparedAt.getTime())) throw new BundleWriteError("FB400");
  }
  if (phase === "final") {
    if (base.write.operation === "create") {
      const target = await readCommitReceipt(job.id, "initial");
      if (!target) throw new Error("initial_receipt_missing");
      const published = await getSupabaseIncidentBundleByDatabaseId(target.incident_id);
      if (!published || published.persistence.organizationId !== job.organization_id) throw new BundleWriteError("FB401");
      // Never rebase over an intervening fire-context/import/refresh change.
      if (published.persistence.expectedRevision !== target.revision) throw new BundleWriteError("FB409");
      write = bundleWrite({ kind: "user", actorId: job.actor_id, organizationId: job.organization_id }, published.persistence, "refresh");
    }
    const layout = await derivedAssetLayout(job);
    const terrain: Terrain = { assets: [], batchElevationUnavailable: false };
    for (let index = 0; index < layout.total; index++) {
      const part = await required<Terrain>(job.id, `terrain:${index}`);
      layout.check(index, part.assets);
      terrain.assets.push(...part.assets);
      terrain.batchElevationUnavailable ||= part.batchElevationUnavailable;
    }
    derived = await assemble(job, terrain, preparedAt);
  } else derived = await required<Derived>(job.id, "derived:initial");
  const payload = prepareIngestionPayload(job.id, phase, derived, write, preparedAt);
  if (staged) {
    const complete = await stageIngestionPayload(job, payload);
    if (!complete) { await advance(job, job.stage); return; }
  } else await putCheckpoint(job, `commit:${phase}`, payload, false);
  await advance(job, `commit:${phase}`);
}
async function hydrateInitialPublication(job: IngestionJob) {
  const receipt = await readCommitReceipt(job.id, "initial");
  if (!receipt) throw new Error("initial_receipt_missing");
  const scope = createHash("sha256").update(JSON.stringify(["initial-publication", job.id, job.incident_key,
    job.actor_id, job.organization_id, receipt.incident_id, receipt.revision])).digest("hex");
  // Initialization and first-publication reads must never share a cursor/header.
  return hydratePreviousIncident({ read: key => readCheckpoint(job.id, `enrich:${key}`),
    write: (key, value) => key === HYDRATION_STATE ? putAtomicCheckpoint(job, `enrich:${key}`, value) : putCheckpoint(job, `enrich:${key}`, value) }, {
    scope, open: () => getSupabaseRefreshHeader(receipt.incident_id, job.organization_id, true),
    verify: async header => {
      if (header.row.organization_id !== job.organization_id) throw new BundleWriteError("FB401");
      if (header.row.id !== receipt.incident_id || parseInventoryManifest(header.row.selected_fire?.inventoryManifest)?.revision !== receipt.revision) {
        throw new BundleWriteError("FB409");
      }
      await verifySupabaseRefreshHeader(header);
    },
    page: readSupabaseRefreshPage,
  });
}
async function preparePagedStep(job: IngestionJob, base: Base) {
  const manifest = await readDerivedAssetManifest(derivedAssetStore(job));
  if (!manifest || manifest.next !== manifest.pages.length) throw new PreparationCheckpointError("invalid");
  const scope = createHash("sha256").update(JSON.stringify([job.id, job.incident_key, job.actor_id, job.organization_id, base.write])).digest("hex");
  const store = { read: (key: string) => readCheckpoint(job.id, key), write: (key: string, value: unknown) =>
    key === PREPARATION_STATE ? putAtomicCheckpoint(job, key, value) : putCheckpoint(job, key, value) };
  let progress = { ...job.progress, inventory: undefined as IngestionJob["progress"]["inventory"] };
  const plan = await prepareIngestionPages(store, { jobId: job.id, scope, layout: manifest.fingerprint, totalPages: manifest.pages.length,
    readTerrain: async index => {
      const page = await required<Terrain>(job.id, `terrain:${index}`);
      validateDerivedAssetIds(manifest, index, page.assets);
      return page;
    },
    createContext: async (batchElevationUnavailable, now) => {
      let write = base.write;
      if (write.operation === "create") {
        const published = await hydrateInitialPublication(job);
        if (published.status === "pending") {
          progress = { ...progress, inventory: { source: `published ${published.kind}`, saved: published.saved, total: published.total } };
          return null;
        }
        if (published.status === "missing") throw new BundleWriteError("FB404");
        write = bundleWrite({ kind: "user", actorId: job.actor_id, organizationId: job.organization_id }, published.value.persistence, "refresh");
      }
      let context: LiveRecommendationContext | undefined;
      const derived = await assemble(job, { assets: [], batchElevationUnavailable }, now, value => { context = value; });
      if (!context) throw new PreparationCheckpointError("invalid");
      return { context, derived, write };
    } });
  if (!plan) { await advance(job, job.stage, progress); return; }
  const complete = await stagePreparedIngestion(job, plan.header, preparedCounts(plan), (kind, position) => readPreparedTransferRows(store, plan, kind, position), plan.rowEncoding);
  await advance(job, complete ? "commit:final" : job.stage, progress);
}
async function commitStep(job: IngestionJob, phase: "initial" | "final") {
  // SQL receipt lookup and bundle commit are atomic. Replaying an acknowledged or
  // unacknowledged commit uses the SAME job/phase; it cannot duplicate the audit.
  if (phase === "final" && await readCheckpoint(job.id, STAGED_HEADER_KEY)) {
    await verifyStagedCommitSecurity();
    await ingestionRpc<string>("fireafter_commit_staged_ingestion", { p_id: job.id, p_lease: job.lease_id });
  } else await ingestionRpc<string>("fireafter_commit_ingestion", { p_id: job.id, p_lease: job.lease_id, p_phase: phase });
  if (phase === "initial") {
    await advance(job, `source:${EXTRA_SOURCES[0]}`, { ...job.progress, published: true });
  } else await advance(job, "done", { ...job.progress, published: true });
}

export async function runIngestionStep(id: string): Promise<"continue" | "wait" | "stop"> {
  const job = await ingestionRpc<IngestionJob | null>("fireafter_claim_ingestion", { p_id: id, p_lease: randomUUID() });
  if (!job) {
    const current = await readIngestionJob(id);
    return !current || ["failed", "completed"].includes(current.status) ? "stop" : "wait";
  }
  try {
    await withRefreshOperation("refresh", async () => {
      if (job.stage === "initialize") return initialize(job);
      if (job.stage.startsWith("source:") && INGESTION_SOURCES.includes(job.stage.slice(7) as SourceKey)) return sourceStep(job, job.stage.slice(7) as SourceKey);
      if (job.stage === "derive:initial" || job.stage === "derive:final") return deriveStep(job, job.stage.slice(7) as "initial" | "final");
      if (job.stage.startsWith("terrain:")) return terrainStep(job, Number(job.stage.slice(8)));
      if (job.stage === "prepare:initial" || job.stage === "prepare:final") return prepareStep(job, job.stage.slice(8) as "initial" | "final");
      if (job.stage === "commit:initial" || job.stage === "commit:final") return commitStep(job, job.stage.slice(7) as "initial" | "final");
      throw new Error("stage_invalid");
    });
    return "continue";
  } catch (error) {
    const code = error instanceof BundleWriteError || error instanceof RefreshOperationError || error instanceof InventoryCapacityError ? error.code
      : error instanceof CrossingCheckpointError ? `crossing_checkpoint_${error.reason}`
      : error instanceof DerivedAssetCheckpointError || error instanceof PreparationCheckpointError || error instanceof HydrationCheckpointError ? error.message
      : error instanceof InventoryRefreshUnavailableError ? "inventory_refresh_unavailable" : "ingestion_step_failed";
    console.warn("[fireafter] ingestion step interrupted", { jobId: id, stage: job.stage, code });
    if ((error instanceof InventoryCapacityError && error.code === "inference_candidates") ||
      error instanceof DerivedAssetCheckpointError || error instanceof PreparationCheckpointError || error instanceof HydrationCheckpointError ||
      (error instanceof CrossingCheckpointError && error.reason !== "unavailable")) {
      // The same immutable source set cannot fit by retrying. Keep the saved
      // incident intact and report capacity, not repeated transient failures.
      await advance(job, job.stage, job.progress, code);
      return "stop";
    }
    if (error instanceof BundleWriteError && ["FB400", "FB401", "FB404", "FB408", "FB409"].includes(error.code)) {
      // A lease loss must not mark another worker's job failed; fenced SQL rejects it.
      await advance(job, job.stage, job.progress, code);
      return "stop";
    }
    // Leave the lease in place. The next durable invocation reconciles checkpoints
    // after expiry, with bounded attempts; never reuses an ambiguous write blindly.
    try { await ingestionRpc("fireafter_note_ingestion_error", { p_id: job.id, p_lease: job.lease_id, p_code: code }); }
    catch { /* Failure to record diagnostics does not authorize an unfenced retry. */ }
    return "wait";
  }
}
