import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createLiveRecommendationScorer, type LiveRecommendationContext } from "./live-sources";
import { compareRecommendations } from "./recommendation-order";
import { createQueueReadIndex, QUEUE_READ_INDEX_VERSION } from "./queue-read-index";
import { SCORING_VERSION } from "./scoring";
import { QUEUE_SOURCE_VERSION } from "./queue-source-read-model";
import { MAP_VIEW_VERSION } from "./map-viewport-contract";
import { SOURCE_SPATIAL_ENCODING } from "./source-spatial-storage";
import { SOURCE_VIEW_VERSION } from "./source-viewport-contract";
import { prepareIngestionPayload } from "./ingestion-payload";
import { parseInventoryManifest } from "./inventory-manifest";
import { jsonbTextBytes } from "./ingestion-jsonb-size";
import { encodeStagedRows, SHARED_ROW_ENCODING, type RowEncoding } from "./ingestion-row-page";
import type { BundleWrite } from "./bundle-write";
import type { Asset, Incident, Recommendation } from "./types";
import type { DerivedAssetStore } from "./ingestion-assets";
import type { StagedHeader } from "./ingestion-staged";

export const PREPARATION_STATE = "prepare:pages:state";
export const PREPARATION_READY = "prepare:pages:ready";
const MAX_ROWS = 100_000;
const MAX_PAGE_BYTES = 24 * 1024 * 1024;
const MAX_COMPACT_BYTES = 48 * 1024 * 1024;
const STEP_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const hashValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
type Payload = ReturnType<typeof prepareIngestionPayload>;
export type PreparedKind = "source" | "asset" | "recommendation";
type Descriptor = { hash: string; bytes: number; jsonbBytes: number; count: number; stagedBytes?: number };
type Terrain = { assets: Asset[]; batchElevationUnavailable: boolean };
type Rank = Pick<Recommendation, "id" | "assetId" | "assetName" | "riskLevel" | "score100"> & {
  assetRowId: string; recommendationRowId: string; position: number;
};
type Context = {
  context: LiveRecommendationContext; incident: Incident; write: BundleWrite;
  template: Pick<Payload, "organization" | "incident" | "auditEvents" | "write">;
};
type Phase = "scan" | "context" | "score" | "rank" | "finalize" | "seal" | "ready";
type State = {
  version: 1; scope: string; layout: string; time: string; phase: Phase; cursor: number; rowEncoding?: RowEncoding; transferRows?: 256;
  queueIndexVersion?: typeof QUEUE_READ_INDEX_VERSION;
  queueScoringVersion?: string;
  sourceQueueVersion?: typeof QUEUE_SOURCE_VERSION;
  assetMapVersion?: typeof MAP_VIEW_VERSION;
  sourceSpatialEncoding?: typeof SOURCE_SPATIAL_ENCODING;
  sourceMapVersion?: typeof SOURCE_VIEW_VERSION;
  publicationRevision?: string;
  rankLookupVersion?: 1; rankLookup?: Descriptor;
  terrain: Descriptor[]; unavailable: boolean; context?: Descriptor;
  sources: Descriptor[]; runs: Descriptor[]; nextRuns: Descriptor[]; root?: Descriptor;
  assets: Descriptor[]; recommendations: Descriptor[]; totalBytes: number;
  budget: { vertices: number; comparisons: number };
};
export type PreparedPlan = { version: 1; scope: string; layout: string; header: StagedHeader; rowEncoding?: RowEncoding; transferRows?: 256;
  pages: Record<PreparedKind, Descriptor[]> };
export type PreparationInput = {
  jobId: string; scope: string; layout: string; totalPages: number;
  readTerrain(index: number): Promise<Terrain>;
  createContext(unavailable: boolean, now: Date): Promise<{
    context: LiveRecommendationContext; derived: Parameters<typeof prepareIngestionPayload>[2]; write: BundleWrite;
  } | null>;
};
export class PreparationCheckpointError extends Error {
  constructor(readonly reason: "invalid" | "capacity") { super(`preparation_checkpoint_${reason}`); }
}
function invalid(): never { throw new PreparationCheckpointError("invalid"); }
function capacity(): never { throw new PreparationCheckpointError("capacity"); }
function descriptor(value: unknown, count: number, max = MAX_PAGE_BYTES): Descriptor {
  const text = JSON.stringify(value), size = Buffer.byteLength(text);
  if (size > max) capacity();
  return { hash: hash(value), bytes: size, jsonbBytes: jsonbTextBytes(text), count };
}
function checkDescriptor(value: Descriptor) {
  if (!value || !hashValid(value.hash) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_COMPACT_BYTES ||
    !Number.isSafeInteger(value.jsonbBytes) || value.jsonbBytes < value.bytes ||
    !Number.isSafeInteger(value.count) || value.count < 0 || value.count > MAX_ROWS) invalid();
  if (value.stagedBytes !== undefined && (!Number.isSafeInteger(value.stagedBytes) || value.stagedBytes < 1 || value.stagedBytes > value.jsonbBytes)) invalid();
}
async function put(store: DerivedAssetStore, value: unknown, count: number, max = MAX_PAGE_BYTES) {
  const desc = descriptor(value, count, max), key = `pp:${desc.hash}`;
  const prior = await store.read(key);
  if (prior !== null) { if (hash(prior) !== desc.hash || bytes(prior) !== desc.bytes) invalid(); }
  else await store.write(key, value);
  return desc;
}
async function read<T>(store: Pick<DerivedAssetStore, "read">, desc: Descriptor): Promise<T> {
  checkDescriptor(desc);
  const value = await store.read(`pp:${desc.hash}`);
  if (value === null || hash(value) !== desc.hash || bytes(value) !== desc.bytes || jsonbTextBytes(JSON.stringify(value)) !== desc.jsonbBytes) invalid();
  return value as T;
}
function stagedSize(page: Descriptor, encoding?: RowEncoding) {
  if (!encoding) return page.jsonbBytes;
  if (encoding !== SHARED_ROW_ENCODING || page.stagedBytes === undefined) invalid();
  return page.stagedBytes;
}
async function putRows(store: DerivedAssetStore, rows: unknown[], encoding?: RowEncoding) {
  const desc = await put(store, rows, rows.length);
  return encoding ? { ...desc, stagedBytes: jsonbTextBytes(JSON.stringify(encodeStagedRows(rows, encoding))) } : desc;
}
function checkState(state: State, input: PreparationInput) {
  if (!state || state.version !== 1 || state.scope !== input.scope || state.layout !== input.layout ||
    (state.rowEncoding !== undefined && state.rowEncoding !== SHARED_ROW_ENCODING) ||
    (state.transferRows !== undefined && state.transferRows !== 256) ||
    (state.queueIndexVersion !== undefined && state.queueIndexVersion !== QUEUE_READ_INDEX_VERSION) ||
    (state.queueIndexVersion ? state.queueScoringVersion !== SCORING_VERSION : state.queueScoringVersion !== undefined) ||
    (state.sourceQueueVersion !== undefined && state.sourceQueueVersion !== QUEUE_SOURCE_VERSION) ||
    (state.assetMapVersion !== undefined && state.assetMapVersion !== MAP_VIEW_VERSION) ||
    (state.sourceSpatialEncoding !== undefined && state.sourceSpatialEncoding !== SOURCE_SPATIAL_ENCODING) ||
    (state.sourceMapVersion !== undefined && state.sourceMapVersion !== SOURCE_VIEW_VERSION) ||
    (state.sourceMapVersion && (typeof state.publicationRevision !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.publicationRevision))) ||
    (!state.sourceMapVersion && state.publicationRevision !== undefined) ||
    (state.rankLookupVersion !== undefined && state.rankLookupVersion !== 1) ||
    !Number.isFinite(Date.parse(state.time)) || !["scan", "context", "score", "rank", "finalize", "seal", "ready"].includes(state.phase) ||
    !Number.isSafeInteger(state.cursor) || state.cursor < 0 || state.cursor > input.totalPages || typeof state.unavailable !== "boolean" ||
    !Number.isSafeInteger(state.totalBytes) || state.totalBytes < 0 || state.totalBytes > MAX_TOTAL_BYTES ||
    !state.budget || !Number.isSafeInteger(state.budget.vertices) || state.budget.vertices < 0 ||
    !Number.isSafeInteger(state.budget.comparisons) || state.budget.comparisons < 0) invalid();
  for (const key of ["terrain", "sources", "runs", "nextRuns", "assets", "recommendations"] as const) {
    if (!Array.isArray(state[key]) || state[key].length > Math.max(input.totalPages, 128)) invalid();
    state[key].forEach(checkDescriptor);
  }
  if (state.terrain.length > input.totalPages || state.terrain.reduce((sum, page) => sum + page.count, 0) > MAX_ROWS ||
    state.terrain.some(page => page.count > 128 || page.bytes > 4 * 1024 * 1024)) invalid();
  if (state.phase === "scan" ? state.cursor !== state.terrain.length : state.terrain.length !== input.totalPages) invalid();
  if (state.context) checkDescriptor(state.context);
  if (state.root) checkDescriptor(state.root);
  if (state.rankLookup) { checkDescriptor(state.rankLookup); if (!state.rankLookupVersion || state.rankLookup.count !== rankCount(state)) invalid(); }
  if (!["scan", "context"].includes(state.phase) && !state.context) invalid();
  if (["finalize", "seal", "ready"].includes(state.phase) && !state.root) invalid();
  if (["finalize", "seal", "ready"].includes(state.phase) && state.rankLookupVersion && !state.rankLookup) invalid();
  if (state.assets.length !== state.recommendations.length ||
    (state.phase === "finalize" && state.cursor !== state.assets.length) ||
    (["seal", "ready"].includes(state.phase) && state.assets.length !== input.totalPages)) invalid();
  if (state.assets.some((page, index) => page.count !== state.terrain[index]?.count || state.recommendations[index].count !== page.count) ||
    state.totalBytes !== [...state.sources, ...state.assets, ...state.recommendations].reduce((sum, page) => sum + (state.rowEncoding ? stagedSize(page, state.rowEncoding) : page.bytes), 0)) invalid();
  if (state.phase === "score" && (state.runs.length !== state.cursor || state.runs.some((page, index) => page.count !== state.terrain[index]?.count))) invalid();
  if (state.phase === "rank" && (state.cursor > state.runs.length ||
    state.runs.reduce((sum, page) => sum + page.count, 0) !== rankCount(state) ||
    state.nextRuns.reduce((sum, page) => sum + page.count, 0) !== state.runs.slice(0, state.cursor).reduce((sum, page) => sum + page.count, 0))) invalid();
}
async function terrainPage(input: PreparationInput, state: State, index: number) {
  const page = await input.readTerrain(index);
  if (!page || !Array.isArray(page.assets) || page.assets.length > 128 || typeof page.batchElevationUnavailable !== "boolean") invalid();
  const desc = descriptor(page, page.assets.length, 4 * 1024 * 1024);
  if (state.terrain[index] && JSON.stringify(desc) !== JSON.stringify(state.terrain[index])) invalid();
  return { page, desc };
}
function rankCount(state: State) { return state.terrain.reduce((sum, page) => sum + page.count, 0); }
function pageWrite(write: BundleWrite, rows: Recommendation[]): BundleWrite {
  if (!write.rowIds) return write;
  const pick = (kind: "asset" | "recommendation", ids: string[]) => Object.fromEntries(ids
    .filter(id => Object.hasOwn(write.rowIds![kind], id)).map(id => [id, write.rowIds![kind][id]]));
  return { ...write, rowIds: { asset: pick("asset", rows.map(row => row.assetId)),
    recommendation: pick("recommendation", rows.map(row => row.id)), source: {} } };
}
function verifyRanks(ranks: Rank[], count: number) {
  if (!Array.isArray(ranks) || ranks.length !== count || ranks.length > MAX_ROWS) invalid();
  const ids = new Set<string>(), positions = new Set<number>(), assetIds = new Set<string>();
  for (const [index, row] of ranks.entries()) {
    if (!row || typeof row.id !== "string" || !row.id || typeof row.assetId !== "string" || !row.assetId ||
      typeof row.assetName !== "string" || !Number.isFinite(row.score100) || !Number.isSafeInteger(row.position) || row.position < 0 ||
      row.position >= count || ids.has(row.id) || assetIds.has(row.assetId) || positions.has(row.position) ||
      (index && compareRecommendations(ranks[index - 1], row) > 0)) invalid();
    ids.add(row.id); assetIds.add(row.assetId); positions.add(row.position);
  }
}
function verifyRankLookup(ranks: number[], count: number) {
  if (!Array.isArray(ranks) || ranks.length !== count) invalid();
  const seen = new Uint8Array(count);
  for (const rank of ranks) {
    if (!Number.isSafeInteger(rank) || rank < 1 || rank > count || seen[rank - 1]) invalid();
    seen[rank - 1] = 1;
  }
}

/** Each invocation advances a bounded page group; only compact rank keys are globally assembled. */
export async function prepareIngestionPages(store: DerivedAssetStore, input: PreparationInput): Promise<PreparedPlan | null> {
  if (!Number.isSafeInteger(input.totalPages) || input.totalPages < 0 || input.totalPages > Math.ceil(MAX_ROWS / 128)) invalid();
  const raw = await store.read(PREPARATION_STATE);
  let state: State;
  if (raw === null) {
    state = { version: 1, scope: input.scope, layout: input.layout, time: new Date().toISOString(), phase: "scan", cursor: 0, rowEncoding: SHARED_ROW_ENCODING, transferRows: 256, rankLookupVersion: 1, queueIndexVersion: QUEUE_READ_INDEX_VERSION, queueScoringVersion: SCORING_VERSION, sourceQueueVersion: QUEUE_SOURCE_VERSION,
      ...(process.env.FIREAFTER_VIEWPORT_MAP_ENABLED === "true" ? { assetMapVersion: MAP_VIEW_VERSION, sourceSpatialEncoding: SOURCE_SPATIAL_ENCODING, sourceMapVersion: SOURCE_VIEW_VERSION, publicationRevision: randomUUID() } : {}),
      terrain: [], unavailable: false, sources: [], runs: [], nextRuns: [], assets: [], recommendations: [], totalBytes: 0,
      budget: { vertices: 0, comparisons: 0 } };
    await store.write(PREPARATION_STATE, state);
  } else state = structuredClone(raw as State);
  checkState(state, input);
  const save = () => store.write(PREPARATION_STATE, state);
  if (state.phase === "ready") return readPreparedPlan(store, input.scope, input.layout);
  if (state.phase === "scan") {
    let processedBytes = 0;
    for (let step = 0; step < 8 && state.cursor < input.totalPages && processedBytes < STEP_BYTES; step++) {
      const { page, desc } = await terrainPage(input, state, state.cursor);
      state.terrain.push(desc); state.unavailable ||= page.batchElevationUnavailable; state.cursor++;
      if (rankCount(state) > MAX_ROWS) capacity();
      processedBytes += desc.bytes;
    }
    if (state.cursor === input.totalPages) { state.phase = "context"; state.cursor = 0; }
    await save(); return null;
  }
  if (state.phase === "context") {
    const value = await input.createContext(state.unavailable, new Date(state.time));
    // A resumable prerequisite keeps the original preparation time and scan.
    if (value === null) return null;
    if (value.context.createdAt !== state.time || value.context.incidentId !== value.derived.incident.id ||
      value.derived.assets.length || value.derived.recommendations.length) invalid();
    const payload = prepareIngestionPayload(input.jobId, "final", value.derived, value.write, new Date(state.time), undefined,
      { assetMapEnabled: Boolean(state.assetMapVersion), sourceSpatialEnabled: Boolean(state.sourceSpatialEncoding), sourceMapEnabled: Boolean(state.sourceMapVersion), revision: state.publicationRevision });
    if (!state.sourceQueueVersion) {
      const inventory = parseInventoryManifest(payload.incident.selected_fire.inventoryManifest);
      if (!inventory) invalid();
      delete inventory.sourceQueueVersion;
      for (const row of payload.sourceSnapshots) delete (row.raw_payload as Record<string, unknown>).queueReadModel;
    }
    if (!state.queueIndexVersion) {
      const inventory = parseInventoryManifest(payload.incident.selected_fire.inventoryManifest);
      if (!inventory) invalid();
      delete inventory.queueIndex;
    }
    state.sources = [];
    for (const row of payload.sourceSnapshots) state.sources.push(await putRows(store, [row], state.rowEncoding));
    const { organization, incident, auditEvents } = payload;
    const { actorId, organizationId, expectedRevision, databaseIncidentId, operation } = payload.write;
    const compact: Context = { context: value.context, incident: value.derived.incident, write: value.write,
      template: { organization, incident, auditEvents, write: { actorId, organizationId, expectedRevision, databaseIncidentId, operation } } };
    state.context = await put(store, compact, 1, MAX_COMPACT_BYTES);
    state.totalBytes = state.sources.reduce((sum, page) => sum + (state.rowEncoding ? stagedSize(page, state.rowEncoding) : page.bytes), 0);
    if (state.totalBytes > MAX_TOTAL_BYTES) capacity();
    state.phase = "score"; await save(); return null;
  }
  if (state.phase === "rank") {
    // Multi-round fan-in avoids hundreds of reads or a growing large run per invocation.
    const group = state.runs.slice(state.cursor, state.cursor + 16);
    const rows: Rank[] = [];
    if (group.reduce((sum, page) => sum + page.count, 0) > MAX_ROWS) capacity();
    for (const desc of group) {
      const part = await read<Rank[]>(store, desc);
      if (!Array.isArray(part) || part.length !== desc.count) invalid();
      for (const row of part) rows.push(row);
    }
    rows.sort(compareRecommendations);
    state.nextRuns.push(await put(store, rows, rows.length, MAX_COMPACT_BYTES));
    state.cursor += group.length;
    if (state.cursor === state.runs.length) {
      state.runs = state.nextRuns; state.nextRuns = []; state.cursor = 0;
      if (state.runs.length === 1) {
        const ranks = await read<Rank[]>(store, state.runs[0]); verifyRanks(ranks, rankCount(state));
        if (state.rankLookupVersion) {
          const lookup = new Array<number>(ranks.length);
          ranks.forEach((row, index) => { lookup[row.position] = index + 1; });
          state.rankLookup = await put(store, lookup, lookup.length);
        }
        state.root = state.runs[0]; state.phase = "finalize";
      }
    }
    await save(); return null;
  }
  const context = await read<Context>(store, state.context!);
  const publication = parseInventoryManifest(context.template.incident.selected_fire.inventoryManifest);
  if (!publication) invalid();
  if (state.phase === "seal") {
    // Check SQL's actual accounting basis before any row-staging RPC is allowed.
    if ([...state.sources, ...state.assets, ...state.recommendations].reduce((sum, page) => sum + stagedSize(page, state.rowEncoding), 0) > MAX_TOTAL_BYTES) capacity();
    const ranks = await read<Rank[]>(store, state.root!); verifyRanks(ranks, rankCount(state));
    if (state.rankLookupVersion) {
      const lookup = await read<number[]>(store, state.rankLookup!); verifyRankLookup(lookup, ranks.length);
      if (ranks.some((row, index) => lookup[row.position] !== index + 1)) invalid();
    }
    const inventory = parseInventoryManifest(context.template.incident.selected_fire.inventoryManifest);
    if (!inventory) invalid();
    const assetIds = [...ranks].sort((a, b) => a.position - b.position).map(row => row.assetRowId);
    const complete = parseInventoryManifest({ ...inventory, assetIds, recommendationIds: ranks.map(row => row.recommendationRowId),
      ...(state.queueIndexVersion ? { queueIndex: createQueueReadIndex(ranks) } : {}) });
    const pages = { source: state.sources, asset: state.assets, recommendation: state.recommendations };
    const { actorId, organizationId, expectedRevision, databaseIncidentId, operation } = context.write;
    const header: StagedHeader = { ...context.template, version: "staged-ingestion-v1", rowsDigest: hash(state.transferRows ? { pages, transferRows: state.transferRows } : pages),
      incident: { ...context.template.incident, selected_fire: { ...context.template.incident.selected_fire, inventoryManifest: complete } },
      write: { actorId, organizationId, expectedRevision, databaseIncidentId, operation } };
    if (jsonbTextBytes(JSON.stringify(header)) > 16 * 1024 * 1024) capacity();
    await store.write(PREPARATION_READY, { version: 1, scope: input.scope, layout: input.layout, header, pages,
      ...(state.transferRows ? { transferRows: state.transferRows } : {}),
      ...(state.rowEncoding ? { rowEncoding: state.rowEncoding } : {}) } satisfies PreparedPlan);
    state.phase = "ready"; await save(); return readPreparedPlan(store, input.scope, input.layout);
  }
  const scorer = createLiveRecommendationScorer(context.context);
  const ranks = state.phase === "finalize" && !state.rankLookupVersion ? await read<Rank[]>(store, state.root!) : null;
  if (ranks) verifyRanks(ranks, rankCount(state));
  const rankById = new Map(ranks?.map((row, index) => [row.id, index + 1]));
  // Terrain positions are already hash-pinned; a compact permutation preserves
  // global ranks without rereading all county names and IDs for each page.
  const rankLookup = state.phase === "finalize" && state.rankLookupVersion ? await read<number[]>(store, state.rankLookup!) : null;
  if (rankLookup) verifyRankLookup(rankLookup, rankCount(state));
  let processedBytes = 0;
  for (let step = 0; step < 8 && state.cursor < input.totalPages && processedBytes < STEP_BYTES; step++) {
    const index = state.cursor, { page, desc } = await terrainPage(input, state, index);
    const offset = state.terrain.slice(0, index).reduce((sum, part) => sum + part.count, 0);
    const scored = scorer.scorePage(page.assets);
    const pageRanks = rankLookup ? new Map(scored.map((row, position) => [row.id, rankLookup[offset + position]])) : rankById;
    const recommendations = state.phase === "finalize" ? scorer.finalizePage(scored, id => pageRanks.get(id)) : scored;
    const payload = prepareIngestionPayload(input.jobId, "final", { incident: context.incident,
      assets: state.phase === "finalize" ? page.assets : [], recommendations, sourceSnapshots: [] }, pageWrite(context.write, recommendations), new Date(state.time), state.budget,
      { assetMapEnabled: Boolean(state.assetMapVersion), sourceSpatialEnabled: Boolean(state.sourceSpatialEncoding), sourceMapEnabled: Boolean(state.sourceMapVersion), revision: publication.revision });
    if (state.phase === "score") {
      const keys: Rank[] = scored.map((row, position) => ({ id: row.id, assetId: row.assetId, assetName: row.assetName,
        score100: row.score100, riskLevel: row.riskLevel, assetRowId: payload.recommendations[position].asset_id,
        recommendationRowId: payload.recommendations[position].id, position: offset + position }));
      keys.sort(compareRecommendations); state.runs.push(await put(store, keys, keys.length, MAX_COMPACT_BYTES));
    } else {
      const asset = await putRows(store, payload.assets, state.rowEncoding);
      const recommendation = await putRows(store, payload.recommendations, state.rowEncoding);
      state.totalBytes += state.rowEncoding ? stagedSize(asset, state.rowEncoding) + stagedSize(recommendation, state.rowEncoding) : asset.bytes + recommendation.bytes;
      if (state.totalBytes > MAX_TOTAL_BYTES) capacity();
      state.assets.push(asset); state.recommendations.push(recommendation);
      processedBytes += asset.bytes + recommendation.bytes;
    }
    state.cursor++; processedBytes += desc.bytes;
  }
  if (state.cursor === input.totalPages) {
    state.phase = state.phase === "score" ? "rank" : "seal"; state.cursor = 0;
  }
  await save(); return null;
}

export async function readPreparedPlan(store: Pick<DerivedAssetStore, "read">, scope: string, layout: string): Promise<PreparedPlan> {
  const plan = await store.read(PREPARATION_READY) as PreparedPlan | null;
  if (!plan || plan.version !== 1 || plan.scope !== scope || plan.layout !== layout || !plan.pages ||
    (plan.rowEncoding !== undefined && plan.rowEncoding !== SHARED_ROW_ENCODING) ||
    (plan.transferRows !== undefined && plan.transferRows !== 256) ||
    plan.header?.version !== "staged-ingestion-v1" || hash(plan.transferRows ? { pages: plan.pages, transferRows: plan.transferRows } : plan.pages) !== plan.header.rowsDigest) invalid();
  const inventory = parseInventoryManifest(plan.header.incident.selected_fire.inventoryManifest);
  if (!inventory) invalid();
  let total = 0;
  for (const [kind, ids] of [["source", inventory.sourceSnapshotIds], ["asset", inventory.assetIds], ["recommendation", inventory.recommendationIds]] as const) {
    const pages = plan.pages[kind];
    if (!Array.isArray(pages) || pages.length > Math.max(128, Math.ceil(MAX_ROWS / 128))) invalid();
    let count = 0;
    for (const page of pages) { checkDescriptor(page); if (page.count > 128 || page.bytes > MAX_PAGE_BYTES || page.jsonbBytes > 32 * 1024 * 1024) invalid(); count += page.count; total += stagedSize(page, plan.rowEncoding); }
    if (count !== ids.length) invalid();
  }
  if (total > MAX_TOTAL_BYTES) capacity();
  return plan;
}
export function preparedCounts(plan: PreparedPlan) {
  return Object.fromEntries(Object.entries(plan.pages).map(([key, pages]) => [key, pages.reduce((sum, page) => sum + page.count, 0)])) as Record<PreparedKind, number>;
}
export async function readPreparedRows(store: Pick<DerivedAssetStore, "read">, plan: PreparedPlan, kind: PreparedKind, position: number) {
  if (!Number.isSafeInteger(position) || position < 0) invalid();
  let offset = 0;
  for (const desc of plan.pages[kind]) {
    if (position < offset + desc.count) {
      const rows = await read<{ id: string }[]>(store, desc);
      if (!Array.isArray(rows) || rows.length !== desc.count) invalid();
      if (plan.rowEncoding && jsonbTextBytes(JSON.stringify(encodeStagedRows(rows, plan.rowEncoding))) !== desc.stagedBytes) invalid();
      return rows.slice(position - offset);
    }
    offset += desc.count;
  }
  invalid();
}

/** New plans may pack two immutable pages, never changing their rows or the sealed byte budget. */
export async function readPreparedTransferRows(store: Pick<DerivedAssetStore, "read">, plan: PreparedPlan, kind: PreparedKind, position: number) {
  const first = await readPreparedRows(store, plan, kind, position);
  if (!plan.transferRows || position + first.length >= preparedCounts(plan)[kind]) return first;
  if (plan.transferRows !== 256) invalid();
  const next = await readPreparedRows(store, plan, kind, position + first.length);
  if (first.length + next.length > plan.transferRows) return first;
  const combined = [...first, ...next], expanded = JSON.stringify(combined);
  if (Buffer.byteLength(expanded) > 32 * 1024 * 1024 || jsonbTextBytes(expanded) > 32 * 1024 * 1024) return first;
  const encoded = JSON.stringify(encodeStagedRows(combined, plan.rowEncoding));
  const separateBytes = [first, next].reduce((sum, rows) => sum + jsonbTextBytes(JSON.stringify(encodeStagedRows(rows, plan.rowEncoding))), 0);
  if (Buffer.byteLength(encoded) > MAX_PAGE_BYTES || jsonbTextBytes(encoded) > separateBytes) return first;
  return combined;
}
