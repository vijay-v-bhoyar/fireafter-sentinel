import { describe, expect, it, vi } from "vitest";
import { ArcgisCheckpointError, ArcgisInventoryPending, fetchArcgisInventory } from "./arcgis-inventory";
import { fetch3dhpFlowlinesSource } from "./live-sources";
import type { LocationCandidate } from "./types";

const bbox: [number, number, number, number] = [-120, 34, -119, 35];
const endpoint = "https://example.com/MapServer/50/query";
function fixture(count = 1601) {
  const records = new Map<string, unknown>();
  const checkpoint = {
    read: vi.fn(async (key: string) => structuredClone(records.get(key) ?? null)),
    write: vi.fn(async (key: string, value: unknown) => { records.set(key, structuredClone(value)); }),
  };
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    return Response.json(url.searchParams.get("returnIdsOnly") === "true"
      ? { objectIdFieldName: "OBJECTID", objectIds: ids }
      : { features: url.searchParams.get("objectIds")!.split(",").map(Number).map(id => ({
        attributes: { OBJECTID: id }, geometry: { paths: [[[-119.9, 34.1], [-119.8, 34.2]]] },
      })) });
  });
  const run = (limits = {}) => fetchArcgisInventory(endpoint, bbox, { outFields: "OBJECTID", fetchImpl, checkpoint, limits });
  const stateKey = () => [...records.keys()].find(key => key.endsWith(":state"))!;
  const finish = async () => {
    for (let step = 0; step < 20; step++) {
      try { return await run(); }
      catch (error) { if (!(error instanceof ArcgisInventoryPending)) throw error; }
    }
    throw new Error("Unexpected missing completion");
  };
  return { records, checkpoint, ids, fetchImpl, run, stateKey, finish };
}

describe("checkpointed complete inventory", () => {
  it("keeps the hydro source timestamp at acquisition start across resumptions", async () => {
    const f = fixture(1);
    const location = { bbox, centroid: [-119.5, 34.5] } as LocationCandidate;
    let result: Awaited<ReturnType<typeof fetch3dhpFlowlinesSource>> | undefined;
    for (let step = 0; step < 10; step++) {
      try { result = await fetch3dhpFlowlinesSource(location, { checkpoint: f.checkpoint, fetchImpl: f.fetchImpl, now: new Date("2099-01-01T00:00:00Z") }); break; }
      catch (error) { if (!(error instanceof ArcgisInventoryPending)) throw error; }
    }
    expect(result?.fetchedAt).toBe((f.records.get(f.stateKey()) as { startedAt: string }).startedAt);
    expect(result?.sourceUpdatedAt).toBe(result?.fetchedAt);
    expect(result?.rawPayload).toMatchObject({ inventoryComplete: true, featureCount: 1 });
  });
  it("resumes bounded pages, verifies the full ID set and replays without refetching or renewing dates", async () => {
    const f = fixture();
    await expect(f.run()).rejects.toMatchObject({ saved: 0, total: 1601 });
    await expect(f.run()).rejects.toMatchObject({ saved: 800, total: 1601 });
    expect(f.fetchImpl).toHaveBeenCalledTimes(5);
    await expect(f.run()).rejects.toMatchObject({ saved: 1600, total: 1601 });
    await expect(f.run()).rejects.toMatchObject({ saved: 1601, total: 1601 });
    // A full page count alone is not completeness proof: final IDs are fetched separately.
    expect(f.fetchImpl).toHaveBeenCalledTimes(10);
    await expect(f.run()).rejects.toBeInstanceOf(ArcgisInventoryPending);
    expect(f.fetchImpl).toHaveBeenCalledTimes(11);
    const result = await f.run();
    expect(result.features.map(value => value.attributes.OBJECTID)).toEqual(f.ids);
    expect(result.inventory).toMatchObject({ complete: true, expectedCount: 1601, receivedCount: 1601, requests: 11 });
    expect(result.inventory.startedAt).toBe((f.records.get(f.stateKey()) as { startedAt: string }).startedAt);
    expect(await f.run()).toEqual(result);
    expect(f.fetchImpl).toHaveBeenCalledTimes(11);
  });

  it("never publishes a set whose final provider IDs changed", async () => {
    const f = fixture(1);
    await expect(f.run()).rejects.toBeInstanceOf(ArcgisInventoryPending);
    await expect(f.run()).rejects.toBeInstanceOf(ArcgisInventoryPending);
    f.ids.push(2);
    await expect(f.run()).rejects.toMatchObject({ code: "changed_inventory" });
    expect(f.records.get(f.stateKey())).not.toHaveProperty("completedAt");
  });

  it("recovers a lost cursor-write acknowledgement without downloading acknowledged batches again", async () => {
    const f = fixture(401);
    await expect(f.run()).rejects.toBeInstanceOf(ArcgisInventoryPending);
    const write = f.checkpoint.write.getMockImplementation()!;
    let failed = false;
    f.checkpoint.write.mockImplementation(async (key, value) => {
      await write(key, value);
      if (!failed && key.endsWith(":state") && (value as { cursor?: number }).cursor === 200) {
        failed = true; throw new Error("ack lost after commit");
      }
    });
    await expect(f.run()).rejects.toBeInstanceOf(ArcgisCheckpointError);
    const result = await f.finish();
    expect(result.features).toHaveLength(401);
    expect(f.fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).searchParams.has("objectIds"))).toHaveLength(3);
  });

  it("retains a transfer reservation across a failed request rather than resetting the byte allowance", async () => {
    const f = fixture(401);
    await expect(f.run()).rejects.toBeInstanceOf(ArcgisInventoryPending);
    f.fetchImpl.mockRejectedValueOnce(new Error("network failed after dispatch"));
    await expect(f.run()).rejects.toMatchObject({ code: "provider_error" });
    const charged = (f.records.get(f.stateKey()) as { bytes: number }).bytes;
    expect(charged).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    const result = await f.finish();
    expect(result.features).toHaveLength(401);
    expect(result.inventory.bytes).toBeGreaterThan(charged);
    expect(result.inventory.requests).toBe(6);
  });

  it("enforces aggregate bytes across steps even when each response fits by itself", async () => {
    const f = fixture(1001);
    await expect(f.run({ maxBytes: 45_000 })).rejects.toBeInstanceOf(ArcgisInventoryPending);
    await expect(f.run({ maxBytes: 45_000 })).rejects.toMatchObject({ code: "limit_exceeded" });
    const before = f.fetchImpl.mock.calls.length;
    await expect(f.run({ maxBytes: 45_000 })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(f.fetchImpl).toHaveBeenCalledTimes(before);
  });

  it.each([
    { startedAt: "invalid" }, { startedAt: "2000-01-01T00:00:00Z" }, { scope: "wrong" },
    { cursor: 1 }, { cursor: 99999 }, { bytes: -1 }, { requests: 5000 },
    { ids: null }, { ids: { field: "OBJECTID", values: [2, 1] } },
    { completedAt: "2000-01-01T00:00:00Z" },
  ])("rejects malformed, expired or mismatched checkpoint metadata before acquisition %#", async change => {
    const f = fixture(401);
    await expect(f.run()).rejects.toBeInstanceOf(ArcgisInventoryPending);
    f.records.set(f.stateKey(), { ...(f.records.get(f.stateKey()) as object), ...change });
    f.fetchImpl.mockClear();
    await expect(f.run()).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects missing or altered completed pages rather than returning a partial result", async () => {
    const f = fixture(201);
    await f.finish();
    const key = [...f.records.keys()].find(key => key.endsWith(":batch:200"))!;
    f.records.delete(key);
    await expect(f.run()).rejects.toMatchObject({ code: "incomplete" });
  });

  it.each([false, 0, ""])("does not mistake a malformed checkpoint for a new acquisition: %s", async value => {
    const f = fixture(1);
    await expect(f.run()).rejects.toBeInstanceOf(ArcgisInventoryPending);
    f.records.set(f.stateKey(), value);
    f.fetchImpl.mockClear();
    await expect(f.run()).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("verifies an empty inventory and isolates query identities", async () => {
    const f = fixture(0);
    const result = await f.finish();
    expect(result.features).toEqual([]);
    expect(result.inventory).toMatchObject({ complete: true, requests: 2, receivedCount: 0 });
    await expect(fetchArcgisInventory(endpoint, [-121, 33, -120, 34], {
      outFields: "OBJECTID", checkpoint: f.checkpoint, fetchImpl: f.fetchImpl,
    })).rejects.toMatchObject({ saved: 0, total: 0 });
    expect([...f.records.keys()].filter(key => key.endsWith(":state"))).toHaveLength(2);
  });
});
