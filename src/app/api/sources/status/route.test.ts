import { describe, expect, it, vi } from "vitest";
import type { Incident } from "@/lib/types";

const getDashboardBundleMock = vi.fn();

vi.mock("@/lib/fireafter-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fireafter-data")>(
    "../../../../lib/fireafter-data",
  );
  return {
    ...actual,
    getDashboardBundle: getDashboardBundleMock,
  };
});

vi.mock("@/lib/source-coverage", async () => {
  return import("../../../../lib/source-coverage");
});

describe("GET /api/sources/status", () => {
  it("returns a stable error without exposing bundle diagnostics", async () => {
    getDashboardBundleMock.mockRejectedValue(
      new Error("private source persistence details"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/sources/status?incidentId=incident-ventura"),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Source status unavailable" });
    expect(JSON.stringify(body)).not.toContain("private source persistence details");
    expect(consoleError).toHaveBeenCalledWith(
      "[fireafter] source status unavailable",
      "private source persistence details",
    );
    consoleError.mockRestore();
  });

  it("returns source snapshots plus the full planned coverage matrix", async () => {
    getDashboardBundleMock.mockResolvedValue({
      incident: incident(),
      locations: [],
      assets: [],
      sourceSnapshots: [
        {
          id: "source-nws",
          incidentId: "incident-ventura",
          sourceKey: "nws",
          sourceName: "NWS Forecast Grid and Active Alerts",
          fetchedAt: "2026-06-28T14:00:00.000Z",
          sourceUpdatedAt: "2026-06-28T14:00:00.000Z",
          sourceTimeBasis: "provider",
          validUntil: "2026-06-30T14:00:00.000Z",
          freshness: { state: "current", evaluatedAt: "2026-06-28T14:01:00.000Z", expiresAt: "2026-06-28T14:30:00.000Z", maxAgeMinutes: 30 },
          status: "online",
          stale: false,
          freshnessLabel: "Just now",
          detail: "NWS forecast and alerts loaded.",
          coverageStatus: "available",
          warnings: [],
          rawPayload: {
            featureCount: 1,
            features: [{ type: "Feature", geometry: { type: "LineString" } }],
          },
          derivedSignals: {},
        },
        {
          id: "source-pwfdf",
          incidentId: "incident-ventura",
          sourceKey: "usgs-pwfdf",
          sourceName: "USGS PWFDF Assessment",
          fetchedAt: "2026-06-28T14:00:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          status: "online",
          stale: false,
          freshnessLabel: "Yesterday",
          detail: "Loaded validated basin polygons.",
          coverageStatus: "available",
          warnings: [],
          rawPayload: {
            basinCount: 2,
            basins: [{ id: "basin-1" }, { id: "basin-2" }],
          },
          derivedSignals: {},
        },
      ],
      recommendations: [],
      actions: [],
      auditEvents: [],
      currentUser: null,
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/sources/status?incidentId=incident-ventura"),
    );
    const body = await response.json();

    expect(body.sources).toHaveLength(2);
    expect(body.sources[0]).toMatchObject({
      sourceTimeBasis: "provider", validUntil: "2026-06-30T14:00:00.000Z",
      freshness: { state: "current", expiresAt: "2026-06-28T14:30:00.000Z" },
    });
    expect(body.sources[0].rawPayload).toMatchObject({
      featureCount: 1,
      compacted: true,
    });
    expect(body.sources[0].rawPayload.features).toBeUndefined();
    expect(body.coverageMatrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "Weather",
          item: "NOAA/NWS rainfall forecasts, alerts, and warnings",
          status: "Live",
          sourceKeys: ["nws"],
        }),
        expect.objectContaining({
          category: "Local Agency Data",
          status: "Upload Required",
        }),
        expect.objectContaining({
          category: "Post-Wildfire Hazard",
          item: "USGS PWFDF combined-hazard basin polygons",
          status: "Live",
          sourceKeys: ["usgs-pwfdf"],
          evidence: "USGS PWFDF Assessment: 2 basin polygons",
        }),
      ]),
    );
  });
});

function incident(): Incident {
  return {
    id: "incident-ventura",
    locationId: "ventura-ca",
    county: "Ventura County",
    state: "CA",
    title: "Ventura County Storm Watch",
    code: "CA-FA-06111-001",
    status: "Storm Watch",
    stormWindow: "Next 48-72 hrs",
    rainfallForecast: "0.75 in forecast total rainfall",
    lastRefresh: "10:24 AM PDT",
    dataFreshness: "High",
    activeAlerts: 1,
    selectedFire: {
      name: "Canyon Fire",
      acres: 1200,
      perimeterUpdated: "Jun 28, 2026 10:00 AM PDT",
      source: "NIFC WFIGS",
      sourceKey: "wfigs",
      coverageStatus: "available",
    },
    coverageStatus: "available",
  };
}
