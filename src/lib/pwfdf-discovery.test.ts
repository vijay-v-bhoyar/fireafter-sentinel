import { describe, expect, it, vi } from "vitest";
import { fetchPwfdfSource } from "./live-sources";
import { selectPwfdfAssessment } from "./pwfdf";
import type { Incident, LocationCandidate } from "./types";

const now = new Date("2026-09-14T06:00:00Z");
const date = Date.parse("2026-09-12T00:00:00Z");
const location: LocationCandidate = { id: "county-test", county: "Test County", state: "CA", label: "Test County, CA", centroid: [-119.3, 34.5], bbox: [-119.5, 34.3, -119.1, 34.7], fips: "06111", fireWeatherZone: "CAZ354", population: 0, wildfireContext: "Test-only assessment discovery" };
const incident = { id: "discovery-test", selectedFire: { name: "Canyon Fire", sourceKey: "wfigs", sourceFeatureId: "perimeter-test", coverageStatus: "available" } } as Incident;
function feature(id: number, name = "Other", fireId = `other-${id}`, assessmentDate = date) {
  return { attributes: { OBJECTID: id, fire: name, Fire_ID: fireId, assessment_date: assessmentDate, Rainfall: "published design storm" }, geometry: { x: -119.3, y: 34.5 } };
}
const json = (value: unknown) => new Response(JSON.stringify(value));
function provider(features: ReturnType<typeof feature>[], mode = "healthy") {
  let idReads = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/0/query")) {
      if (mode === "provider_error") return json({ error: { message: "PRIVATE_PWFDF_DIAGNOSTIC", code: 500 } });
      if (url.searchParams.get("returnIdsOnly") === "true") {
        idReads++;
        return json({ objectIdFieldName: "OBJECTID", objectIds: mode === "changed" && idReads === 2 ? [999] : features.map(f => f.attributes.OBJECTID),
          ...(mode === "truncated_ids" ? { exceededTransferLimit: true } : {}) });
      }
      const ids = (url.searchParams.get("objectIds") ?? "").split(",").map(Number);
      const rows = features.filter(f => ids.includes(f.attributes.OBJECTID));
      return json({ features: mode === "missing" ? rows.slice(1) : rows,
        ...(mode === "truncated_page" ? { exceededTransferLimit: true } : {}) });
    }
    expect(url.pathname).toMatch(/\/4\/query$/);
    return json({ features: [{ attributes: { OBJECTID: 7, fire_id: "canyon-id", assessment_date: date,
      BP_Legend: "40-60%", BV_Legend: "1,000-10,000", BCH_Legend: "Moderate" },
      geometry: { rings: [[[-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.6], [-119.4, 34.6], [-119.4, 34.4]]] } }] });
  });
}

describe("FA08 complete assessment discovery and ambiguity", () => {
  it("rejects a future assessment before requesting basin evidence", async () => {
    const fetchImpl = provider([feature(1, "Canyon", "canyon-id", now.getTime() + 1)]);
    const result = await fetchPwfdfSource(location, incident, { fetchImpl, now });
    expect(result.coverageStatus).toBe("not_available");
    expect(result.rawPayload.failureCode).toBe("pwfdf_time_invalid");
    expect(result.rawPayload).not.toHaveProperty("basins");
    expect(fetchImpl.mock.calls.every(([input]) => String(input).includes("/0/query"))).toBe(true);
  });

  it("rejects a future basin publication without returning a healthy subset", async () => {
    const base = provider([feature(1, "Canyon", "canyon-id")]);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await base(input, init);
      if (!String(input).includes("/4/query")) return response;
      const data = await response.json();
      data.features.push({ ...data.features[0], attributes: { ...data.features[0].attributes,
        OBJECTID: 8, assessment_date: now.getTime() + 1 } });
      return json(data);
    });
    const result = await fetchPwfdfSource(location, incident, { fetchImpl, now });
    expect(result.coverageStatus).toBe("not_available");
    expect(result.rawPayload.failureCode).toBe("pwfdf_time_invalid");
    expect(result.rawPayload).not.toHaveProperty("basins");
  });

  it("retains actual provider publication provenance at the exact clock boundary", async () => {
    const result = await fetchPwfdfSource(location, incident, {
      fetchImpl: provider([feature(1, "Canyon", "canyon-id", now.getTime())]), now,
    });
    expect(result).toMatchObject({ coverageStatus: "available", sourceTimeBasis: "provider",
      sourceUpdatedAt: now.toISOString(), fetchedAt: now.toISOString(), stale: false });
  });

  it.each([undefined, null, "invalid", false])("does not replace invalid basin publication %s with its assessment date", async assessmentDate => {
    const base = provider([feature(1, "Canyon", "canyon-id")]);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await base(input, init);
      if (!String(input).includes("/4/query")) return response;
      const data = await response.json();
      data.features[0].attributes.assessment_date = assessmentDate;
      return json(data);
    });
    const result = await fetchPwfdfSource(location, incident, { fetchImpl, now });
    expect(result.coverageStatus).toBe("not_available");
    expect(result.rawPayload.failureCode).toBe("pwfdf_time_invalid");
    expect(result.rawPayload).not.toHaveProperty("basins");
  });

  it.each(["assessment", "basin"])("rejects array-coerced %s publication dates", async kind => {
    const base = provider([feature(1, "Canyon", "canyon-id")]);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await base(input, init);
      const data = await response.json();
      if (data.features && String(input).includes(kind === "assessment" ? "/0/query" : "/4/query")) {
        data.features[0].attributes.assessment_date = [new Date(date).toISOString()];
      }
      return json(data);
    });
    const result = await fetchPwfdfSource(location, incident, { fetchImpl, now });
    expect(result.coverageStatus).toBe("not_available");
    expect(result.rawPayload).not.toHaveProperty("basins");
  });

  it("rejects invalid provider topology with safe actionable diagnostics", async () => {
    const base = provider([feature(1, "Canyon", "canyon-id")]);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await base(input, init);
      if (!String(input).includes("/4/query")) return response;
      const data = await response.json();
      data.features[0].geometry.rings = [[[0, 0], [4, 4], [0, 4], [4, 0], [0, 0]]];
      return json(data);
    });
    const result = await fetchPwfdfSource(location, incident, { fetchImpl, now });
    expect(result.coverageStatus).toBe("not_available");
    expect(result.rawPayload.failureCode).toBe("pwfdf_geometry_invalid");
    expect(result.rawPayload).not.toHaveProperty("basins");
    expect(JSON.stringify(result)).toMatch(/GIS reviewer/);
  });

  it("finds the selected candidate after the former 100-record window and persists completeness", async () => {
    const features = Array.from({ length: 401 }, (_, i) => feature(i + 1));
    features[400] = feature(401, "Canyon", "canyon-id");
    const fetchImpl = provider(features);
    const result = await fetchPwfdfSource(location, incident, { fetchImpl, now });
    expect(result.coverageStatus).toBe("available");
    expect(result.rawPayload.assessmentDiscovery).toMatchObject({ complete: true, expectedCount: 401, receivedCount: 401, requests: 5 });
    expect(result.rawPayload.assessment).toMatchObject({ fireId: "canyon-id" });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(result.warnings?.join(" ")).toMatch(/not.*verified.*identity/i);
  });

  it.each(["truncated_ids", "truncated_page", "missing", "changed", "provider_error"])("rejects %s before querying basins without exposing provider diagnostics", async mode => {
    const fetchImpl = provider([feature(1, "Canyon", "canyon-id")], mode);
    const result = await fetchPwfdfSource(location, incident, { fetchImpl, now });
    expect(result.coverageStatus).toBe("not_available");
    expect(result.rawPayload.failureCode).toMatch(/^pwfdf_/);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PWFDF_DIAGNOSTIC");
    expect(fetchImpl.mock.calls.every(([input]) => String(input).includes("/0/query"))).toBe(true);
  });

  it("rejects two different same-name Fire_IDs instead of choosing the newest", () => {
    expect(() => selectPwfdfAssessment({ features: [feature(1, "Canyon", "one", date), feature(2, "Canyon", "two", date + 1000)] }, "Canyon Fire"))
      .toThrow(/ambiguous/i);
  });
  it("rejects conflicting equal-time records for one Fire_ID", () => {
    const first = feature(1, "Canyon", "canyon-id");
    const second = feature(2, "Canyon", "canyon-id");
    second.attributes.Rainfall = "different scenario";
    expect(() => selectPwfdfAssessment({ features: [first, second] }, "Canyon Fire")).toThrow(/ambiguous/i);
  });
  it("rejects a truncated locations response at the selection boundary", () => {
    expect(() => selectPwfdfAssessment({ exceededTransferLimit: true, features: [feature(1, "Canyon", "canyon-id")] }, "Canyon Fire"))
      .toThrow(/incomplete|truncated/i);
  });
  it("rejects malformed matching metadata rather than discarding it", () => {
    expect(() => selectPwfdfAssessment({ features: [feature(1, "Canyon", "canyon-id", NaN)] }, "Canyon Fire"))
      .toThrow(/invalid/i);
  });
  it("retains latest revision for one unambiguous ID and tolerates identical duplicate metadata", () => {
    const current = feature(2, "Canyon", "canyon-id");
    expect(selectPwfdfAssessment({ features: [feature(1, "Canyon", "canyon-id", date - 1000), current, { ...current }] }, "Canyon Fire"))
      .toMatchObject({ fireId: "canyon-id", assessmentDate: new Date(date).toISOString() });
  });
});
