import { expect, it, vi } from "vitest";
import { decodeCheckpoint, encodeCheckpoint } from "./ingestion-checkpoint";
import { DERIVED_ASSET_STATE, DerivedAssetCheckpointError, readDerivedAssetManifest, readDerivedAssetPage,
  stageDerivedAssets, validateDerivedAssetIds } from "./ingestion-assets";
import type { Asset } from "./types";

const assets = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `asset-${index}`, coordinates: [-120 + index / 1e7, 34], evidence: [{ summary: `Evidence ${index}` }],
}) as Asset);
function storage() {
  const records = new Map<string, ReturnType<typeof encodeCheckpoint>>();
  return { records, read: vi.fn(async (key: string): Promise<unknown | null> => {
    const saved = records.get(key);
    return saved ? decodeCheckpoint(saved.manifest, saved.parts.map((value, part) => ({ part, value }))) : null;
  }), write: vi.fn(async (key: string, value: unknown) => {
    const encoded = encodeCheckpoint(value);
    if (key === DERIVED_ASSET_STATE) expect(encoded.parts).toHaveLength(1);
    expect(key.length).toBeLessThanOrEqual(80);
    records.set(key, encoded);
  }) };
}
it("round-trips every asset in order and reads only one immutable page", async () => {
  const store = storage(), input = assets(259);
  const manifest = await stageDerivedAssets(store, input);
  expect(manifest).toMatchObject({ next: 3, total: 259 });
  expect(await readDerivedAssetManifest(store)).toEqual(manifest);
  store.read.mockClear();
  expect(await readDerivedAssetPage(store, manifest, 1)).toEqual(input.slice(128, 256));
  expect(store.read).toHaveBeenCalledTimes(1);
  expect((await Promise.all(manifest.pages.map((_, index) => readDerivedAssetPage(store, manifest, index)))).flat()).toEqual(input);
});
it("represents a complete empty inventory without inventing a page", async () => {
  const store = storage();
  expect(await stageDerivedAssets(store, [])).toMatchObject({ total: 0, next: 0, pages: [] });
  expect(store.records.size).toBe(1);
});
it("bounds each staging step to 32 pages and resumes without rewriting acknowledged pages", async () => {
  const store = storage(), input = assets(128 * 33 + 1);
  const first = await stageDerivedAssets(store, input);
  expect(first.next).toBe(32);
  await expect(readDerivedAssetPage(store, first, 0)).rejects.toThrow(DerivedAssetCheckpointError);
  const written = store.write.mock.calls.length;
  const final = await stageDerivedAssets(store, input);
  expect(final.next).toBe(34);
  expect(store.write.mock.calls.length - written).toBe(4);
  expect(await readDerivedAssetPage(store, final, 33)).toEqual(input.slice(128 * 33));
});
it.each(["page", "cursor"])("recovers after SQL committed a %s but its acknowledgment was lost", async mode => {
  const store = storage(), input = assets(259);
  const write = store.write.getMockImplementation()!;
  let lost = false;
  store.write.mockImplementation(async (key, value) => {
    await write(key, value);
    if (!lost && (mode === "page" ? key.startsWith("da:") : key === DERIVED_ASSET_STATE && (value as { next: number }).next === 1)) {
      lost = true;
      throw new Error("lost acknowledgment");
    }
  });
  await expect(stageDerivedAssets(store, input)).rejects.toThrow("lost acknowledgment");
  const manifest = await stageDerivedAssets(store, input);
  expect(manifest.next).toBe(3);
  const pageWrites = store.write.mock.calls.filter(([key]) => key.startsWith("da:")).map(([key]) => key);
  expect(new Set(pageWrites).size).toBe(pageWrites.length);
  expect((await Promise.all(manifest.pages.map((_, index) => readDerivedAssetPage(store, manifest, index)))).flat()).toEqual(input);
});
it("does not advance the cursor when a page write never committed", async () => {
  const store = storage(), input = assets(259);
  const write = store.write.getMockImplementation()!;
  let fail = true;
  store.write.mockImplementation(async (key, value) => {
    if (fail && key.startsWith("da:")) { fail = false; throw new Error("not committed"); }
    await write(key, value);
  });
  await expect(stageDerivedAssets(store, input)).rejects.toThrow("not committed");
  expect(await readDerivedAssetManifest(store)).toMatchObject({ next: 0 });
  expect(await stageDerivedAssets(store, input)).toMatchObject({ next: 3 });
});
it("rejects changed inputs instead of mixing generations after interruption", async () => {
  const store = storage(), input = assets(128 * 34);
  await stageDerivedAssets(store, input);
  input[0].coordinates[0] += 1;
  await expect(stageDerivedAssets(store, input)).rejects.toThrow("derived_asset_checkpoint_invalid");
});
it.each(["missing", "corrupt", "wrong offset", "wrong page"])("fails closed for a %s page", async mode => {
  const store = storage(), input = assets(259);
  const manifest = await stageDerivedAssets(store, input);
  const key = `da:${manifest.pages[0].hash}`;
  const page = await store.read(key) as { version: number; offset: number; assets: Asset[] };
  if (mode === "missing") store.records.delete(key);
  if (mode === "corrupt") { page.assets[0].coordinates[0] = 0; store.records.set(key, encodeCheckpoint(page)); }
  if (mode === "wrong offset") store.records.set(key, encodeCheckpoint({ ...page, offset: 128 }));
  if (mode === "wrong page") store.records.set(key, store.records.get(`da:${manifest.pages[1].hash}`)!);
  await expect(readDerivedAssetPage(store, manifest, 0)).rejects.toThrow(DerivedAssetCheckpointError);
});
it.each(["version", "total", "next", "fingerprint", "pages"])("rejects an invalid manifest %s", async field => {
  const store = storage();
  const manifest = await stageDerivedAssets(store, assets(5));
  await store.write(DERIVED_ASSET_STATE, { ...manifest, [field]: null });
  await expect(readDerivedAssetManifest(store)).rejects.toThrow(DerivedAssetCheckpointError);
});
it.each([-1, 0.5, 1, NaN])( "rejects an invalid page index %s", async index => {
  const store = storage(), manifest = await stageDerivedAssets(store, assets(5));
  await expect(readDerivedAssetPage(store, manifest, index)).rejects.toThrow(DerivedAssetCheckpointError);
});
it("rejects omitted, reordered or substituted terrain assets without reading all original pages", async () => {
  const store = storage(), input = assets(259), manifest = await stageDerivedAssets(store, input);
  const page = input.slice(128, 256);
  validateDerivedAssetIds(manifest, 1, page);
  expect(() => validateDerivedAssetIds(manifest, 1, page.slice(1))).toThrow(DerivedAssetCheckpointError);
  expect(() => validateDerivedAssetIds(manifest, 1, page.toReversed())).toThrow(DerivedAssetCheckpointError);
  expect(() => validateDerivedAssetIds(manifest, 1, input.slice(0, 128))).toThrow(DerivedAssetCheckpointError);
});
it("rejects duplicate IDs and oversized pages before saving any partial inventory", async () => {
  const store = storage(), input = assets(2);
  await expect(stageDerivedAssets(store, [input[0], input[0]])).rejects.toThrow("derived_asset_checkpoint_invalid");
  input[0].name = "x".repeat(4 * 1024 * 1024);
  await expect(stageDerivedAssets(store, input)).rejects.toThrow("derived_asset_checkpoint_capacity");
  expect(store.records.size).toBe(0);
});
it("bounds a staging step by bytes as well as page count", async () => {
  const store = storage(), input = assets(128 * 4);
  for (const asset of input) asset.name = "x".repeat(24_000);
  const first = await stageDerivedAssets(store, input);
  expect(first.next).toBe(2);
  expect(await stageDerivedAssets(store, input)).toMatchObject({ next: 4 });
});
