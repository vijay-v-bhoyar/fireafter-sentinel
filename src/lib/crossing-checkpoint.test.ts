import { afterEach, describe, expect, it, vi } from "vitest";
import { checkpointCrossingInference, CrossingCheckpointError, CrossingInferencePending,
  COUNTY_CROSSING_MAX_CANDIDATES, COUNTY_CROSSING_PAGE_BYTES, COUNTY_CROSSING_PAGE_CANDIDATES,
  type CrossingCandidate, type CrossingCursor, type CrossingPage } from "./crossing-checkpoint";
import { inferCrossingAssets, inferCrossingAssetsResumable } from "./live-sources";
import type { Asset, Incident } from "./types";

const scope = "a".repeat(64);
const prefix = `cross:${scope}`;
const candidate = (id: string): CrossingCandidate => ({ distanceMeters: 0,
  asset: { id, coordinates: [-119, 34] } as Asset });
function fixture() {
  const records = new Map<string, string>();
  const store = { read: vi.fn(async (key: string): Promise<unknown> => records.has(key) ? JSON.parse(records.get(key)!) : null),
    write: vi.fn(async (key: string, value: unknown) => { records.set(key, JSON.stringify(value)); }) };
  const compute = vi.fn((next: CrossingCursor, count: number): CrossingPage => ({ next: { road: next.road + 1, part: 0, pair: 0 },
    candidates: [candidate(`asset-${count}`)], complete: next.road === 1 }));
  return { records, store, compute };
}
afterEach(() => vi.restoreAllMocks());

describe("checkpointed crossing traversal", () => {
  it("withholds partial candidates, completes a verified chain, and replays without recomputation", async () => {
    const f = fixture();
    await expect(checkpointCrossingInference(scope, f.store, f.compute)).rejects.toMatchObject({ roadsCompleted: 1, candidatesSaved: 1 });
    const original = JSON.parse(f.records.get(`${prefix}:state`)!);
    const result = await checkpointCrossingInference(scope, f.store, f.compute);
    expect(result).toEqual([candidate("asset-0"), candidate("asset-1")]);
    expect(await checkpointCrossingInference(scope, f.store, f.compute)).toEqual(result);
    expect(f.compute).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.records.get(`${prefix}:state`)!)).toMatchObject({ startedAt: original.startedAt, pages: 2, candidates: 2, complete: true });
  });

  it.each(["page", "state"])("reconciles an unacknowledged %s write without skipping or duplicating pairs", async target => {
    const f = fixture();
    const write = f.store.write.getMockImplementation()!;
    let failed = false;
    f.store.write.mockImplementation(async (key, value) => {
      await write(key, value);
      if (!failed && (target === "page" ? key.endsWith(":page:0") : key.endsWith(":state") && (value as { pages: number }).pages === 1)) {
        failed = true;
        throw new Error("lost acknowledgment");
      }
    });
    await expect(checkpointCrossingInference(scope, f.store, f.compute)).rejects.toBeInstanceOf(CrossingCheckpointError);
    if (target === "page") await expect(checkpointCrossingInference(scope, f.store, f.compute)).rejects.toBeInstanceOf(CrossingInferencePending);
    expect(await checkpointCrossingInference(scope, f.store, f.compute)).toEqual([candidate("asset-0"), candidate("asset-1")]);
    expect(f.compute).toHaveBeenCalledTimes(2);
  });

  it("preserves the original cursor after a failed page write and retries only that page", async () => {
    const f = fixture();
    const write = f.store.write.getMockImplementation()!;
    f.store.write.mockImplementationOnce(write).mockRejectedValueOnce(new Error("storage offline"));
    await expect(checkpointCrossingInference(scope, f.store, f.compute)).rejects.toBeInstanceOf(CrossingCheckpointError);
    expect(JSON.parse(f.records.get(`${prefix}:state`)!)).toMatchObject({ pages: 0, candidates: 0, next: { road: 0, part: 0, pair: 0 } });
    await expect(checkpointCrossingInference(scope, f.store, f.compute)).rejects.toBeInstanceOf(CrossingInferencePending);
    expect(await checkpointCrossingInference(scope, f.store, f.compute)).toHaveLength(2);
  });

  it.each(["missing page", "broken cursor", "wrong scope", "wrong count", "expired state", "incomplete final page"])("rejects %s rather than returning an incomplete saved set", async defect => {
    const f = fixture();
    await expect(checkpointCrossingInference(scope, f.store, f.compute)).rejects.toBeInstanceOf(CrossingInferencePending);
    await checkpointCrossingInference(scope, f.store, f.compute);
    const key = defect.includes("state") || defect === "wrong count" ? `${prefix}:state` : `${prefix}:page:1`;
    const value = JSON.parse(f.records.get(key)!);
    if (defect === "missing page") f.records.delete(key);
    else {
      if (defect === "broken cursor") value.from.pair++;
      if (defect === "wrong scope") value.scope = "b".repeat(64);
      if (defect === "wrong count") value.candidates++;
      if (defect === "expired state") value.startedAt = new Date(Date.now() - 31 * 60_000).toISOString();
      if (defect === "incomplete final page") value.complete = false;
      f.records.set(key, JSON.stringify(value));
    }
    await expect(checkpointCrossingInference(scope, f.store, f.compute)).rejects.toBeInstanceOf(CrossingCheckpointError);
    expect(f.compute).toHaveBeenCalledTimes(2);
  });

  it("isolates changed input scope and fails closed on a stalled traversal or exhausted aggregate candidate budget", async () => {
    const f = fixture();
    await expect(checkpointCrossingInference(scope, f.store, f.compute)).rejects.toBeInstanceOf(CrossingInferencePending);
    await expect(checkpointCrossingInference("b".repeat(64), f.store, f.compute)).rejects.toBeInstanceOf(CrossingInferencePending);
    expect(f.compute.mock.calls[1][0]).toEqual({ road: 0, part: 0, pair: 0 });
    const stalled = fixture();
    await expect(checkpointCrossingInference(scope, stalled.store, next => ({ next, candidates: [], complete: false }))).rejects.toBeInstanceOf(CrossingCheckpointError);
    const state = JSON.parse(f.records.get(`${prefix}:state`)!);
    f.records.set(`${prefix}:state`, JSON.stringify({ ...state, candidates: 20_000 }));
    await expect(checkpointCrossingInference(scope, f.store, f.compute)).rejects.toMatchObject({ code: "inference_candidates" });
  });
});

describe("resumable geometry equivalence", () => {
  const incident = { id: "incident-test" } as Incident;
  const road = { id: "road", sourceKey: "tiger-roads", sourceName: "Roads",
    paths: [[[-120.001, 34], [-118.999, 34]], [[-119.999, 35], [-119.995, 35]]] as [number, number][][] };
  const flows = Array.from({ length: 100 }, (_, index) => ({ id: `flow-${index}`, sourceKey: "3dhp-flowlines", sourceName: "Hydro",
    paths: [[[-120 + index * 0.01, 33.999], [-120 + index * 0.01, 34.001]]] as [number, number][][] }));

  it("resumes inside one multipart road, preserving exact synchronous candidates and immutable inputs", async () => {
    const f = fixture();
    const expected = inferCrossingAssets(incident, [road], flows);
    const before = JSON.stringify({ road, flows });
    let result: Asset[] | undefined;
    let pending = 0;
    for (let step = 0; step < 100; step++) {
      try { result = await inferCrossingAssetsResumable(incident, [road], flows, [], f.store, { maxWork: 1200 }); break; }
      catch (error) { expect(error).toBeInstanceOf(CrossingInferencePending); pending++; }
    }
    expect(pending).toBeGreaterThan(0);
    expect(result).toEqual(expected);
    expect([...f.records.entries()].filter(([key]) => key.includes(":page:")).some(([, raw]) => JSON.parse(raw).next.pair > 0)).toBe(true);
    expect(JSON.stringify({ road, flows })).toBe(before);
    expect(await inferCrossingAssetsResumable(incident, [road], flows, [], f.store, { maxWork: 1200 })).toEqual(expected);
  });

  it("keeps candidate and indivisible-work limits enforced rather than emitting partial success", async () => {
    const f = fixture();
    await expect(inferCrossingAssetsResumable(incident, [road], flows, [], f.store, { maxCandidates: 1 })).rejects.toMatchObject({ code: "inference_candidates" });
    await expect(inferCrossingAssetsResumable(incident, [road], flows, [], f.store, { maxWork: 1 })).rejects.toMatchObject({ code: "inference_work" });
    expect([...f.records.values()].every(raw => !JSON.parse(raw).complete)).toBe(true);
  });

  it("pages a complete real geometry result without changing distances, identities or ordering", async () => {
    const f = fixture();
    const manyFlows = Array.from({ length: 2500 }, (_, index) => ({ ...flows[0], id: `page-flow-${index}`,
      paths: [[[-120 + index * 0.0004, 33.999], [-120 + index * 0.0004, 34.001]]] as [number, number][][] }));
    const expected = inferCrossingAssets(incident, [road], manyFlows);
    let actual: Asset[] | undefined;
    for (let step = 0; step < 30; step++) {
      try { actual = await inferCrossingAssetsResumable(incident, [road], manyFlows, [], f.store,
        { maxCandidates: COUNTY_CROSSING_MAX_CANDIDATES }); break; }
      catch (error) { expect(error).toBeInstanceOf(CrossingInferencePending); }
    }
    expect(expected).toHaveLength(2500);
    expect(actual).toEqual(expected);
    const pages = [...f.records.entries()].filter(([key]) => key.includes(":page:"));
    expect(pages.length).toBeGreaterThan(1);
    for (const [, raw] of pages) {
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(COUNTY_CROSSING_PAGE_BYTES);
      expect(JSON.parse(raw).candidates.length).toBeLessThanOrEqual(COUNTY_CROSSING_PAGE_CANDIDATES);
    }
    expect(() => inferCrossingAssets(incident, [road], manyFlows, [], { maxCandidates: COUNTY_CROSSING_MAX_CANDIDATES })).toThrow("Invalid crossing inference budget");
  });
});

describe("bounded county candidate journal", () => {
  const limit = COUNTY_CROSSING_MAX_CANDIDATES;
  it("keeps a complete set above the old ceiling and verifies every saved page on replay", async () => {
    const f = fixture();
    const compute = vi.fn((next: CrossingCursor): CrossingPage => ({ next: { road: next.road + 1, part: 0, pair: 0 },
      candidates: Array.from({ length: 3000 }, (_, index) => candidate(`asset-${next.road * 3000 + index}`)), complete: next.road === 7 }));
    for (let step = 0; step < 7; step++) await expect(checkpointCrossingInference(scope, f.store, compute, limit)).rejects.toBeInstanceOf(CrossingInferencePending);
    const result = await checkpointCrossingInference(scope, f.store, compute, limit);
    expect(result).toHaveLength(24_000);
    expect(new Set(result.map(item => item.asset.id)).size).toBe(24_000);
    expect(result).toEqual(Array.from({ length: 24_000 }, (_, index) => candidate(`asset-${index}`)));
    expect(await checkpointCrossingInference(scope, f.store, compute, limit)).toEqual(result);
    expect(compute).toHaveBeenCalledTimes(8);
    const key = `${prefix}:page:2`, page = JSON.parse(f.records.get(key)!);
    page.candidates[0].asset.coordinates[0] += 0.1;
    f.records.set(key, JSON.stringify(page));
    await expect(checkpointCrossingInference(scope, f.store, compute, limit)).rejects.toBeInstanceOf(CrossingCheckpointError);
    await expect(checkpointCrossingInference(scope, f.store, compute)).rejects.toBeInstanceOf(CrossingCheckpointError);
  });
  it.each(["count", "bytes"])("rejects an indivisible oversized %s page before saving it", async mode => {
    const f = fixture();
    const rows = mode === "count" ? Array.from({ length: COUNTY_CROSSING_PAGE_CANDIDATES + 1 }, (_, i) => candidate(`${i}`))
      : [candidate("x".repeat(COUNTY_CROSSING_PAGE_BYTES))];
    await expect(checkpointCrossingInference(scope, f.store, () => ({ next: { road: 1, part: 0, pair: 0 }, candidates: rows, complete: true }), limit))
      .rejects.toMatchObject({ code: "inference_work" });
    expect([...f.records.keys()].filter(key => key.includes(":page:"))).toHaveLength(0);
  });
  it.each(["page", "state"])("retains the chain after a lost %s acknowledgment", async target => {
    const f = fixture(), write = f.store.write.getMockImplementation()!;
    let lost = false;
    f.store.write.mockImplementation(async (key, value) => {
      await write(key, value);
      if (!lost && (target === "page" ? key.includes(":page:") : (value as { pages?: number }).pages === 1)) {
        lost = true; throw new Error("lost acknowledgment");
      }
    });
    await expect(checkpointCrossingInference(scope, f.store, f.compute, limit)).rejects.toBeInstanceOf(CrossingCheckpointError);
    if (target === "page") await expect(checkpointCrossingInference(scope, f.store, f.compute, limit)).rejects.toBeInstanceOf(CrossingInferencePending);
    expect(await checkpointCrossingInference(scope, f.store, f.compute, limit)).toEqual([candidate("asset-0"), candidate("asset-1")]);
    expect(f.compute).toHaveBeenCalledTimes(2);
  });
  it.each(["candidate", "storage"])("keeps the aggregate %s ceiling after pagination", async kind => {
    const f = fixture();
    await expect(checkpointCrossingInference(scope, f.store, f.compute, limit)).rejects.toBeInstanceOf(CrossingInferencePending);
    const state = JSON.parse(f.records.get(`${prefix}:state`)!);
    f.records.set(`${prefix}:state`, JSON.stringify({ ...state, ...(kind === "candidate" ? { candidates: limit } : { storedBytes: 256 * 1024 * 1024 }) }));
    await expect(checkpointCrossingInference(scope, f.store, f.compute, limit)).rejects.toMatchObject({ code: "inference_candidates" });
    expect(f.records.has(`${prefix}:page:1`)).toBe(false);
  });
});
