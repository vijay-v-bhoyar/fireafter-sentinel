import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEpqsSource } from "./live-sources";
import { ELEVATION_BATCH_URL } from "./elevation-batch";
import { withRefreshOperation } from "./refresh-operation";
import type { LocationCandidate } from "./types";

const location = { id: "monterey-county-ca", centroid: [-121.3067, 36.2395] } as LocationCandidate;
const now = new Date("2026-10-08T07:00:00Z");
function samples(value: unknown = "321.197204590", point = location.centroid) {
  return Response.json({ samples: [{ locationId: 0, value,
    location: { x: point[0], y: point[1], spatialReference: { wkid: 4326 } } }] });
}
function transport(epqs: () => Response | Promise<Response>, batch: () => Response | Promise<Response> = () => samples()) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "epqs.nationalmap.gov") return epqs();
    expect(url.origin + url.pathname).toBe(ELEVATION_BATCH_URL);
    expect(JSON.parse(url.searchParams.get("geometry")!)).toEqual({ points: [location.centroid], spatialReference: { wkid: 4326 } });
    return batch();
  });
}
beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded county-centroid elevation fallback", () => {
  it("retains a valid EPQS value, including measured sea level, without extra requests", async () => {
    const fetchImpl = transport(() => Response.json({ value: 0 }));
    const result = await fetchEpqsSource(location, { now, fetchImpl });
    expect(result).toMatchObject({ status: "online", sourceTimeBasis: "retrieval", rawPayload: { elevationMeters: 0, sampleProvider: "epqs" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([null, "", "NoData", -1000000, true, {}, undefined])("does not coerce unusable EPQS elevation %s to zero", async value => {
    const fetchImpl = transport(() => Response.json({ value }));
    const result = await fetchEpqsSource(location, { now, fetchImpl });
    expect(result).toMatchObject({ sourceKey: "usgs-epqs", sourceName: "USGS 3DEP Elevation Samples",
      sourceUrl: ELEVATION_BATCH_URL, status: "online", sourceTimeBasis: "retrieval",
      rawPayload: { elevationMeters: 321.2, sampleProvider: "3dep" } });
    expect(result.derivedSignals).not.toHaveProperty("slopeTerrain");
    expect(result.detail).toContain("not an asset slope measurement");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses real fallback provenance after provider failure without leaking its diagnostics", async () => {
    const fetchImpl = transport(() => { throw new Error("private provider diagnostic"); });
    const result = await fetchEpqsSource(location, { now, fetchImpl });
    expect(result.status).toBe("online");
    expect(result.sourceUrl).toBe(ELEVATION_BATCH_URL);
    expect(JSON.stringify(result)).not.toContain("private provider diagnostic");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("recovers from the short EPQS deadline with one validated 3DEP request", async () => {
    vi.useFakeTimers();
    const fetchImpl = transport(() => new Promise<Response>(() => {}));
    const pending = fetchEpqsSource(location, { now, fetchImpl });
    await vi.advanceTimersByTimeAsync(2501);
    await expect(pending).resolves.toMatchObject({ status: "online", sourceUrl: ELEVATION_BATCH_URL });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps explicit NoData missing when neither endpoint supplies a usable sample", async () => {
    const result = await fetchEpqsSource(location, { now, fetchImpl: transport(() => Response.json({ value: "NoData" }), () => samples("NoData")) });
    expect(result).toMatchObject({ status: "delayed", coverageStatus: "not_available", stale: true });
    expect(result.rawPayload.elevationMeters).toBeUndefined();
    expect(result.derivedSignals).not.toHaveProperty("slopeTerrain");
  });

  it("bounds two hanging providers rather than keeping the county step waiting", async () => {
    vi.useFakeTimers();
    const fetchImpl = transport(() => new Promise<Response>(() => {}), () => new Promise<Response>(() => {}));
    const pending = fetchEpqsSource(location, { now, fetchImpl });
    await vi.advanceTimersByTimeAsync(17_501);
    await expect(pending).resolves.toMatchObject({ status: "delayed", coverageStatus: "not_available" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a fallback sample attributed to the wrong point", async () => {
    await expect(fetchEpqsSource(location, { now, fetchImpl: transport(() => Response.json({ value: null }), () => samples(321, [-120, 35])) }))
      .rejects.toMatchObject({ code: "elevation_invalid" });
  });

  it("propagates root cancellation instead of dispatching another provider request", async () => {
    const controller = new AbortController();
    const fetchImpl = transport(() => { controller.abort(); return Response.json({ value: 321 }); });
    await expect(withRefreshOperation("refresh", () => fetchEpqsSource(location, { now, fetchImpl }), controller.signal))
      .rejects.toMatchObject({ code: "refresh_canceled" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
