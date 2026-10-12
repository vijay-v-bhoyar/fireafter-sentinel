import { describe, expect, it, vi } from "vitest";
import { ArcgisInventoryPending, fetchArcgisInventory } from "./arcgis-inventory";
import { fetch3dhpFlowlinesSource, fetchTigerRoadsSource } from "./live-sources";
import { withRefreshOperation } from "./refresh-operation";
import type { LocationCandidate } from "./types";

const endpoint = "https://example.com/MapServer/50/query";
const bbox: [number, number, number, number] = [-120, 34, -118, 36];
const boundary = { type: "Polygon", coordinates: [[[-120, 34], [-118, 34], [-118, 36], [-119, 35], [-120, 36], [-120, 34]]] };
function params(input: RequestInfo | URL, init?: RequestInit) {
  return init?.method === "POST" ? new URLSearchParams(String(init.body)) : new URL(String(input)).searchParams;
}
function fixture() {
  const records = new Map<string, unknown>();
  const checkpoint = { read: async (key: string) => structuredClone(records.get(key) ?? null),
    write: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); } };
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const request = params(input, init);
    return Response.json(request.get("returnIdsOnly") === "true"
      ? { objectIdFieldName: "OBJECTID", objectIds: [2, 1] }
      : { features: request.get("objectIds")!.split(",").map(Number).map(id => ({ attributes: { OBJECTID: id }, geometry: { paths: [[[-119.9, 34.1], [-119.8, 34.2]]] } })) });
  });
  return { fetchImpl, checkpoint, records };
}

describe("polygon-scoped ArcGIS inventory", () => {
  it("posts the lossless spatial query twice, fetches exact IDs without repeating geometry, and records its scope", async () => {
    const f = fixture();
    const result = await withRefreshOperation("refresh", () => fetchArcgisInventory(endpoint, bbox, { outFields: "OBJECTID", boundary, fetchImpl: f.fetchImpl }));
    expect(result.inventory).toMatchObject({ scope: "polygon-intersecting-object-id-set", complete: true, receivedCount: 2, requests: 3 });
    expect(result.inventory.geometryHash).toMatch(/^[a-f0-9]{64}$/);
    const [first, batch, last] = f.fetchImpl.mock.calls;
    expect(first[1]).toMatchObject({ method: "POST", cache: "no-store", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(new URL(String(first[0])).search).toBe("");
    expect(params(...first).get("geometryType")).toBe("esriGeometryPolygon");
    expect(params(...first).get("spatialRel")).toBe("esriSpatialRelIntersects");
    expect(JSON.parse(params(...first).get("geometry")!).rings[0].toReversed()).toEqual(boundary.coordinates[0]);
    expect(params(...last).get("geometry")).toBe(params(...first).get("geometry"));
    expect(params(...batch).get("objectIds")).toBe("1,2");
    expect(params(...batch).has("geometry")).toBe(false);
    expect(params(...batch).get("outSR")).toBe("4326");
    expect(batch[1]?.body).toBeUndefined();
  });

  it("does not reuse another polygon's checkpoint even when their envelopes match", async () => {
    const f = fixture();
    const run = (shape: unknown) => fetchArcgisInventory(endpoint, bbox, { outFields: "OBJECTID", boundary: shape, ...f });
    await expect(run(boundary)).rejects.toBeInstanceOf(ArcgisInventoryPending);
    const other = { type: "Polygon", coordinates: [[[-120, 34], [-118, 34], [-118, 36], [-120, 36], [-120, 34]]] };
    await expect(run(other)).rejects.toBeInstanceOf(ArcgisInventoryPending);
    expect([...f.records.keys()].filter(key => key.endsWith(":state"))).toHaveLength(2);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("resumes and replays the exact query with its original dates", async () => {
    const f = fixture();
    let result;
    for (let step = 0; step < 5; step++) {
      try { result = await fetchArcgisInventory(endpoint, bbox, { outFields: "OBJECTID", boundary, ...f }); break; }
      catch (error) { expect(error).toBeInstanceOf(ArcgisInventoryPending); }
    }
    expect(result?.inventory.receivedCount).toBe(2);
    const replay = await fetchArcgisInventory(endpoint, bbox, { outFields: "OBJECTID", boundary, checkpoint: f.checkpoint,
      fetchImpl: () => { throw new Error("Unexpected replay acquisition"); } });
    expect(replay).toEqual(result);
  });

  it.each([null, { type: "Point", coordinates: [-119, 35] },
    { type: "Polygon", coordinates: [[[-120, 34], [-118, 34], [-118, 36]]] },
    { type: "Polygon", coordinates: [[[-121, 34], [-118, 34], [-118, 36], [-121, 34]]] },
  ])("rejects invalid or mismatched supplied geometry instead of silently querying an envelope %#", async shape => {
    const f = fixture();
    await expect(fetchArcgisInventory(endpoint, bbox, { outFields: "OBJECTID", boundary: shape, fetchImpl: f.fetchImpl })).rejects.toMatchObject({ code: "invalid_geometry" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("rechecks the polygon's final ID set and refuses changed coverage", async () => {
    const f = fixture();
    let enumerations = 0;
    const provider = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (input, init) => {
      if (params(input, init).get("returnIdsOnly") === "true" && ++enumerations === 2) return Response.json({ objectIdFieldName: "OBJECTID", objectIds: [1, 2, 3] });
      return provider(input, init);
    });
    await expect(fetchArcgisInventory(endpoint, bbox, { outFields: "OBJECTID", boundary, fetchImpl: f.fetchImpl })).rejects.toMatchObject({ code: "changed_inventory" });
  });

  it("routes a real county adapter through the polygon and requires live county geometry", async () => {
    const f = fixture();
    const location = { bbox, centroid: [-119, 35], sourceKey: "tigerweb-counties", boundary } as LocationCandidate;
    const result = await fetch3dhpFlowlinesSource(location, { fetchImpl: f.fetchImpl });
    expect(result.rawPayload.inventory).toMatchObject({ scope: "polygon-intersecting-object-id-set", receivedCount: 2 });
    f.fetchImpl.mockClear();
    await expect(fetch3dhpFlowlinesSource({ ...location, boundary: undefined }, { fetchImpl: f.fetchImpl })).rejects.toMatchObject({ code: "invalid_geometry" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the same verified polygon for all road layers and requires live county geometry", async () => {
    const f = fixture();
    const location = { bbox, centroid: [-119, 35], sourceKey: "tigerweb-counties", boundary } as LocationCandidate;
    const result = await fetchTigerRoadsSource(location, { fetchImpl: f.fetchImpl });
    expect(result.rawPayload.inventoryComplete).toBe(true);
    expect(result.rawPayload.inventories).toHaveLength(3);
    expect(result.rawPayload.inventories).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({
      scope: "polygon-intersecting-object-id-set", receivedCount: 2, geometryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })));
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(6);
    f.fetchImpl.mockClear();
    await expect(fetchTigerRoadsSource({ ...location, boundary: undefined }, { fetchImpl: f.fetchImpl })).rejects.toMatchObject({ code: "invalid_geometry" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a failed road layer explicitly partial rather than substituting its envelope", async () => {
    const f = fixture();
    const provider = f.fetchImpl.getMockImplementation()!;
    let failedLayer: string | undefined;
    f.fetchImpl.mockImplementation(async (input, init) => {
      const layer = new URL(String(input)).pathname;
      failedLayer ??= layer;
      return layer === failedLayer ? Response.json({ error: { message: "Unavailable" } }) : provider(input, init);
    });
    const result = await fetchTigerRoadsSource({ bbox, centroid: [-119, 35], boundary } as LocationCandidate, { fetchImpl: f.fetchImpl });
    expect(result).toMatchObject({ status: "delayed", coverageStatus: "partial", rawPayload: { inventoryComplete: false } });
    expect(result.rawPayload.inventories).toHaveLength(2);
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST").every(call => params(...call).get("geometryType") === "esriGeometryPolygon")).toBe(true);
  });
});
