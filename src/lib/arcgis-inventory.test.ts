import { describe, expect, it, vi } from "vitest";
import { ArcgisInventoryError, fetchArcgisInventory } from "./arcgis-inventory";

const endpoint = "https://example.com/arcgis/MapServer/1/query";
const bbox: [number, number, number, number] = [-119.6, 34, -118.6, 34.7];
const json = (value: unknown) => new Response(JSON.stringify(value));
const feature = (id: number) => ({ attributes: { FID: id, NAME: `record-${id}` }, geometry: { x: -119, y: 34.5 } });
function provider(values: number[]) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("returnIdsOnly") === "true") return json({ objectIdFieldName: "FID", objectIds: [...values].reverse() });
    return json({ features: url.searchParams.get("objectIds")!.split(",").map(Number).reverse().map(feature) });
  });
}
const acquire = (fetchImpl: typeof fetch, limits?: { maxFeatures?: number; maxBytes?: number; timeoutMs?: number }) =>
  fetchArcgisInventory(endpoint, bbox, { outFields: "NAME", fetchImpl, limits });

describe("complete ArcGIS inventory acquisition", () => {
  it("requests the discovered ID field only once when its casing differs from the configured fields", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("returnIdsOnly") === "true") return json({ objectIdFieldName: "objectid", objectIds: [42] });
      const fields = url.searchParams.get("outFields")!.toLowerCase().split(",");
      expect(fields.filter((field) => field === "objectid")).toHaveLength(1);
      return json({ features: [{ attributes: { objectid: 42, name: "Real provider shape" } }] });
    };
    const result = await fetchArcgisInventory("https://provider.example/0/query", [-120, 34, -119, 35], { outFields: "OBJECTID,NAME", fetchImpl });
    expect(result.inventory.receivedCount).toBe(1);
  });

  it("enumerates and fetches every ID across batches with deterministic order and complete provenance", async () => {
    const values = Array.from({ length: 401 }, (_, i) => i + 1);
    const fetchImpl = provider(values);
    const result = await acquire(fetchImpl);
    expect(result.features.map((f) => f.attributes.FID)).toEqual(values);
    expect(result.inventory).toMatchObject({ complete: true, expectedCount: 401, receivedCount: 401,
      requests: 5, objectIdFieldName: "FID", scope: "bbox-matching-object-id-set" });
    for (const [input, init] of fetchImpl.mock.calls) {
      const url = new URL(String(input));
      expect(url.searchParams.get("geometry")).toBe(bbox.join(","));
      expect(url.searchParams.get("resultRecordCount")).toBeNull();
      expect(init?.cache).toBe("no-store");
      if (url.searchParams.has("objectIds")) expect(url.searchParams.get("outFields")).toBe("NAME,FID");
    }
  });

  it("proves an empty inventory without fabricating features", async () => {
    const fetchImpl = provider([]);
    expect((await acquire(fetchImpl)).inventory).toMatchObject({ expectedCount: 0, receivedCount: 0, requests: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { objectIdFieldName: "FID", objectIds: [1, 1] },
    { objectIdFieldName: "FID", objectIds: [Number.MAX_SAFE_INTEGER + 1] },
    { objectIdFieldName: "FID", objectIds: ["1"] },
    { objectIdFieldName: "FID" },
    { objectIdFieldName: "", objectIds: [] },
  ])("rejects invalid ID enumeration %#", async (payload) => {
    await expect(acquire(vi.fn(async () => json(payload)))).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { features: [] },
    { features: [feature(2)] },
    { features: [feature(1), feature(1)] },
    { features: [feature(1)], exceededTransferLimit: true },
  ])("rejects missing, foreign, duplicate or truncated feature batches %#", async (payload) => {
    const fetchImpl = provider([1]);
    fetchImpl.mockImplementationOnce(async () => json({ objectIdFieldName: "FID", objectIds: [1] }))
      .mockImplementationOnce(async () => json(payload));
    await expect(acquire(fetchImpl)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("rejects ID transfer truncation before fetching any feature", async () => {
    const fetchImpl = vi.fn(async () => json({ objectIdFieldName: "FID", objectIds: [1], exceededTransferLimit: true }));
    await expect(acquire(fetchImpl)).rejects.toMatchObject({ code: "incomplete" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts provider null IDs only when an independent count confirms zero on both reads", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => new URL(String(input)).searchParams.get("returnCountOnly") === "true"
      ? json({ count: 0 }) : json({ objectIdFieldName: "objectid", objectIds: null }));
    const result = await acquire(fetchImpl);
    expect(result.inventory).toMatchObject({ expectedCount: 0, receivedCount: 0, complete: true, requests: 4 });
    expect(result.features).toEqual([]);
  });

  it("does not interpret null IDs as empty when the provider reports matching records", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => new URL(String(input)).searchParams.get("returnCountOnly") === "true"
      ? json({ count: 2 }) : json({ objectIdFieldName: "objectid", objectIds: null }));
    await expect(acquire(fetchImpl)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("rejects changes to the matching inventory during acquisition", async () => {
    const fetchImpl = provider([1]);
    fetchImpl.mockImplementationOnce(async () => json({ objectIdFieldName: "FID", objectIds: [1] }))
      .mockImplementationOnce(async () => json({ features: [feature(1)] }))
      .mockImplementationOnce(async () => json({ objectIdFieldName: "FID", objectIds: [1, 2] }));
    await expect(acquire(fetchImpl)).rejects.toMatchObject({ code: "changed_inventory" });
  });

  it("enforces configured feature and aggregate byte budgets without falling back", async () => {
    const fetchImpl = provider([1, 2]);
    await expect(acquire(fetchImpl, { maxFeatures: 1 })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const small = provider([1]);
    await expect(acquire(small, { maxBytes: 130 })).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("enforces a full-body deadline and cancels a stalled response after headers", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    // Keep the test process alive while the platform's unref'ed timeout fires.
    const keepAlive = setTimeout(() => undefined, 1000);
    try {
      await expect(acquire(fetchImpl, { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(keepAlive); }
  });

  it("bounds body bytes even with no Content-Length and cancels the stream", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel,
    })));
    await expect(acquire(fetchImpl)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not wait indefinitely for an upstream cancellation acknowledgement", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel,
    })));
    await expect(acquire(fetchImpl, { maxBytes: 10 })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("fails closed on invalid budgets before network access", async () => {
    const fetchImpl = provider([1]);
    await expect(acquire(fetchImpl, { maxFeatures: 0 })).rejects.toMatchObject({ code: "invalid_config" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns stable errors without echoing provider diagnostics or private URLs", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { code: 500, message: "private-provider-detail" } }));
    const failure = await acquire(fetchImpl).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArcgisInventoryError);
    expect(String(failure)).not.toContain("private-provider-detail");
    expect(String(failure)).not.toContain(endpoint);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
