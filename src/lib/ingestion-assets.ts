import "server-only";
import { createHash } from "node:crypto";
import { TERRAIN_CHUNK_SIZE } from "./ingestion-contract";
import type { Asset } from "./types";

export const DERIVED_ASSET_STATE = "derived:assets:state";
const MAX_ASSETS = 100_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const PAGES_PER_STEP = 32;
const BYTES_PER_STEP = 8 * 1024 * 1024;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export type DerivedAssetStore = {
  read(key: string): Promise<unknown | null>;
  // The state key must use the lease-fenced atomic checkpoint writer.
  write(key: string, value: unknown): Promise<void>;
};
type PageDescriptor = { hash: string; bytes: number; count: number; idsHash: string };
export type DerivedAssetManifest = {
  version: 1; total: number; pageSize: typeof TERRAIN_CHUNK_SIZE;
  pages: PageDescriptor[]; fingerprint: string; next: number;
};
type AssetPage = { version: 1; offset: number; assets: Asset[] };

export class DerivedAssetCheckpointError extends Error {
  constructor(readonly reason: "invalid" | "capacity") {
    super(`derived_asset_checkpoint_${reason}`);
    this.name = "DerivedAssetCheckpointError";
  }
}
function invalid(): never { throw new DerivedAssetCheckpointError("invalid"); }
function fingerprint(total: number, pages: PageDescriptor[]) {
  return hash(JSON.stringify({ version: 1, total, pageSize: TERRAIN_CHUNK_SIZE, pages }));
}
function pageKey(descriptor: PageDescriptor) { return `da:${descriptor.hash}`; }

export async function readDerivedAssetManifest(store: Pick<DerivedAssetStore, "read">): Promise<DerivedAssetManifest | null> {
  const raw = await store.read(DERIVED_ASSET_STATE);
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const value = raw as DerivedAssetManifest;
  if (value.version !== 1 || value.pageSize !== TERRAIN_CHUNK_SIZE || !Number.isSafeInteger(value.total) ||
    value.total < 0 || value.total > MAX_ASSETS || !Array.isArray(value.pages) ||
    value.pages.length !== Math.ceil(value.total / TERRAIN_CHUNK_SIZE) ||
    !Number.isSafeInteger(value.next) || value.next < 0 || value.next > value.pages.length || !validHash(value.fingerprint)) invalid();
  let bytes = 0;
  const pages = value.pages.map((page, index) => {
    if (!page || !validHash(page.hash) || !validHash(page.idsHash) || !Number.isSafeInteger(page.bytes) || page.bytes < 1 || page.bytes > MAX_PAGE_BYTES ||
      page.count !== Math.min(TERRAIN_CHUNK_SIZE, value.total - index * TERRAIN_CHUNK_SIZE)) invalid();
    bytes += page.bytes;
    return { hash: page.hash, bytes: page.bytes, count: page.count, idsHash: page.idsHash };
  });
  if (bytes > MAX_TOTAL_BYTES || fingerprint(value.total, pages) !== value.fingerprint) invalid();
  return { version: 1, total: value.total, pageSize: TERRAIN_CHUNK_SIZE, pages, fingerprint: value.fingerprint, next: value.next };
}

function validatePage(raw: unknown, descriptor: PageDescriptor, index: number): Asset[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const page = raw as AssetPage;
  if (page.version !== 1 || page.offset !== index * TERRAIN_CHUNK_SIZE || !Array.isArray(page.assets) ||
    page.assets.length !== descriptor.count || page.assets.some(asset => !asset || typeof asset.id !== "string" || !asset.id)) invalid();
  const serialized = JSON.stringify(page);
  if (Buffer.byteLength(serialized) !== descriptor.bytes || hash(serialized) !== descriptor.hash ||
    hash(JSON.stringify(page.assets.map(asset => asset.id))) !== descriptor.idsHash) invalid();
  return page.assets;
}

export async function readDerivedAssetPage(store: Pick<DerivedAssetStore, "read">, manifest: DerivedAssetManifest, index: number) {
  if (manifest.next !== manifest.pages.length || !Number.isSafeInteger(index) || index < 0 || index >= manifest.pages.length) invalid();
  const descriptor = manifest.pages[index];
  return validatePage(await store.read(pageKey(descriptor)), descriptor, index);
}

export function validateDerivedAssetIds(manifest: DerivedAssetManifest, index: number, assets: Asset[]) {
  const page = manifest.pages[index];
  if (!page || !Array.isArray(assets) || assets.length !== page.count ||
    assets.some(asset => !asset || typeof asset.id !== "string") ||
    hash(JSON.stringify(assets.map(asset => asset.id))) !== page.idsHash) invalid();
}

export async function stageDerivedAssets(store: DerivedAssetStore, assets: Asset[]): Promise<DerivedAssetManifest> {
  if (assets.length > MAX_ASSETS) throw new DerivedAssetCheckpointError("capacity");
  const ids = new Set<string>();
  const pages: PageDescriptor[] = [];
  let bytes = 0;
  for (let offset = 0; offset < assets.length; offset += TERRAIN_CHUNK_SIZE) {
    const slice = assets.slice(offset, offset + TERRAIN_CHUNK_SIZE);
    for (const asset of slice) {
      if (!asset || typeof asset.id !== "string" || !asset.id || ids.has(asset.id)) invalid();
      ids.add(asset.id);
    }
    const text = JSON.stringify({ version: 1, offset, assets: slice });
    const size = Buffer.byteLength(text);
    bytes += size;
    if (size > MAX_PAGE_BYTES || bytes > MAX_TOTAL_BYTES) throw new DerivedAssetCheckpointError("capacity");
    pages.push({ hash: hash(text), bytes: size, count: slice.length, idsHash: hash(JSON.stringify(slice.map(asset => asset.id))) });
  }
  const expected = fingerprint(assets.length, pages);
  let state = await readDerivedAssetManifest(store);
  if (state && state.fingerprint !== expected) invalid();
  if (!state) {
    state = { version: 1, total: assets.length, pageSize: TERRAIN_CHUNK_SIZE, pages, fingerprint: expected, next: 0 };
    await store.write(DERIVED_ASSET_STATE, state);
  }
  let writtenBytes = 0;
  const end = Math.min(state.pages.length, state.next + PAGES_PER_STEP);
  for (let index = state.next; index < end; index++) {
    const descriptor = state.pages[index];
    if (writtenBytes && writtenBytes + descriptor.bytes > BYTES_PER_STEP) break;
    const key = pageKey(descriptor);
    const saved = await store.read(key);
    if (saved !== null) validatePage(saved, descriptor, index);
    else await store.write(key, { version: 1, offset: index * TERRAIN_CHUNK_SIZE,
      assets: assets.slice(index * TERRAIN_CHUNK_SIZE, (index + 1) * TERRAIN_CHUNK_SIZE) });
    // A lost acknowledgment can leave an immutable page ahead of this cursor.
    // Verify and adopt that same page on replay; never publish an incomplete set.
    state = { ...state, next: index + 1 };
    await store.write(DERIVED_ASSET_STATE, state);
    writtenBytes += descriptor.bytes;
  }
  return state;
}
