import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNwsObservationsSource } from "./live-sources";
import { withRefreshOperation } from "./refresh-operation";
import type { LocationCandidate } from "./types";

const now = new Date("2026-10-08T06:00:00Z");
const location = { id: "monterey-county-ca", centroid: [-121.3067, 36.2395] } as LocationCandidate;
const stationList = "https://api.weather.gov/gridpoints/MTR/110,30/stations";
const observation = (timestamp: unknown = "2026-10-08T05:45:00Z", extra = {}) => ({ properties: {
  timestamp, textDescription: "Cloudy", temperature: { value: 22.22, unitCode: "wmoUnit:degC" },
  precipitationLastHour: { value: null, unitCode: "wmoUnit:mm" }, ...extra,
} });
function transport(responses: Record<string, () => Response | Promise<Response>>, ids = ["CI114", "ASRC1", "FHLC1", "FOURTH"]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/points/")) return Response.json({ properties: { observationStations: stationList } });
    if (url === stationList) return Response.json({ features: ids.map(stationIdentifier => ({ properties: { stationIdentifier, name: stationIdentifier } })) });
    const id = new URL(url).pathname.split("/")[2];
    const response = responses[id];
    if (!response) return new Response(null, { status: 404 });
    if (init?.signal?.aborted) throw new Error("aborted");
    return response();
  });
}
beforeEach(() => { vi.stubEnv("FIREAFTER_NWS_USER_AGENT", "FireAfter/test (https://fireafter-app.vercel.app)"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("bounded NWS observation station fallback", () => {
  it("uses the next official station after the first returns 404, without retrying the missing station", async () => {
    const fetchImpl = transport({ ASRC1: () => Response.json(observation()) });
    const result = await fetchNwsObservationsSource(location, { now, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ status: "online", stale: false, sourceTimeBasis: "provider",
      sourceUpdatedAt: "2026-10-08T05:45:00Z", validUntil: "2026-10-08T07:45:00.000Z",
      sourceUrl: "https://api.weather.gov/stations/ASRC1/observations/latest",
      rawPayload: { stationId: "ASRC1", stationCandidatesChecked: 2, temperatureC: 22.22 } });
    expect(result.rawPayload.precipitationLastHourMm).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("alternative listed station");
    expect(result.derivedSignals.limitations?.join(" ")).toContain("not a county-wide");
  });

  it.each([undefined, null, "not-a-date", "2026-10-08T06:01:00Z"])("never substitutes retrieval time for invalid provider time: %s", async timestamp => {
    const fetchImpl = transport({ CI114: () => Response.json(observation(timestamp, { timestamp })) }, ["CI114"]);
    const result = await fetchNwsObservationsSource(location, { now, fetchImpl });
    expect(result).toMatchObject({ status: "delayed", stale: true, coverageStatus: "not_available",
      sourceUpdatedAt: "", sourceTimeBasis: "unknown" });
    expect(result.derivedSignals.reasonCodes).not.toContain("Observed Rainfall");
  });

  it("prefers a usable current observation over a stale first station", async () => {
    const fetchImpl = transport({ CI114: () => Response.json(observation("2026-10-08T01:00:00Z")),
      ASRC1: () => Response.json(observation()) });
    expect(await fetchNwsObservationsSource(location, { now, fetchImpl })).toMatchObject({
      status: "online", rawPayload: { stationId: "ASRC1" },
    });
  });

  it("retains the newest stale observation as limited evidence when none is current", async () => {
    const fetchImpl = transport({ CI114: () => Response.json(observation("2026-10-08T01:00:00Z")),
      ASRC1: () => Response.json(observation("2026-10-08T02:00:00Z")) });
    expect(await fetchNwsObservationsSource(location, { now, fetchImpl })).toMatchObject({
      status: "delayed", stale: true, sourceUpdatedAt: "2026-10-08T02:00:00Z", rawPayload: { stationId: "ASRC1" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("skips empty timestamp-only observations rather than reporting conditions loaded", async () => {
    const fetchImpl = transport({ CI114: () => Response.json({ properties: { timestamp: now.toISOString() } }),
      ASRC1: () => Response.json(observation()) });
    expect(await fetchNwsObservationsSource(location, { now, fetchImpl })).toMatchObject({ rawPayload: { stationId: "ASRC1" } });
  });

  it.each(["  ", null, 123])("shows measured values when NWS supplies an empty or invalid condition description: %s", async textDescription => {
    const fetchImpl = transport({ CI114: () => Response.json(observation(undefined, { textDescription })) });
    const result = await fetchNwsObservationsSource(location, { now, fetchImpl });
    expect(result.detail).toBe("CI114 latest observation: temperature 22.22 C.");
    expect(result.detail).not.toContain("precipitation");
  });

  it("bounds candidates to three unique valid IDs and never fetches injected URLs", async () => {
    const fetchImpl = transport({}, ["../../private", "CI114", "CI114", "ASRC1", "FHLC1", "FOURTH"]);
    const result = await fetchNwsObservationsSource(location, { now, fetchImpl });
    expect(result.rawPayload.stationCandidatesChecked).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).join(" ")).not.toMatch(/private|FOURTH/);
  });

  it("does not follow an external station-list URL supplied by upstream data", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ properties: { observationStations: "https://untrusted.invalid/stations" } }));
    const result = await fetchNwsObservationsSource(location, { now, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ coverageStatus: "not_available", sourceUpdatedAt: "" });
  });

  it.each([
    { temperature: { value: 295, unitCode: "wmoUnit:K" }, precipitationLastHour: { value: 1, unitCode: "wmoUnit:m" } },
    { temperature: { value: 22 }, precipitationLastHour: { value: 2 } },
    { temperature: { value: null, unitCode: "wmoUnit:degC" }, precipitationLastHour: { value: -1, unitCode: "wmoUnit:mm" } },
    { temperature: { value: "22", unitCode: "wmoUnit:degC" }, precipitationLastHour: { value: "0", unitCode: "wmoUnit:mm" } },
    { temperature: { value: false, unitCode: "wmoUnit:degC" }, precipitationLastHour: { value: false, unitCode: "wmoUnit:mm" } },
  ])("does not mislabel missing or unsupported units as Celsius or millimeters", async measurements => {
    const fetchImpl = transport({ CI114: () => Response.json(observation(undefined, measurements)) });
    const result = await fetchNwsObservationsSource(location, { now, fetchImpl });
    expect(result.rawPayload.temperatureC).toBeUndefined();
    expect(result.rawPayload.precipitationLastHourMm).toBeUndefined();
    expect(result.derivedSignals.reasonCodes).not.toContain("Observed Rainfall");
  });

  it("preserves measured zero rainfall and below-freezing temperatures", async () => {
    const fetchImpl = transport({ CI114: () => Response.json(observation(undefined, {
      temperature: { value: -4.5, unitCode: "wmoUnit:degC" },
      precipitationLastHour: { value: 0, unitCode: "wmoUnit:mm" },
    })) });
    const result = await fetchNwsObservationsSource(location, { now, fetchImpl });
    expect(result.rawPayload).toMatchObject({ temperatureC: -4.5, precipitationLastHourMm: 0 });
    expect(result.derivedSignals.reasonCodes).not.toContain("Observed Rainfall");
  });

  it("shares one deadline across failed and hanging station candidates", async () => {
    vi.useFakeTimers(); vi.stubEnv("FIREAFTER_SOURCE_TIMEOUT_MS", "250");
    const fetchImpl = transport({
      CI114: async () => { await new Promise(resolve => setTimeout(resolve, 150)); return new Response(null, { status: 404 }); },
      ASRC1: () => new Promise<Response>(() => {}),
    });
    const result = fetchNwsObservationsSource(location, { now, fetchImpl });
    await vi.advanceTimersByTimeAsync(251);
    await expect(result).resolves.toMatchObject({ status: "delayed", coverageStatus: "not_available" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn root cancellation into an apparently completed source result", async () => {
    const controller = new AbortController();
    const fetchImpl = transport({ CI114: () => { controller.abort(); return Response.json(observation()); } });
    await expect(withRefreshOperation("refresh", () => fetchNwsObservationsSource(location, { now, fetchImpl }), controller.signal))
      .rejects.toMatchObject({ code: "refresh_canceled" });
  });
});
