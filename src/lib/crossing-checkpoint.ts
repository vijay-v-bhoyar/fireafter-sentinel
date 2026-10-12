import "server-only";
import { createHash } from "node:crypto";
import { InventoryCapacityError } from "./inventory-error";
import type { Asset } from "./types";

export type CrossingCursor = { road: number; part: number; pair: number };
export type CrossingCandidate = { asset: Asset; distanceMeters: number };
export type CrossingPage = { next: CrossingCursor; candidates: CrossingCandidate[]; complete: boolean };
export type CrossingCheckpointStore = {
  read: (key: string) => Promise<unknown>;
  write: (key: string, value: unknown) => Promise<void>;
};
type SavedPage = CrossingPage & { scope: string; from: CrossingCursor; index: number };
type State = { version: 1 | 2; scope: string; next: CrossingCursor; pages: number; candidates: number; complete: boolean; startedAt: string;
  storedBytes?: number; chainHash?: string };
const START: CrossingCursor = { road: 0, part: 0, pair: 0 };
const MAX_PAGES = 2048;
const MAX_CANDIDATES = 20_000;
export const COUNTY_CROSSING_MAX_CANDIDATES = 100_000;
export const COUNTY_CROSSING_PAGE_CANDIDATES = 4096;
export const COUNTY_CROSSING_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const EMPTY_CHAIN = "0".repeat(64);
const chainHash = (previous: string, page: SavedPage) => createHash("sha256").update(previous).update(JSON.stringify(page)).digest("hex");

export class CrossingInferencePending extends Error {
  constructor(public readonly roadsCompleted: number, public readonly candidatesSaved: number) {
    super("Crossing derivation checkpoint saved; continue the same operation.");
    this.name = "CrossingInferencePending";
  }
}

export class CrossingCheckpointError extends Error {
  constructor(public readonly reason: "invalid" | "expired" | "unavailable" = "invalid") {
    super("Crossing checkpoint is unavailable, expired or invalid."); this.name = "CrossingCheckpointError";
  }
}

function cursor(value: unknown): value is CrossingCursor {
  if (!value || typeof value !== "object") return false;
  const v = value as CrossingCursor;
  return [v.road, v.part, v.pair].every(n => Number.isSafeInteger(n) && n >= 0);
}
function compare(a: CrossingCursor, b: CrossingCursor) {
  return a.road - b.road || a.part - b.part || a.pair - b.pair;
}
function fail(reason: CrossingCheckpointError["reason"] = "invalid"): never { throw new CrossingCheckpointError(reason); }

function validateState(value: unknown, scope: string, maxCandidates: number): State {
  if (!value || typeof value !== "object") return fail();
  const v = value as State;
  const started = Date.parse(v.startedAt);
  const paged = maxCandidates > MAX_CANDIDATES;
  if (v.version !== (paged ? 2 : 1) || v.scope !== scope || !cursor(v.next) ||
    !Number.isSafeInteger(v.pages) || v.pages < 0 || v.pages > MAX_PAGES ||
    !Number.isSafeInteger(v.candidates) || v.candidates < 0 || v.candidates > maxCandidates ||
    typeof v.complete !== "boolean" || !Number.isFinite(started) || started > Date.now() ||
    (v.pages === 0 && (v.candidates !== 0 || v.complete || compare(v.next, START) !== 0)) ||
    (paged && (!Number.isSafeInteger(v.storedBytes) || v.storedBytes! < 0 || v.storedBytes! > MAX_TOTAL_BYTES ||
      typeof v.chainHash !== "string" || !/^[a-f0-9]{64}$/.test(v.chainHash) ||
      (v.pages === 0 && (v.storedBytes !== 0 || v.chainHash !== EMPTY_CHAIN))))) return fail();
  if (Date.now() - started > 30 * 60_000) return fail("expired");
  return v;
}

function validatePage(value: unknown, scope: string, index: number, from: CrossingCursor, maxCandidates: number): SavedPage {
  if (!value || typeof value !== "object") return fail();
  const v = value as SavedPage;
  if (v.scope !== scope || v.index !== index || !cursor(v.from) || compare(v.from, from) !== 0 ||
    !cursor(v.next) || typeof v.complete !== "boolean" || compare(v.next, from) < 0 ||
    (!v.complete && compare(v.next, from) === 0) || !Array.isArray(v.candidates) || v.candidates.length > maxCandidates) return fail();
  if (maxCandidates > MAX_CANDIDATES && (v.candidates.length > COUNTY_CROSSING_PAGE_CANDIDATES ||
    Buffer.byteLength(JSON.stringify(v)) > COUNTY_CROSSING_PAGE_BYTES)) throw new InventoryCapacityError("inference_work");
  for (const c of v.candidates) {
    if (!c || !Number.isFinite(c.distanceMeters) || c.distanceMeters < 0 || c.distanceMeters > 220 ||
      !c.asset || typeof c.asset.id !== "string" || !c.asset.id || !Array.isArray(c.asset.coordinates) ||
      c.asset.coordinates.length !== 2 || !c.asset.coordinates.every(Number.isFinite) ||
      Math.abs(c.asset.coordinates[0]) > 180 || Math.abs(c.asset.coordinates[1]) > 90) return fail();
  }
  return v;
}

// Pages are immutable. Publish the small mutable cursor only after its page is
// acknowledged; an orphan page is reconciled before computing anything again.
export async function checkpointCrossingInference(
  scope: string,
  store: CrossingCheckpointStore,
  compute: (next: CrossingCursor, priorCandidates: number) => CrossingPage,
  maxCandidates = MAX_CANDIDATES,
): Promise<CrossingCandidate[]> {
  if (!/^[a-f0-9]{64}$/.test(scope) || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 ||
    maxCandidates > COUNTY_CROSSING_MAX_CANDIDATES) return fail();
  const paged = maxCandidates > MAX_CANDIDATES;
  // Full hash plus the largest page suffix fits the existing 80-character key.
  const prefix = `cross:${scope}`;
  const read = async (key: string) => { try { return await store.read(key); } catch { return fail("unavailable"); } };
  const write = async (key: string, value: unknown) => { try { await store.write(key, value); } catch { return fail("unavailable"); } };
  const saved = await read(`${prefix}:state`);
  let state: State = saved === null ? { version: paged ? 2 : 1, scope, next: { ...START }, pages: 0, candidates: 0,
    complete: false, startedAt: new Date().toISOString(), ...(paged ? { storedBytes: 0, chainHash: EMPTY_CHAIN } : {}) }
    : validateState(saved, scope, maxCandidates);
  if (!state.complete) {
    if (state.pages >= MAX_PAGES) throw new InventoryCapacityError("inference_work");
    // Persist the original age before computation or any ambiguous page write.
    if (saved === null) await write(`${prefix}:state`, state);
    const pageKey = `${prefix}:page:${state.pages}`;
    const orphan = await read(pageKey);
    const page = validatePage(orphan ?? { ...compute({ ...state.next }, state.candidates), scope, from: state.next, index: state.pages },
      scope, state.pages, state.next, maxCandidates);
    if (state.candidates + page.candidates.length > maxCandidates) throw new InventoryCapacityError("inference_candidates");
    const bytes = paged ? state.storedBytes! + Buffer.byteLength(JSON.stringify(page)) : 0;
    if (bytes > MAX_TOTAL_BYTES) throw new InventoryCapacityError("inference_candidates");
    if (orphan === null) await write(pageKey, page);
    state = { ...state, next: page.next, candidates: state.candidates + page.candidates.length,
      pages: state.pages + 1, complete: page.complete,
      ...(paged ? { storedBytes: bytes, chainHash: chainHash(state.chainHash!, page) } : {}) };
    await write(`${prefix}:state`, state);
    if (!state.complete) throw new CrossingInferencePending(state.next.road, state.candidates);
  }

  const candidates: CrossingCandidate[] = [];
  let next = START;
  let bytes = 0, chain = EMPTY_CHAIN;
  for (let index = 0; index < state.pages; index++) {
    const page = validatePage(await read(`${prefix}:page:${index}`), scope, index, next, maxCandidates);
    if (page.complete !== (index === state.pages - 1)) return fail();
    candidates.push(...page.candidates);
    if (candidates.length > maxCandidates) throw new InventoryCapacityError("inference_candidates");
    if (paged) {
      bytes += Buffer.byteLength(JSON.stringify(page));
      if (bytes > MAX_TOTAL_BYTES) throw new InventoryCapacityError("inference_candidates");
      chain = chainHash(chain, page);
    }
    next = page.next;
  }
  if (compare(next, state.next) !== 0 || candidates.length !== state.candidates) return fail();
  if (paged && (bytes !== state.storedBytes || chain !== state.chainHash)) return fail();
  return candidates;
}
