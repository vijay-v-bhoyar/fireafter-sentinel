import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPwfdfUnavailableResult,
  CountySearchUnavailableError,
  computeRainfallThreatFromGridData,
  fetch3dhpFlowlinesSource,
  fetchEpqsSource,
  enrichAssetsWithElevation,
  fetchFirmsSource,
  fetchPwfdfSource,
  fetchWfigsYearToDateSource,
  fetchWfigsSource,
  fetchMtbsBurnSeveritySource,
  fetchNbiBridgeSource,
  fetchNwsSource,
  fetchNwsObservationsSource,
  fetchTnmStructuresSource,
  fetchTigerRoadsSource,
  inferCrossingAssets,
  parseFirmsCsv,
  runLiveSourceRefresh,
  resolveWfigsFireCandidate,
  searchLocationsLive,
  selectWfigsFireContext,
} from "./live-sources";
import type { Asset, Incident } from "./types";
import { linkPwfdfHazardsToAssets } from "./pwfdf";
import { SOURCE_LINE_GEOMETRY_VERSION } from "./source-line-geometry";
import { INGESTION_SOURCES } from "./ingestion-contract";
import type { AdapterMap } from "./live-sources";

const locationContext = {
  id: "ventura-ca",
  county: "Ventura County",
  state: "CA",
  label: "Ventura County, CA",
  centroid: [-119.1391, 34.3705] as [number, number],
  bbox: [-119.6, 34.0, -118.6, 34.7] as [number, number, number, number],
  fips: "06111",
  fireWeatherZone: "CAZ354",
  population: 832605,
  wildfireContext: "Steep coastal ranges with post-fire drainage concerns.",
};

const incident: Incident = {
  id: "incident-ventura-ca",
  locationId: "ventura-ca",
  county: "Ventura County",
  state: "CA",
  title: "Ventura Fire",
  code: "CA-FA-06111-001",
  status: "Storm Watch",
  stormWindow: "Next 48-72 hrs",
  rainfallForecast: "1.50 - 2.75 in",
  lastRefresh: "10:24 AM PDT",
  dataFreshness: "High",
  activeAlerts: 1,
  selectedFire: {
    name: "Ventura Canyon Fire",
    acres: 7360,
    perimeterUpdated: "May 11, 2026 10:15 AM",
    source: "fixture",
  },
  locationContext,
};

const assets: Asset[] = [
  {
    id: "asset-ventura-crossing",
    incidentId: incident.id,
    name: "Pine Creek Road @ Canyon Creek",
    type: "Road Crossing",
    locationLabel: "Canyon Creek",
    coordinates: [-119.22, 34.45],
    geometry: { type: "Point", coordinates: [-119.22, 34.45] },
    source: "Inferred from public roads and hydrology",
    confidence: "Medium",
    localOrUploaded: false,
    origin: "inferred",
    sourceFeatureIds: ["road-1", "flowline-1"],
    coverageStatus: "partial",
    metrics: {
      slopeTerrain: 0.7,
      downstreamExposure: 0.8,
    },
  },
];

describe("live source adapter transforms", () => {
  beforeEach(() => {
    process.env.FIREAFTER_NWS_USER_AGENT = "FireAfter tests (ops@example.com)";
  });

  it("computes rainfall threat from NWS grid quantitative precipitation values", () => {
    const result = computeRainfallThreatFromGridData(
      {
        properties: {
          quantitativePrecipitation: {
            uom: "wmoUnit:mm",
            values: [
              {
                validTime: "2026-06-27T00:00:00+00:00/PT6H",
                value: 18,
              },
              {
                validTime: "2026-06-27T06:00:00+00:00/PT6H",
                value: 24,
              },
              { validTime: "2026-06-27T12:00:00Z/PT36H", value: 0 },
              {
                validTime: "2026-06-30T06:00:00+00:00/PT6H",
                value: 40,
              },
            ],
          },
        },
      },
      new Date("2026-06-27T00:00:00.000Z"),
    );

    expect(result.totalInches).toBeCloseTo(1.65, 2);
    expect(result.rainfallThreat).toBeCloseTo(0.66, 2);
    expect(result.label).toBe("1.65 in forecast total rainfall");
  });

  it("rejects malformed NWS precipitation entries instead of silently accepting a partial total", () => {
    const result = computeRainfallThreatFromGridData(
      {
        properties: {
          quantitativePrecipitation: {
            uom: "wmoUnit:mm",
            values: [
              null,
              { validTime: "2026-06-27T14:00:00Z/PT1H", value: "500" },
              { validTime: "2026-06-27T14:00:00Z/PT1H", value: 25.4 },
            ],
          },
        },
      },
      new Date("2026-06-27T14:24:00.000Z"),
    );

    expect(result.totalInches).toBeUndefined();
    expect(result.rainfallThreat).toBeUndefined();
    expect(result.warning).toContain("malformed");
  });

  it.each([
    { name: "empty", values: [] },
    { name: "null amount", values: [{ validTime: "2026-06-27T00:00:00Z/PT48H", value: null }] },
    { name: "negative amount", values: [{ validTime: "2026-06-27T00:00:00Z/PT48H", value: -1 }] },
    { name: "nonfinite amount", values: [{ validTime: "2026-06-27T00:00:00Z/PT48H", value: Infinity }] },
    { name: "invalid duration", values: [{ validTime: "2026-06-27T00:00:00Z/PT0H", value: 1 }] },
    { name: "truncated horizon", values: [{ validTime: "2026-06-27T00:00:00Z/PT6H", value: 0 }] },
    { name: "future-only", values: [{ validTime: "2026-06-30T00:00:00Z/PT48H", value: 0 }] },
    { name: "boundary accumulation", values: [{ validTime: "2026-06-26T23:00:00Z/PT50H", value: 50 }] },
    { name: "gap", values: [
      { validTime: "2026-06-27T00:00:00Z/PT6H", value: 0 },
      { validTime: "2026-06-27T07:00:00Z/PT41H", value: 0 },
    ] },
    { name: "overlap", values: [
      { validTime: "2026-06-27T00:00:00Z/PT8H", value: 1 },
      { validTime: "2026-06-27T06:00:00Z/PT42H", value: 1 },
    ] },
  ])("does not report dry weather or a scalar for $name rainfall data", ({ values }) => {
    const result = computeRainfallThreatFromGridData({
      properties: { quantitativePrecipitation: { uom: "wmoUnit:mm", values } },
    }, new Date("2026-06-27T00:00:00Z"));
    expect(result.rainfallThreat).toBeUndefined();
    expect(result.totalInches).toBeUndefined();
    expect(result.warning).toBeTruthy();
    expect(result.label).not.toContain("No measurable");
  });

  it.each([undefined, "wmoUnit:in", "mm"])("rejects missing or unsupported rainfall units %s", (uom) => {
    const result = computeRainfallThreatFromGridData({
      properties: { quantitativePrecipitation: { uom, values: [{ validTime: "2026-06-27T00:00:00Z/PT48H", value: 1 }] } },
    }, new Date("2026-06-27T00:00:00Z"));
    expect(result.rainfallThreat).toBeUndefined();
    expect(result.warning).toContain("units");
  });

  it("excludes expired and exactly future-boundary buckets without assuming proportional rainfall", () => {
    const result = computeRainfallThreatFromGridData({ properties: { quantitativePrecipitation: {
      uom: "wmoUnit:mm", values: [
        { validTime: "2026-06-26T00:00:00Z/PT24H", value: 999 },
        { validTime: "2026-06-27T00:00:00Z/PT48H", value: 25.4 },
        { validTime: "2026-06-29T00:00:00Z/PT24H", value: 999 },
      ],
    } } }, new Date("2026-06-27T00:00:00Z"));
    expect(result.totalInches).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("uses county/official forecast-zone alert identity, never statewide hazard keywords", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes("/points/")) return jsonResponse({ properties: {
        forecastGridData: "https://api.weather.gov/gridpoints/LOX/10,20",
        forecastZone: "https://api.weather.gov/zones/forecast/CAZ354",
      } });
      if (url.includes("/gridpoints/")) return jsonResponse({ properties: {
        updateTime: "2026-06-27T00:00:00Z",
        quantitativePrecipitation: { uom: "wmoUnit:mm", values: [{ validTime: "2026-06-27T00:00:00Z/PT48H", value: 0 }] },
      } });
      expect(new URL(url).searchParams.get("zone")).toBe("CAC111");
      expect(new URL(url).searchParams.has("area")).toBe(false);
      return jsonResponse({ features: [
        { properties: { event: "Flood Warning", headline: "Remote flood", geocode: { UGC: ["CAC001"], SAME: ["006001"] } } },
        { properties: { event: "Flood Watch", headline: "County alert", geocode: { UGC: ["CAC111"] } } },
        { properties: { event: "Wind Advisory", headline: "Zone alert", geocode: { UGC: ["CAZ354"] } } },
        { properties: { event: "Rain", headline: "Unscoped rain", areaDesc: "Ventura County" } },
      ] });
    });
    const result = await fetchNwsSource(locationContext, { fetchImpl: fetchImpl as unknown as typeof fetch, now: new Date("2026-06-27T00:00:00Z") });
    expect(result.derivedSignals.activeAlerts).toBe(2);
    expect(JSON.stringify(result.rawPayload.relevantAlerts)).not.toContain("Remote flood");
    expect(result.coverageStatus).toBe("partial");
    expect(result.warnings.join(" ")).toContain("geographic codes");
  });

  it("fails closed on a rejected grid even when the alert service succeeds", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (input.toString().includes("/points/")) return jsonResponse({ properties: { forecastGridData: "https://api.weather.gov/gridpoints/LOX/10,20" } });
      if (input.toString().includes("/gridpoints/")) return new Response("unavailable", { status: 503 });
      return jsonResponse({ features: [] });
    });
    const result = await fetchNwsSource(locationContext, { fetchImpl: fetchImpl as unknown as typeof fetch, now: new Date("2026-06-27T00:00:00Z") });
    expect(result.derivedSignals.rainfallThreat).toBeUndefined();
    expect(result.stale).toBe(true);
    expect(result.detail).not.toContain("No measurable");
  });

  it("never converts WFIGS fire size into burn severity", async () => {
    const result = await fetchWfigsSource(locationContext, incident, {
      now: new Date("2026-06-27T14:24:00Z"),
      fetchImpl: vi.fn(async () => jsonResponse({ features: [{ attributes: {
        IncidentName: "Ventura Canyon Fire", GISAcres: 100000, OBJECTID: "perimeter-1",
        DateCurrent: Date.parse("2026-06-27T14:00:00Z"),
      } }] })) as unknown as typeof fetch,
    });
    expect(result.derivedSignals.fireAcres).toBe(100000);
    expect(result.derivedSignals.burnSeverity).toBeUndefined();
  });

  it("parses FIRMS CSV rows and degrades when the map key is missing", async () => {
    const rows = parseFirmsCsv(
      "latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n34.4,-119.2,2026-06-27,0930,NOAA20,85,12.2",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      satellite: "NOAA20",
      confidence: "85",
    });

    const result = await fetchFirmsSource(locationContext, {
      fetchImpl: vi.fn(),
      firmsMapKey: "",
    });

    expect(result.status).toBe("delayed");
    expect(result.stale).toBe(true);
    expect(result.warnings).toContain("NASA_FIRMS_MAP_KEY is not configured.");
    expect(result.derivedSignals.fireHotspotCount).toBe(0);
  });

  it("does not call NWS with a placeholder or contactless User-Agent", async () => {
    delete process.env.FIREAFTER_NWS_USER_AGENT;

    await expect(
      fetchNwsSource(locationContext, {
        fetchImpl: vi.fn() as unknown as typeof fetch,
        now: new Date("2026-06-27T14:24:00.000Z"),
      }),
    ).rejects.toThrow("FIREAFTER_NWS_USER_AGENT");

    process.env.FIREAFTER_NWS_USER_AGENT =
      "FireAfter/0.1 (operations@fireafter.local)";
    await expect(
      fetchNwsSource(locationContext, {
        fetchImpl: vi.fn() as unknown as typeof fetch,
        now: new Date("2026-06-27T14:24:00.000Z"),
      }),
    ).rejects.toThrow("FIREAFTER_NWS_USER_AGENT");
  });

  it("uses a configurable FIRMS source and official area CSV endpoint", async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      void request;
      return new Response(
        "latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n34.4,-119.2,2026-06-27,0930,SNPP,85,12.2",
        { status: 200 },
      );
    });

    const result = await fetchFirmsSource(locationContext, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      firmsMapKey: "test-map-key",
      firmsSource: "MODIS_NRT",
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    const requestedUrl = String(fetchImpl.mock.calls[0][0]);
    expect(requestedUrl).toContain("/api/area/csv/test-map-key/MODIS_NRT/");
    expect(requestedUrl).toContain("-119.6,34,-118.6,34.7/3");
    expect(result.status).toBe("online");
    expect(result.derivedSignals.fireHotspotCount).toBe(1);
    expect(result.derivedSignals.burnSeverity).toBeUndefined();
    expect(result.sourceUrl).toBe("https://firms.modaps.eosdis.nasa.gov/api/area/");
    expect(JSON.stringify(result)).not.toContain("test-map-key");
  });

  it("does not echo a FIRMS credential from HTTP or thrown transport errors", async () => {
    for (const fetchImpl of [
      vi.fn(async () => new Response("unavailable", { status: 403 })),
      vi.fn(async () => { throw new Error("provider echoed synthetic-private-key"); }),
    ]) {
      await expect(fetchFirmsSource(locationContext, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        firmsMapKey: "synthetic-private-key",
      })).rejects.toThrow("NASA FIRMS request failed. Verify the server MAP_KEY and provider availability.");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("selects the most useful WFIGS fire perimeter from current features", () => {
    const selected = selectWfigsFireContext(
      [
        {
          attributes: {
            poly_IncidentName: "Older Small Fire",
            GISAcres: 50,
            DateCurrent: 1781900000000,
          },
        },
        {
          attributes: {
            IncidentName: "Canyon Fire",
            GISAcres: 15842,
            DateCurrent: 1782510000000,
          },
        },
      ],
      incident,
    );

    expect(selected).toMatchObject({
      name: "Canyon Fire",
      acres: 15842,
      source: "NIFC WFIGS Current Interagency Fire Perimeters",
    });
  });

  it("falls back to alternate WFIGS YTD service when the first endpoint returns ArcGIS errors", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes("WFIGS_Interagency_Perimeters_YearToDate")) {
        return jsonResponse({
          error: {
            code: 400,
            message: "Invalid URL",
          },
        });
      }

      return jsonResponse({
        features: [
          {
            attributes: {
              IncidentName: "Fallback Canyon Fire",
              GISAcres: 1240,
              DateCurrent: 1753000000000,
              OBJECTID: "fc-1",
            },
          },
        ],
      });
    });

    const result = await fetchWfigsYearToDateSource(locationContext, incident, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("online");
    expect(result.coverageStatus).toBe("available");
    expect(result.warnings).toEqual([]);
    const sourceUrl = result.sourceUrl ?? "";
    expect(
      sourceUrl.includes("WFIGS_Interagency_Perimeters_YearToDate") ||
        sourceUrl.includes("WFIGS_Interagency_Fire_Perimeters_to_Date"),
    ).toBe(true);
    expect(result.sourceName).toBe("NIFC WFIGS Year-to-Date Fire Perimeters");
    expect(result.rawPayload).toMatchObject({
      serviceName: "WFIGS_Interagency_Fire_Perimeters_to_Date",
    });
    expect(result.derivedSignals.fireCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKey: "wfigs-ytd",
          sourceFeatureId: "fc-1",
        }),
      ]),
    );
  });

  it("revalidates an exact current WFIGS candidate instead of trusting client labels", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        features: [
          {
            attributes: {
              IncidentName: "Validated Canyon Fire",
              GISAcres: 1400,
              DateCurrent: 1782510000000,
              OBJECTID: "fc-validated",
            },
          },
        ],
      }),
    );

    const selected = await resolveWfigsFireCandidate(
      locationContext,
      incident,
      { sourceKey: "wfigs", sourceFeatureId: "fc-validated" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(selected).toMatchObject({
      name: "Validated Canyon Fire",
      sourceKey: "wfigs",
      sourceFeatureId: "fc-validated",
    });
  });

  it("fails closed when a selected WFIGS candidate is no longer published", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ features: [] }));

    await expect(
      resolveWfigsFireCandidate(
        locationContext,
        incident,
        { sourceKey: "wfigs", sourceFeatureId: "fc-gone" },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow("no longer published");
  });

  it("treats a successful dry NWS forecast as fresh live data", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes("/points/")) {
        return jsonResponse({
          properties: {
            cwa: "LOX",
            gridId: "LOX",
            gridX: 10,
            gridY: 20,
            forecastGridData: "https://api.weather.gov/gridpoints/LOX/10,20",
          },
        });
      }
      if (url.includes("/gridpoints/")) {
        return jsonResponse({
          properties: {
            updateTime: "2026-06-27T14:00:00.000Z",
            quantitativePrecipitation: {
              uom: "wmoUnit:mm",
              values: [
                {
                  validTime: "2026-06-27T14:00:00+00:00/PT49H",
                  value: 0,
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ features: [] });
    });

    const result = await fetchNwsSource(locationContext, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.status).toBe("online");
    expect(result.stale).toBe(false);
    expect(result.detail).toContain("No measurable rainfall");
    expect(result.sourceUpdatedAt).toBe("2026-06-27T14:00:00.000Z");
    expect(result.fetchedAt).toBe("2026-06-27T14:24:00.000Z");
    expect(result.validUntil).toBe("2026-06-29T15:00:00.000Z");
  });

  it.each([undefined, "invalid", "2026-06-28T14:00:00.000Z"])("fails closed on an unverified NWS publication time: %s", async (updateTime) => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (input.toString().includes("/points/")) return jsonResponse({ properties: { forecastGridData: "https://api.weather.gov/gridpoints/LOX/10,20" } });
      if (input.toString().includes("/gridpoints/")) return jsonResponse({ properties: {
        updateTime, quantitativePrecipitation: { values: [{ validTime: "2026-06-27T14:00:00Z/PT48H", value: 0 }] },
      } });
      return jsonResponse({ features: [] });
    });
    const result = await fetchNwsSource(locationContext, { fetchImpl: fetchImpl as unknown as typeof fetch, now: new Date("2026-06-27T14:24:00Z") });
    expect(result.status).toBe("delayed");
    expect(result.stale).toBe(true);
    expect(result.warnings.join(" ")).toContain("publication time");
    expect(result.sourceUpdatedAt).not.toBe(result.fetchedAt);
  });

  it("loads NWS latest observations from the county observation station list", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes("/points/")) {
        return jsonResponse({
          properties: {
            observationStations: "https://api.weather.gov/gridpoints/LOX/10,20/stations",
          },
        });
      }
      if (url.includes("/stations") && !url.includes("/observations")) {
        return jsonResponse({
          features: [
            {
              properties: {
                stationIdentifier: "KVNY",
                name: "Van Nuys Airport",
              },
            },
          ],
        });
      }
      return jsonResponse({
        properties: {
          timestamp: "2026-06-27T14:00:00.000Z",
          textDescription: "Light Rain",
          temperature: { value: 21, unitCode: "wmoUnit:degC" },
          precipitationLastHour: { value: 2.54, unitCode: "wmoUnit:mm" },
        },
      });
    });

    const result = await fetchNwsObservationsSource(locationContext, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.sourceKey).toBe("nws-observations");
    expect(result.status).toBe("online");
    expect(result.coverageStatus).toBe("available");
    expect(result.rawPayload).toMatchObject({
      stationId: "KVNY",
      precipitationLastHourMm: 2.54,
    });
    expect(result.detail).toContain("Van Nuys Airport");
  });

  it("returns a visible stale limitation when PWFDF is not available", () => {
    const result = buildPwfdfUnavailableResult(locationContext, "No match");

    expect(result.status).toBe("delayed");
    expect(result.stale).toBe(true);
    expect(result.warnings[0]).toContain("No match");
    expect(result.derivedSignals.reasonCodes).toContain("PWFDF Not Available");
  });

  it("loads PWFDF basin hazards after complete location ID acquisition and recheck", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ objectIdFieldName: "OBJECTID", objectIds: [1] }))
      .mockResolvedValueOnce(jsonResponse({
        features: [{
          attributes: {
            OBJECTID: 1,
            fire: "Ventura Canyon",
            Fire_ID: "Ventura_Canyon_2026_v1",
            status: "Complete",
            Rainfall: "15-minute, 24 mm/h design storm",
            start_date: Date.parse("2026-06-18T00:00:00.000Z"),
            assessment_date: Date.parse("2026-06-20T00:00:00.000Z"),
            ScienceBaseURL: "https://www.sciencebase.gov/catalog/item/example",
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ objectIdFieldName: "OBJECTID", objectIds: [1] }))
      .mockResolvedValueOnce(jsonResponse({
        features: [{
          attributes: {
            OBJECTID: 7,
            BP_Legend: "40-60%",
            BV_Legend: "1,000-10,000",
            BCH_Legend: "Moderate",
            fire_id: "Ventura_Canyon_2026_v1",
            assessment_date: Date.parse("2026-06-20T00:00:00.000Z"),
            version: "1.0",
          },
          geometry: { rings: [[
            [-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.6],
            [-119.4, 34.6], [-119.4, 34.4],
          ]] },
        }],
      }));

    const result = await fetchPwfdfSource(locationContext, incident, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/MapServer/0/query");
    expect(String(fetchImpl.mock.calls[2][0])).toContain("returnIdsOnly=true");
    expect(String(fetchImpl.mock.calls[3][0])).toContain("/MapServer/4/query");
    expect(result).toMatchObject({
      status: "online",
      coverageStatus: "available",
      stale: false,
      rawPayload: {
        basinCount: 1,
        hazardCounts: { Moderate: 1 },
      },
    });
  });

  it("does not query basin data when PWFDF has no exact fire match", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => new URL(String(input)).searchParams.get("returnIdsOnly") === "true"
      ? jsonResponse({ objectIdFieldName: "OBJECTID", objectIds: [1] }) : jsonResponse({
      features: [{
        attributes: {
          OBJECTID: 1,
          fire: "Ventura",
          Fire_ID: "Ventura_v1",
          assessment_date: Date.parse("2026-06-20T00:00:00.000Z"),
        },
      }],
    }));

    const result = await fetchPwfdfSource(locationContext, incident, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.coverageStatus).toBe("not_available");
    expect(result.detail).toContain("No exact USGS PWFDF assessment match");
  });

  it("exposes EPQS elevation samples as a standalone terrain source snapshot", async () => {
    const result = await fetchEpqsSource(locationContext, {
      fetchImpl: vi.fn(async () => jsonResponse({ value: 1420 })) as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.sourceKey).toBe("usgs-epqs");
    expect(result.status).toBe("online");
    expect(result.coverageStatus).toBe("available");
    expect(result.rawPayload.elevationMeters).toBe(1420);
    expect(result.derivedSignals.reasonCodes).toContain("DEM Elevation Proxy");
  });

  it("reads the nested EPQS response shape without generic property traversal", async () => {
    const result = await fetchEpqsSource(locationContext, {
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          USGS_Elevation_Point_Query_Service: {
            Elevation_Query: { Elevation: 1384.6 },
          },
        }),
      ) as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.rawPayload.elevationMeters).toBe(1384.6);
  });

  it("retains real MTBS county boundary metadata without assigning a fire or inventing severity", async () => {
    const result = await fetchMtbsBurnSeveritySource(locationContext, {
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          features: [
            {
              attributes: {
                objectid: 17,
                fire_id: "CA-CANYON-2024",
                fire_name: "Canyon Fire",
                year: 2024,
                acres: 15842,
                LOW: 1200,
                MODERATE: 5200,
                HIGH: 3100,
              },
            },
          ],
        }),
      ) as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.sourceKey).toBe("mtbs-burn-severity");
    expect(result.status).toBe("delayed");
    expect(result.coverageStatus).toBe("not_available");
    expect(result.derivedSignals.burnSeverity).toBeUndefined();
    expect(result.sourceUpdatedAt).toBe("");
    expect(result.derivedSignals.reasonCodes).toContain("MTBS Burn Severity Not Available");
    expect(result.rawPayload).toMatchObject({
      attribution: "county-context-only", measurementStatus: "unavailable", inventoryComplete: false,
      sample: [expect.objectContaining({ name: "Canyon Fire", year: 2024, acres: 15842 })],
    });
    expect(result.rawPayload.selectedFire).toBeUndefined();
  });

  it("keeps MTBS honest when no published burn-severity product intersects the county", async () => {
    const result = await fetchMtbsBurnSeveritySource(locationContext, {
      fetchImpl: vi.fn(async () => jsonResponse({ features: [] })) as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.status).toBe("delayed");
    expect(result.stale).toBe(true);
    expect(result.coverageStatus).toBe("not_available");
    expect(result.warnings[0]).toContain("does not supply severity measurements");
  });

  it("turns FHWA/BTS NBI bridge points into source-backed bridge assets", async () => {
    const result = await fetchNbiBridgeSource(locationContext, {
      fetchImpl: vi.fn(async (request: string | URL | Request) =>
        arcgisInventoryResponse(request, {
          features: [
            {
              attributes: {
                OBJECTID: 42,
                STRUCTURE_NUMBER_008: "CA123",
                FACILITY_CARRIED_007: "SR-33",
                FEATURE_INTERSECTED_006: "Matilija Creek",
              },
              geometry: { x: -119.303, y: 34.481 },
            },
          ],
        }),
      ) as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.sourceKey).toBe("fhwa-nbi-bridges");
    expect(result.coverageStatus).toBe("available");
    expect(result.rawPayload.assets).toEqual([
      expect.objectContaining({
        type: "Bridge",
        name: "SR-33 bridge @ Matilija Creek",
        sourceFeatureId: "42",
      }),
    ]);
  });

  it("preserves names and addresses from real TNM lower-case query attributes", async () => {
    const result = await fetchTnmStructuresSource(locationContext, { fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("returnIdsOnly") === "true") return jsonResponse({ objectIdFieldName: "objectid", objectIds: [42] });
      return jsonResponse({ features: [{ attributes: { objectid: 42, name: "County Hospital", city: "Ventura", address: "1 Main Street" }, geometry: { x: -119.3, y: 34.3 } }] });
    } });
    expect(result.rawPayload.assets).toEqual(expect.arrayContaining([expect.objectContaining({ name: "County Hospital", locationLabel: "Ventura" })]));
  });

  it("turns TNM hospital and fire/EMS structures into critical-facility assets", async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = request.toString();
      if (url.includes("/49/query")) {
        return arcgisInventoryResponse(request, {
          features: [
            {
              attributes: { OBJECTID: 10, NAME: "Cedar Valley Medical Center" },
              geometry: { x: -119.12, y: 34.42 },
            },
          ],
        });
      }
      return arcgisInventoryResponse(request, {
        features: [
          {
            attributes: { OBJECTID: 11, NAME: "Cedar Valley Fire Station" },
            geometry: { x: -119.18, y: 34.44 },
          },
        ],
      });
    });

    const result = await fetchTnmStructuresSource(locationContext, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.sourceKey).toBe("tnm-structures");
    expect(result.rawPayload.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "Critical Facility",
          name: "Cedar Valley Medical Center",
          sourceFeatureId: "hospital-10",
        }),
        expect.objectContaining({
          type: "Critical Facility",
          name: "Cedar Valley Fire Station",
          sourceFeatureId: "fire-11",
        }),
      ]),
    );
  });

  it("parses current TIGERweb road fields into source-backed road features", async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request.toString());
      if (url.searchParams.has("objectIds")) expect(url.searchParams.get("outFields")).toBe("OBJECTID,OID,NAME,BASENAME,MTFCC,RTTYP");
      return arcgisInventoryResponse(request, arcgisLineResponse("road"));
    });

    const result = await fetchTigerRoadsSource(locationContext, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.status).toBe("online");
    expect(result.coverageStatus).toBe("available");
    expect(result.rawPayload.featureCount).toBe(3);
    expect(result.rawPayload.features).toEqual(Array(3).fill(
      expect.objectContaining({
        id: "3877",
        name: "US Hwy 189",
        class: "S1200",
        sourceKey: "tiger-roads",
      }),
    ));
  });

  it("parses current USGS 3DHP flowline fields into source-backed hydro features", async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request.toString());
      if (url.searchParams.has("objectIds")) expect(url.searchParams.get("outFields")).toBe(
        "OBJECTID,id3dhp,gnisidlabel,featuretypelabel,streamorder",
      );
      return arcgisInventoryResponse(request, arcgisLineResponse("hydro"));
    });

    const result = await fetch3dhpFlowlinesSource(locationContext, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(result.status).toBe("online");
    expect(result.coverageStatus).toBe("available");
    expect(result.rawPayload.featureCount).toBe(1);
    expect(result.rawPayload.features).toEqual([
      expect.objectContaining({
        id: "176018",
        name: "Waterbody Connector",
        class: "Channel Line",
        sourceKey: "3dhp-flowlines",
      }),
    ]);
  });

  it("preserves every multipart vertex instead of creating flattened or sampled segments", async () => {
    const paths = [
      Array.from({ length: 80 }, (_, index) => [-119.4 + index * 0.001, 34.4]),
      [[-119.2, 34.6], [-119.1, 34.6]],
    ];
    const result = await fetch3dhpFlowlinesSource(locationContext, {
      fetchImpl: vi.fn(async (request: string | URL | Request) => arcgisInventoryResponse(request, { features: [{
        attributes: { OBJECTID: 7 }, geometry: { paths },
      }] })) as unknown as typeof fetch,
    });
    expect(result.rawPayload.features).toEqual([expect.objectContaining({ paths })]);
    expect((result.rawPayload.features as Record<string, unknown>[])[0]).not.toHaveProperty("coordinates");
  });

  it("rejects malformed interior vertices rather than bridging across them", async () => {
    await expect(fetch3dhpFlowlinesSource(locationContext, {
      fetchImpl: vi.fn(async (request: string | URL | Request) => arcgisInventoryResponse(request, { features: [{
        attributes: { OBJECTID: 7 },
        geometry: { paths: [[[-119.4, 34.4], [null, 34.5], [-119.2, 34.6]]] },
      }] })) as unknown as typeof fetch,
    })).rejects.toThrow(/geometry/i);
  });

  it("treats ArcGIS JSON error payloads as source failures", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        error: {
          code: 400,
          message: "Failed to execute query.",
        },
      }),
    );

    await expect(
      fetch3dhpFlowlinesSource(locationContext, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("ArcGIS query failed");
  });

  it.each([
    ["roads", fetchTigerRoadsSource, 3, "features"],
    ["hydro", fetch3dhpFlowlinesSource, 1, "features"],
    ["bridges", fetchNbiBridgeSource, 1, "assets"],
    ["structures", fetchTnmStructuresSource, 2, "assets"],
  ] as const)("retains complete %s inventories beyond every former adapter cap", async (_name, adapter, layers, field) => {
    const features = Array.from({ length: 401 }, (_, index) => ({
      attributes: { OBJECTID: index + 1, NAME: `record-${index + 1}` },
      geometry: { x: -119.3, y: 34.5, paths: [[[-119.3, 34.4], [-119.2, 34.5]]] },
    }));
    const fetchImpl = vi.fn(async (request: string | URL | Request) => arcgisInventoryResponse(request, { features }));
    const result = await adapter(locationContext, { fetchImpl: fetchImpl as typeof fetch });
    expect(result.rawPayload.inventoryComplete).toBe(true);
    expect(result.rawPayload.featureCount).toBe(401 * layers);
    expect(result.rawPayload[field]).toHaveLength(401 * layers);
    expect(fetchImpl).toHaveBeenCalledTimes(5 * layers);
  });

  it("marks multi-layer inventories partial when one layer is truncated", async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      if (String(request).includes("/49/query")) return jsonResponse({ exceededTransferLimit: true });
      return arcgisInventoryResponse(request, { features: [{ attributes: { OBJECTID: 1, NAME: "Fire station" }, geometry: { x: -119.3, y: 34.5 } }] });
    });
    const result = await fetchTnmStructuresSource(locationContext, { fetchImpl: fetchImpl as typeof fetch });
    expect(result.coverageStatus).toBe("partial");
    expect(result.rawPayload.inventoryComplete).toBe(false);
    expect(result.rawPayload.assets).toHaveLength(1);
  });

  it("rejects an invalid point instead of silently dropping it from a complete inventory", async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => arcgisInventoryResponse(request,
      { features: [{ attributes: { OBJECTID: 1 }, geometry: { x: 900, y: 34 } }] }));
    await expect(fetchNbiBridgeSource(locationContext, { fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toMatchObject({ code: "invalid_geometry" });
  });
});

describe("searchLocationsLive county queries", () => {
  it("normalizes disconnected county islands to valid MultiPolygon geometry", async () => {
    const feature = tigerCountyFeature("Island County", "53", "029");
    feature.geometry.rings.push([[-119.9, 38.3], [-119.8, 38.3], [-119.8, 38.4], [-119.9, 38.4], [-119.9, 38.3]]);
    const fetchImpl = vi.fn(async () => jsonResponse({ features: [feature] }));
    const results = await searchLocationsLive("Island WA", fetchImpl as unknown as typeof fetch);
    expect(results[0].boundary?.type).toBe("MultiPolygon");
    expect(results[0].boundary?.coordinates).toHaveLength(2);
  });

  it("resolves slug ids containing two-letter name words by filtering on the trailing state code", async () => {
    let capturedWhere = "";
    const fetchImpl = vi.fn(async (input: string | URL) => {
      capturedWhere = new URL(input.toString()).searchParams.get("where") ?? "";
      return jsonResponse({
        features: [tigerCountyFeature("El Dorado County", "06", "017")],
      });
    });

    const results = await searchLocationsLive(
      "el-dorado-county-ca",
      fetchImpl as unknown as typeof fetch,
    );

    expect(capturedWhere).toContain("%el dorado%");
    expect(capturedWhere).toContain("STATE = '06'");
    expect(results[0]?.id).toBe("el-dorado-county-ca");
  });

  it("treats a comma-separated state qualifier as a state filter", async () => {
    let capturedWhere = "";
    const fetchImpl = vi.fn(async (input: string | URL) => {
      capturedWhere = new URL(input.toString()).searchParams.get("where") ?? "";
      return jsonResponse({
        features: [tigerCountyFeature("Lincoln County", "35", "027")],
      });
    });

    const results = await searchLocationsLive(
      "Lincoln, NM",
      fetchImpl as unknown as typeof fetch,
    );

    expect(capturedWhere).toContain("%Lincoln%");
    expect(capturedWhere).toContain("STATE = '35'");
    expect(results[0]?.id).toBe("lincoln-county-nm");
  });

  it("keeps trailing two-letter words that are not state codes in the county name", async () => {
    let capturedWhere = "";
    const fetchImpl = vi.fn(async (input: string | URL) => {
      capturedWhere = new URL(input.toString()).searchParams.get("where") ?? "";
      return jsonResponse({
        features: [tigerCountyFeature("Santa Fe County", "35", "049")],
      });
    });

    await searchLocationsLive("Santa Fe", fetchImpl as unknown as typeof fetch);

    expect(capturedWhere).toContain("%Santa Fe%");
    expect(capturedWhere).not.toContain("STATE =");
  });

  it("surfaces upstream failures as a safe degraded error instead of a healthy empty result", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error("provider detail must not be returned");
    });

    await expect(
      searchLocationsLive("Utah", fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(CountySearchUnavailableError);

    expect(warning).toHaveBeenCalledTimes(1);
    const event = JSON.parse(String(warning.mock.calls[0]?.[0]));
    expect(event).toMatchObject({
      event: "fireafter.live_source.failure",
      sourceKey: "tigerweb-county-search",
      operation: "county_search",
      errorType: "OutboundResponseError",
    });
    expect(event).not.toHaveProperty("message");
    warning.mockRestore();
  });
});

function tigerCountyFeature(name: string, stateFips: string, countyFips: string) {
  return {
    attributes: {
      NAME: name,
      BASENAME: name.replace(/ County$/, ""),
      STATE: stateFips,
      COUNTY: countyFips,
      GEOID: `${stateFips}${countyFips}`,
      OBJECTID: 1,
      CENTLAT: "38.7",
      CENTLON: "-120.5",
    },
    geometry: {
      rings: [
        [
          [-121.0, 38.3],
          [-121.0, 39.1],
          [-120.0, 39.1],
          [-120.0, 38.3],
          [-121.0, 38.3],
        ],
      ],
    },
  };
}

function arcgisInventoryResponse(request: string | URL | Request, payload: { features: Array<{ attributes: Record<string, unknown>; geometry: unknown }> }) {
  const url = new URL(String(request));
  if (url.searchParams.get("returnIdsOnly") === "true") {
    return jsonResponse({ objectIdFieldName: "OBJECTID", objectIds: payload.features.map((feature) => feature.attributes.OBJECTID) });
  }
  const ids = new Set((url.searchParams.get("objectIds") ?? "").split(",").map(Number));
  return jsonResponse({ features: payload.features.filter((feature) => ids.has(Number(feature.attributes.OBJECTID))) });
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sourceResult(
  sourceName: string,
  sourceKey: string,
  derivedSignals: Record<string, unknown> = {},
  rawPayload: Record<string, unknown> = {},
) {
  return {
    sourceName,
    sourceKey,
    status: "online" as const,
    fetchedAt: "2026-06-27T14:24:00.000Z",
    sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
    stale: false,
    freshnessLabel: "24 min ago",
    detail: `${sourceName} loaded.`,
    warnings: [],
    rawPayload,
    coverageStatus: "available" as const,
    derivedSignals,
  };
}

describe("live source refresh orchestration", () => {
  it("changes fire evidence without acquiring county inventory or renewing saved source dates", async () => {
    const countyFetch = vi.fn(async () => { throw new Error("County acquisition must not run"); });
    const saved = { ...sourceResult("Saved NWS", "nws", { rainfallThreat: 0.8 }),
      id: "saved-weather", incidentId: incident.id };
    const existing = { ...assets[0], metrics: { ...assets[0].metrics, pwfdfCombinedHazard: "High" as const },
      evidence: [{ sourceKey: "usgs-pwfdf", sourceName: "Old fire", sourceFeatureId: "old-basin", summary: "Old fire" }] };
    const adapters = Object.fromEntries(INGESTION_SOURCES.map(key => [key, countyFetch])) as Partial<AdapterMap>;
    adapters.wfigs = async () => sourceResult("WFIGS", "wfigs");
    adapters.wfigsYtd = async () => sourceResult("WFIGS YTD", "wfigs-ytd");
    adapters.pwfdf = async () => ({ ...sourceResult("PWFDF", "usgs-pwfdf"), coverageStatus: "not_available" });
    const result = await runLiveSourceRefresh({ incident, assets: [existing], adapters,
      fireContextSnapshots: [saved], now: new Date("2026-06-27T16:00:00Z"), fetchImpl: countyFetch });
    expect(countyFetch).not.toHaveBeenCalled();
    expect(result.assets.map(asset => asset.id)).toEqual([existing.id]);
    expect(result.assets[0].metrics).toMatchObject({ slopeTerrain: 0.7, downstreamExposure: 0.8 });
    expect(result.assets[0].metrics?.pwfdfCombinedHazard).toBeUndefined();
    expect(result.assets[0].evidence).toEqual([]);
    expect(result.sourceSnapshots.find(source => source.sourceKey === "nws")).toMatchObject({
      fetchedAt: saved.fetchedAt, sourceUpdatedAt: saved.sourceUpdatedAt, stale: true, status: "delayed",
    });
    expect(result.sourceSnapshots.find(source => source.sourceKey === "tiger-roads")?.fetchedAt).toBe("");
    expect(result.recommendations[0].riskLevel).toBe("Unknown");
    expect(existing.metrics.pwfdfCombinedHazard).toBe("High");
  });

  it("relinks the existing asset to the new assessment without resampling its terrain", async () => {
    const noFetch = vi.fn(async () => { throw new Error("Unexpected county fetch"); });
    const adapters = Object.fromEntries(INGESTION_SOURCES.map(key => [key, noFetch])) as Partial<AdapterMap>;
    adapters.wfigs = async () => sourceResult("WFIGS", "wfigs");
    adapters.wfigsYtd = async () => sourceResult("WFIGS YTD", "wfigs-ytd");
    adapters.pwfdf = async () => sourceResult("PWFDF", "usgs-pwfdf", {}, {
      analysisGeometryVersion: "2026-09-14-provider-resolution-v1",
      assessment: { fireName: "New fire", fireId: "new-fire", assessmentDate: "2026-06-20T00:00:00Z" },
      basins: [{ id: "new-basin", fireId: "new-fire", assessmentDate: "2026-06-20T00:00:00Z",
        probabilityClass: "20-40%", volumeClass: "<1,000", combinedHazard: "Moderate",
        geometry: { type: "Polygon", coordinates: [[[-119.3,34.4],[-119.2,34.4],[-119.2,34.5],[-119.3,34.5],[-119.3,34.4]]] } }],
    });
    const result = await runLiveSourceRefresh({ incident, assets, adapters, fireContextSnapshots: [],
      now: new Date("2026-06-27T14:30:00Z"), fetchImpl: noFetch });
    expect(noFetch).not.toHaveBeenCalled();
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].metrics).toMatchObject({ slopeTerrain: 0.7, pwfdfCombinedHazard: "Moderate" });
    expect(result.assets[0].evidence).toEqual([expect.objectContaining({ sourceFeatureId: "new-basin" })]);
  });

  it("scopes source inventory to the county before terrain and ranking", async () => {
    const scopedIncident: Incident = { ...incident, locationContext: { ...locationContext,
      boundary: { type: "Polygon", coordinates: [[
        [-119.3, 34.2], [-119.2, 34.2], [-119.2, 34.3], [-119.3, 34.3], [-119.3, 34.2],
      ]] },
    } };
    const rawAssets = [
      { name: "Inside bridge", type: "Bridge", sourceFeatureId: "inside", coordinates: [-119.25, 34.25] },
      { name: "Neighbor bridge", type: "Bridge", sourceFeatureId: "outside", coordinates: [-119.4, 34.4] },
    ];
    const adapters = Object.fromEntries(INGESTION_SOURCES.map(key => [key, async () => sourceResult(key, key)])) as Partial<AdapterMap>;
    adapters.bridges = async () => sourceResult("NBI", "fhwa-nbi-bridges", {}, { assets: rawAssets });
    const result = await runLiveSourceRefresh({ incident: scopedIncident, assets: [], adapters, skipElevation: true });
    expect(result.assets.map(asset => asset.name)).toEqual(["Inside bridge"]);
    expect(result.recommendations.map(item => item.assetName)).toEqual(["Inside bridge"]);
    expect(rawAssets).toHaveLength(2);
  });

  it("retains every crossing on one part pair with stable distinct identities", () => {
    const road = { id: "multi-road", sourceKey: "tiger-roads", sourceName: "Roads", name: "Road",
      paths: [[[-119.4, 34.45], [-119.2, 34.45]]] as [number, number][][] };
    const flow = { id: "multi-flow", sourceKey: "3dhp-flowlines", sourceName: "Hydro", name: "Creek",
      paths: [[[-119.39, 34.4], [-119.33, 34.5], [-119.27, 34.4], [-119.21, 34.5]]] as [number, number][][] };
    const result = inferCrossingAssets(incident, [road], [flow]);
    expect(result).toHaveLength(3);
    expect(new Set(result.map((asset) => asset.id)).size).toBe(3);
    expect(result.map((asset) => asset.coordinates[0]).sort((a, b) => a - b)).toEqual([-119.36, -119.3, -119.24]);
    expect(inferCrossingAssets(incident, [road], [{ ...flow, paths: [flow.paths[0].toReversed()] }])
      .map((asset) => asset.id).sort()).toEqual(result.map((asset) => asset.id).sort());
  });

  it("does not sample away crossings beyond either source limit without a priority basin", () => {
    const roads = Array.from({ length: 81 }, (_, index) => ({ id: `road-${index}`, sourceKey: "tiger-roads", sourceName: "Roads",
      paths: [[[-119.5, 34.1], [-119.4, 34.1]]] as [number, number][][] }));
    roads[80].paths = [[[-119.3, 34.4], [-119.3, 34.6]]];
    const flows = Array.from({ length: 101 }, (_, index) => ({ id: `flow-${index}`, sourceKey: "3dhp-flowlines", sourceName: "Hydro",
      paths: [[[-119.5, 34.2], [-119.4, 34.2]]] as [number, number][][] }));
    flows[100].paths = [[[-119.4, 34.5], [-119.2, 34.5]]];
    expect(inferCrossingAssets(incident, roads, flows)).toEqual([expect.objectContaining({ sourceFeatureIds: ["road-80", "flow-100"] })]);
  });

  it("deduplicates a shared vertex but fails closed rather than returning a budget-truncated inventory", () => {
    const road = { id: "road", sourceKey: "tiger-roads", sourceName: "Roads",
      paths: [[[-119.4, 34.5], [-119.3, 34.5], [-119.2, 34.5]]] as [number, number][][] };
    const flow = { id: "flow", sourceKey: "3dhp-flowlines", sourceName: "Hydro",
      paths: [[[-119.3, 34.4], [-119.3, 34.5], [-119.3, 34.6]]] as [number, number][][] };
    expect(inferCrossingAssets(incident, [road], [flow])).toHaveLength(1);
    expect(() => inferCrossingAssets(incident, [road], [flow], [], { maxWork: 1 })).toThrow("no partial inference");
    expect(() => inferCrossingAssets(incident, [road, { ...road, id: "other" }], [flow], [], { maxCandidates: 1 })).toThrow("candidate budget");
    expect(() => inferCrossingAssets(incident, [road], [flow], [], { maxWork: Infinity })).toThrow("Invalid crossing inference budget");
  });

  it("finds every sparse crossing without spending work on the full road-flowline product", () => {
    const roads = Array.from({ length: 1200 }, (_, index) => {
      const x = -120 + (index % 40) * 0.01;
      const y = 34 + Math.floor(index / 40) * 0.01;
      return { id: `road-${index}`, sourceKey: "tiger-roads", sourceName: "Roads",
        paths: [[[x - 0.001, y], [x + 0.001, y]]] as [number, number][][] };
    });
    const flows = roads.map((road, index) => {
      const [x, y] = road.paths[0][0];
      return { id: `flow-${index}`, sourceKey: "3dhp-flowlines", sourceName: "Hydro",
        paths: [[[x + 0.001, y - 0.001], [x + 0.001, y + 0.001]]] as [number, number][][] };
    });
    const original = structuredClone({ roads, flows });
    const result = inferCrossingAssets(incident, roads, flows, [], { maxWork: 200_000 });
    expect(result).toHaveLength(1200);
    expect(new Set(result.map(asset => asset.sourceFeatureIds?.join(":"))))
      .toEqual(new Set(roads.map((road, index) => `${road.id}:flow-${index}`)));
    expect(inferCrossingAssets(incident, roads.toReversed(), flows.toReversed(), [], { maxWork: 200_000 }))
      .toEqual(result);
    expect({ roads, flows }).toEqual(original);
  });

  it("matches exhaustive multipart pair results across dispersed and nearby geometry", () => {
    let seed = 719;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const lines = (sourceKey: string) => Array.from({ length: 25 }, (_, index) => ({
      id: `${sourceKey}-${index}`, sourceKey, sourceName: sourceKey,
      paths: Array.from({ length: 2 }, () => {
        const x = -119 + random() * 0.05;
        const y = 34 + random() * 0.05;
        return [[x, y], [x + random() * 0.01, y + random() * 0.01]] as [number, number][];
      }),
    }));
    const roads = lines("tiger-roads");
    const flows = lines("3dhp-flowlines");
    const expected = roads.flatMap(road => flows.flatMap(flow => inferCrossingAssets(incident, [road], [flow])))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(expected.length).toBeGreaterThan(0);
    const actual = inferCrossingAssets(incident, roads, flows);
    expect(actual.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(expected);
    expect(inferCrossingAssets(incident, roads.toReversed(), flows.toReversed())).toEqual(actual);
  });

  it("indexes a complete 60000-part inventory without repeated comparison sorting", () => {
    const flows = Array.from({ length: 60_000 }, (_, index) => {
      const x = -120 + (index % 300) * 0.01;
      const y = 34 + Math.floor(index / 300) * 0.01;
      return { id: `flow-${index}`, sourceKey: "3dhp-flowlines", sourceName: "Hydro",
        paths: [Array.from({ length: 14 }, (_, vertex) => [x, y + vertex * 0.000001] as [number, number])] };
    });
    const road = { id: "road", sourceKey: "tiger-roads", sourceName: "Roads",
      paths: [[[-120.00001, 34.000007], [-119.99999, 34.000007]]] as [number, number][][] };
    const result = inferCrossingAssets(incident, [road], flows, [], { maxWork: 1_200_000 });
    expect(result).toHaveLength(1);
    expect(result[0].sourceFeatureIds).toEqual(["road", "flow-0"]);
  });

  it("prunes distant segments of a long road without losing its final crossing", () => {
    const road = { id: "road", sourceKey: "tiger-roads", sourceName: "Roads",
      paths: [Array.from({ length: 10_001 }, (_, index) => [-119 + index * 0.00002, 34] as [number, number])] };
    const flow = { id: "flow", sourceKey: "3dhp-flowlines", sourceName: "Hydro",
      paths: [[[-118.80001, 33.999], [-118.80001, 34.001]]] as [number, number][][] };
    const result = inferCrossingAssets(incident, [road], [flow], [], { maxWork: 20_000 });
    expect(result).toHaveLength(1);
    expect(result[0].coordinates).toEqual([-118.80001, 34]);
  });

  it("does not clip long parts to center cells or lose collocated zero-width bounds", () => {
    const roads = [{ id: "road", sourceKey: "tiger-roads", sourceName: "Roads",
      paths: [[[-119, 34], [-119, 34.01]]] as [number, number][][] }];
    const flows = Array.from({ length: 20 }, (_, index) => ({ id: `flow-${index}`, sourceKey: "3dhp-flowlines", sourceName: "Hydro",
      paths: [[[index % 2 ? -119 : -120, 34 + index * 0.0002], [-119, 34.01]]] as [number, number][][] }));
    const exhaustive = flows.flatMap(flow => inferCrossingAssets(incident, roads, [flow])).sort((a, b) => a.id.localeCompare(b.id));
    expect(inferCrossingAssets(incident, roads, flows).toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(exhaustive);
    const zeroWidth = flows.map(flow => ({ ...flow, paths: flow.paths.map(path => path.map(([, y]) => [-119, y] as [number, number])) }));
    expect(inferCrossingAssets(incident, roads, zeroWidth)).toEqual(inferCrossingAssets(incident, roads, zeroWidth.toReversed()));
  });

  it("keeps empty inventories empty and retains the inference deadline", () => {
    const line = { id: "one", sourceKey: "tiger-roads", sourceName: "Roads",
      paths: [[[-119, 34], [-119.01, 34.01]]] as [number, number][][] };
    expect(inferCrossingAssets(incident, [], [line])).toEqual([]);
    expect(inferCrossingAssets(incident, [line], [])).toEqual([]);
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(10_001);
    try { expect(() => inferCrossingAssets(incident, [line], [line])).toThrow("no partial inference"); }
    finally { now.mockRestore(); }
  });

  it.each([34, 65, 80])("keeps nearby parallel lines at latitude %s without accepting lines beyond 220 m", latitude => {
    const road = { id: "road", sourceKey: "tiger-roads", sourceName: "Roads",
      paths: [[[-119, latitude], [-119, latitude + 0.001]]] as [number, number][][] };
    const flows = [215, 225, ...Array.from({ length: 30 }, (_, index) => 1000 + index * 500)].map((meters, index) => {
      const x = -119 + meters / (111_195 * Math.cos(latitude * Math.PI / 180));
      return { id: `flow-${index}`, sourceKey: "3dhp-flowlines", sourceName: "Hydro",
        paths: [[[x, latitude], [x, latitude + 0.001]]] as [number, number][][] };
    });
    const result = inferCrossingAssets(incident, [road], flows);
    expect(result).toHaveLength(1);
    expect(result[0].sourceFeatureIds).toEqual(["road", "flow-0"]);
    expect(result[0].metrics?.hydroDistanceMeters).toBeCloseTo(215, 0);
  });

  it.each(["headers", "body"])("degrades missing batch elevation and cancels concurrent stalled requests (%s)", async (phase) => {
    vi.useFakeTimers();
    try {
      let canceled = 0;
      const fetchImpl: typeof fetch = (_input, init) => phase === "body"
        ? Promise.resolve(new Response(new ReadableStream({ cancel() { canceled++; } })))
        : new Promise((_resolve, reject) => {
        const abort = () => { canceled++; reject(init?.signal?.reason); };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      const adapters = Object.fromEntries(["nws", "wfigs", "firms", "pwfdf", "roads", "hydro"].map((key) =>
        [key, async () => sourceResult(key, key)]));
      adapters.epqs = async () => sourceResult("USGS Elevation Point Query Service", "usgs-epqs", {
        dataFreshness: 0.86,
        confidenceMultiplier: 0.86,
        reasonCodes: ["DEM Elevation Proxy"],
        limitations: ["Centroid sample only."],
      });
      // Distinct points span multiple batches; a stalled response cancels all work.
      const refreshPromise = runLiveSourceRefresh({ incident, assets: Array.from({ length: 80 }, (_, index) =>
        ({ ...assets[0], id: `upload-${index}`, coordinates: [-119.3 + index / 100000, 34.45] as [number, number],
          geometry: { type: "Point" as const, coordinates: [-119.3 + index / 100000, 34.45] as [number, number] },
          localOrUploaded: true, confidence: "High", metrics: {} })), adapters, fetchImpl });
      await vi.advanceTimersByTimeAsync(15_001);
      const refresh = await refreshPromise;
      expect(refresh.assets).toHaveLength(80);
      expect(refresh.assets.every(asset => asset.metrics?.slopeTerrain === undefined)).toBe(true);
      expect(refresh.assets[0].confidence).toBe("Low");
      expect(refresh.assets[0].confidenceReason).toContain("USGS elevation slope proxy was unavailable");
      expect(refresh.assets.every(asset => asset.confidence !== "High")).toBe(true);
      expect(refresh.recommendations).toHaveLength(80);
      expect(refresh.recommendations.every(recommendation => recommendation.riskLevel === "Unknown")).toBe(true);
      expect(refresh.sourceSnapshots.find(source => source.sourceKey === "usgs-epqs")).toMatchObject({
        status: "delayed",
        stale: true,
        coverageStatus: "partial",
      });
      expect(refresh.sourceSnapshots.find(source => source.sourceKey === "usgs-epqs")?.detail).toContain("3DEP county-wide batch was unavailable");
      expect(canceled).toBeGreaterThanOrEqual(2);
    } finally { vi.useRealTimers(); }
  });

  it("discards every batch slope after aggregate elevation expiry but retains the full asset inventory", async () => {
    vi.useFakeTimers();
    try {
      let completed = 0;
      let canceled = 0;
      const fetchImpl: typeof fetch = (input, init) => new Promise((resolve, reject) => {
        const geometry = JSON.parse(new URL(String(input)).searchParams.get("geometry")!);
        const abort = () => { clearTimeout(timer); canceled++; reject(init?.signal?.reason); };
        const timer = setTimeout(() => {
          init?.signal?.removeEventListener("abort", abort);
          completed++;
          resolve(jsonResponse({ samples: geometry.points.map(([x, y]: number[], locationId: number) => ({
            locationId, location: { x, y, spatialReference: { wkid: 4326 } }, value: "1420",
          })) }));
        }, 10_000);
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      const names = ["nws", "observations", "wfigs", "wfigsYtd", "firms", "mtbs", "pwfdf", "roads", "hydro", "epqs", "structures"];
      const adapters = Object.fromEntries(names.map(name => [name, async () => sourceResult(name, name)]));
      const refreshPromise = runLiveSourceRefresh({ incident, assets: [], adapters: { ...adapters,
        bridges: async () => sourceResult("NBI", "fhwa-nbi-bridges", {}, { assets: Array.from({ length: 700 }, (_, index) => ({
          sourceFeatureId: String(index), name: `Bridge ${index}`, type: "Bridge", coordinates: [-119.3 + index / 100000, 34.45],
        })) }),
      }, fetchImpl });
      await vi.advanceTimersByTimeAsync(45_001);
      const refresh = await refreshPromise;
      expect(completed).toBe(16);
      expect(canceled).toBe(4);
      expect(refresh.assets).toHaveLength(700);
      expect(refresh.recommendations).toHaveLength(700);
      expect(refresh.assets.every(asset => asset.metrics?.slopeTerrain === undefined)).toBe(true);
      expect(refresh.recommendations.every(row => row.riskLevel === "Unknown")).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("still rejects malformed batch elevation evidence instead of accepting a partial inventory", async () => {
    const adapters = Object.fromEntries(["nws", "wfigs", "firms", "pwfdf", "roads", "hydro"].map((key) =>
      [key, async () => sourceResult(key, key)]));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const geometry = JSON.parse(new URL(String(input)).searchParams.get("geometry")!);
      return jsonResponse({ samples: geometry.points.map(([x, y]: number[], locationId: number) => ({
        locationId, location: { x, y, spatialReference: { wkid: 3857 } }, value: "1420",
      })) });
    });
    await expect(runLiveSourceRefresh({ incident, assets: Array.from({ length: 20 }, (_, index) =>
      ({ ...assets[0], id: `upload-${index}`, coordinates: [-119.3 + index / 100000, 34.45] as [number, number],
        geometry: { type: "Point" as const, coordinates: [-119.3 + index / 100000, 34.45] as [number, number] },
        localOrUploaded: true, metrics: {} })), adapters, fetchImpl }))
      .rejects.toMatchObject({ code: "elevation_invalid" });
  });

  it.each([true, false])("background terrain retry forwards validated recovery and preserves missing evidence on exhaustion (%s)", async recovers => {
    vi.useFakeTimers();
    try {
      const pendingAssets = Array.from({ length: 20 }, (_, index) => ({ ...assets[0], id: `source-${index}`,
        coordinates: [-119.3 + index / 100000, 34.45] as [number, number], metrics: {} }));
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("busy", { status: 503 }))
        .mockImplementation(async input => {
          if (!recovers) return new Response("still busy", { status: 503 });
          const geometry = JSON.parse(new URL(String(input)).searchParams.get("geometry")!);
          return jsonResponse({ samples: geometry.points.map(([x, y]: number[], locationId: number) => ({
            locationId, location: { x, y, spatialReference: { wkid: 4326 } }, value: String(100 + locationId),
          })) });
        });
      const pending = enrichAssetsWithElevation(pendingAssets, fetchImpl, { retryTransient: true });
      await vi.advanceTimersByTimeAsync(501);
      const result = await pending;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result.assets.map(asset => asset.id)).toEqual(pendingAssets.map(asset => asset.id));
      expect(result.batchElevationUnavailable).toBe(!recovers);
      expect(result.assets.every(asset => (asset.metrics?.slopeTerrain !== undefined) === recovers)).toBe(true);
      expect(result.assets.every(asset => Boolean(asset.evidence?.some(item => item.sourceName === "USGS 3DEP batch elevation")) === recovers)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not dispatch a terrain retry after the root operation expires", async () => {
    vi.useFakeTimers();
    vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "250");
    try {
      const { withRefreshOperation } = await import("./refresh-operation");
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("busy", { status: 503 }));
      const pending = withRefreshOperation("refresh", () => enrichAssetsWithElevation(
        Array.from({ length: 20 }, (_, index) => ({ ...assets[0], id: `source-${index}`, metrics: {} })),
        fetchImpl, { retryTransient: true },
      )).catch(error => error);
      await vi.advanceTimersByTimeAsync(501);
      expect(await pending).toMatchObject({ code: "refresh_deadline" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });

  it("preserves root refresh expiry instead of degrading it to an elevation outage", async () => {
    vi.useFakeTimers();
    vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "250");
    try {
      const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
        const abort = () => reject(init?.signal?.reason);
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      const adapters = Object.fromEntries(["nws", "wfigs", "firms", "pwfdf", "roads", "hydro"].map((key) =>
        [key, async () => sourceResult(key, key)]));
      const refresh = runLiveSourceRefresh({
        incident,
        assets: Array.from({ length: 20 }, (_, index) => ({
          ...assets[0],
          id: `upload-${index}`,
          coordinates: [-119.3 + index / 100000, 34.45] as [number, number],
          geometry: { type: "Point" as const, coordinates: [-119.3 + index / 100000, 34.45] as [number, number] },
          localOrUploaded: true,
          metrics: {},
        })),
        adapters,
        fetchImpl,
      }).then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(251);
      await expect(refresh).resolves.toMatchObject({ code: "refresh_deadline" });
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("keeps colocated distinct source records and evaluates elevation beyond the twelfth asset", async () => {
    const adapters = Object.fromEntries(["nws", "wfigs", "firms", "pwfdf", "roads", "hydro"].map((key) =>
      [key, async () => sourceResult(key, key)]));
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      const geometry = new URL(String(input)).searchParams.get("geometry");
      if (geometry) return jsonResponse({ samples: JSON.parse(geometry).points.map(([x, y]: number[], locationId: number) => ({
        locationId, location: { x, y, spatialReference: { wkid: 4326 } }, value: "1420",
      })) });
      return jsonResponse({ value: 1420 });
    });
    const refresh = await runLiveSourceRefresh({ incident, assets: [], adapters: { ...adapters,
      bridges: async () => sourceResult("NBI", "fhwa-nbi-bridges", {}, { assets: Array.from({ length: 40 }, (_, index) => ({
        sourceFeatureId: String(index), name: "Colocated bridge", type: "Bridge", coordinates: [-119.3, 34.45],
      })) }),
    }, fetchImpl: fetchImpl as typeof fetch });
    expect(refresh.assets).toHaveLength(40);
    expect(refresh.recommendations).toHaveLength(40);
    expect(refresh.assets.every((asset) => asset.metrics?.slopeTerrain === 0)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(refresh.assets.every(asset => asset.evidence?.some(e => e.sourceName === "USGS 3DEP batch elevation"))).toBe(true);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("keeps tied queue ranks unchanged when provider and previous row orders differ", async () => {
    const names = ["nws", "observations", "wfigs", "wfigsYtd", "firms", "mtbs", "pwfdf", "roads", "hydro", "epqs", "structures"];
    const adapters = Object.fromEntries(names.map(name => [name, async () => sourceResult(name, name)]));
    const records = ["Zulu", "Alpha", "Bravo"].map(name => ({
      sourceFeatureId: name, name: `${name} bridge`, type: "Bridge", coordinates: [-119.3, 34.45],
    }));
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 100 })) as unknown as typeof fetch;
    const first = await runLiveSourceRefresh({ incident, assets: [], adapters: { ...adapters,
      bridges: async () => sourceResult("NBI", "fhwa-nbi-bridges", {}, { assets: records }),
    }, fetchImpl });
    const second = await runLiveSourceRefresh({ incident: first.incident, assets: first.assets,
      previousRecommendations: [...first.recommendations].reverse(), adapters: { ...adapters,
        bridges: async () => sourceResult("NBI", "fhwa-nbi-bridges", {}, { assets: [...records].reverse() }),
      }, fetchImpl });
    expect(second.recommendations.map(row => row.assetName)).toEqual(["Alpha bridge", "Bravo bridge", "Zulu bridge"]);
    second.recommendations.forEach((row, index) => {
      expect(row.riskLevel).toBe("Unknown");
      expect(row.changedSinceLastRefresh).toMatch(/^At refresh:/);
      expect(row.changedSinceLastRefresh).toContain(`position unchanged (was #${index + 1}, now #${index + 1})`);
    });
  });

  it("retains missing weather for uploaded assets instead of assigning low hazard", async () => {
    const names = ["nws", "observations", "wfigs", "wfigsYtd", "firms", "mtbs", "pwfdf", "roads", "hydro", "epqs", "bridges", "structures"];
    const adapters = Object.fromEntries(names.map((name) => [name, async () => sourceResult(name, name)]));
    const upload: Asset = { ...assets[0], localOrUploaded: true, coordinates: incident.locationContext!.centroid, geometry: { type: "Point", coordinates: incident.locationContext!.centroid } };
    const refresh = await runLiveSourceRefresh({ incident, assets: [upload], adapters,
      fetchImpl: vi.fn(async () => jsonResponse({ value: 100 })) as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });
    expect(refresh.recommendations.length).toBeGreaterThan(0);
    const recommendation = refresh.recommendations.find((item) => item.assetId === upload.id)!;
    expect(recommendation.riskLevel).toBe("Unknown");
    expect(recommendation.confidenceLevel).toBe("Low");
    expect(recommendation.reasonCodes).toContain("Missing rainfall threat");
    expect(recommendation.scoreBreakdown.metricStatus?.rainfallThreat).toBe("not_available");
    expect(recommendation.recommendedAction).toContain("Unknown does not mean low hazard");
    expect(recommendation.scoreBreakdown.scoreBasis).toBe("review-only");
  });

  it.each(["retired", "offline"])("does not revive previously persisted source assets when current inventory is %s", async (mode) => {
    const names = ["nws", "observations", "wfigs", "wfigsYtd", "firms", "mtbs", "pwfdf", "roads", "hydro", "epqs", "bridges", "structures"];
    const adapters = Object.fromEntries(names.map((name) => [name, async () => sourceResult(name, name)]));
    const uploaded: Asset = { ...assets[0], id: "retained-upload", localOrUploaded: true, origin: "uploaded", coordinates: incident.locationContext!.centroid, geometry: { type: "Point", coordinates: incident.locationContext!.centroid } };
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 100 })) as unknown as typeof fetch;
    const first = await runLiveSourceRefresh({ incident, assets: [uploaded], adapters: { ...adapters,
      bridges: async () => sourceResult("NBI", "fhwa-nbi-bridges", {}, { assets: [
        { sourceFeatureId: "bridge-retired", name: "Retiring bridge", type: "Bridge", coordinates: [-119.3, 34.45] },
      ] }),
    }, fetchImpl });
    expect(first.assets).toHaveLength(2);
    const current = await runLiveSourceRefresh({ incident: first.incident, assets: first.assets,
      previousRecommendations: first.recommendations, adapters: { ...adapters, bridges: async () => {
        if (mode === "offline") throw new Error("Test-only unavailable bridge inventory");
        return sourceResult("NBI", "fhwa-nbi-bridges", {}, { assets: [] });
      } }, fetchImpl });
    expect(current.assets.map((asset) => asset.id)).toEqual([uploaded.id]);
    expect(current.recommendations.map((recommendation) => recommendation.assetId)).toEqual([uploaded.id]);
    expect(first.assets).toHaveLength(2);
  });

  it("passes the refreshed WFIGS fire identity to dependent PWFDF adapters", async () => {
    const staleFireIncident: Incident = {
      ...incident,
      selectedFire: {
        ...incident.selectedFire,
        name: "Selected WFIGS perimeter no longer available",
        sourceKey: "wfigs",
        sourceFeatureId: "old-perimeter",
        coverageStatus: "not_available",
      },
    };
    let observedPwfdfFire: string | undefined;

    const refresh = await runLiveSourceRefresh({
      incident: staleFireIncident,
      assets: [],
      now: new Date("2026-06-27T14:24:00.000Z"),
      adapters: {
        nws: async () => sourceResult("NWS Forecast Grid", "nws"),
        wfigs: async () =>
          sourceResult("NIFC WFIGS Current Interagency Fire Perimeters", "wfigs", {
            burnSeverity: 0.75,
            fireName: "Iron",
            fireAcres: 41842,
            fireSource: "NIFC WFIGS Current Interagency Fire Perimeters",
            fireSourceKey: "wfigs",
            fireSourceFeatureId: "new-perimeter",
            fireCoverageStatus: "available",
            reasonCodes: ["Current Fire Perimeter"],
          }),
        firms: async () => sourceResult("NASA FIRMS Active Fire", "firms"),
        pwfdf: async sourceIncident => {
          observedPwfdfFire = sourceIncident.selectedFire.name;
          return buildPwfdfUnavailableResult(locationContext, "No published assessment");
        },
        roads: async () => sourceResult("Census TIGERweb Transportation Roads", "tiger-roads"),
        hydro: async () => sourceResult("USGS 3DHP Flowlines", "3dhp-flowlines"),
      },
    });

    expect(observedPwfdfFire).toBe("Iron");
    expect(refresh.incident.selectedFire).toMatchObject({
      name: "Iron",
      sourceKey: "wfigs",
      sourceFeatureId: "new-perimeter",
      coverageStatus: "available",
    });
  });

  it("retains all assets and their recommendations including the PWFDF-linked candidate", async () => {
    const basin = {
      id: "pwfdf-Ventura_Canyon_v2-42",
      fireId: "Ventura_Canyon_v2",
      assessmentDate: "2026-06-20T00:00:00.000Z",
      probabilityClass: "60-80%",
      volumeClass: "10,000-100,000",
      combinedHazard: "High" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [[
          [-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.6],
          [-119.4, 34.6], [-119.4, 34.4],
        ]] as [number, number][][],
      },
    };
    const sourceAssets = Array.from({ length: 35 }, (_, index) => ({
      name: `Bridge ${index}`,
      type: "Bridge",
      locationLabel: "Outside PWFDF basin",
      coordinates: [-119.5, 34.1],
      source: "FHWA/BTS National Bridge Inventory",
      confidence: "High",
      sourceFeatureId: `bridge-${index}`,
      metrics: { slopeTerrain: 0.1, downstreamExposure: 0.1 },
    }));
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 1420 }));

    const refresh = await runLiveSourceRefresh({
      incident,
      assets: [],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      adapters: {
        nws: async () => sourceResult("NWS Forecast Grid", "nws"),
        wfigs: async () => sourceResult("NIFC WFIGS", "wfigs"),
        firms: async () => sourceResult("NASA FIRMS", "firms"),
        pwfdf: async () =>
          sourceResult("USGS PWFDF", "usgs-pwfdf", {}, {
            analysisGeometryVersion: "2026-09-14-provider-resolution-v1",
            assessment: {
              fireName: "Ventura Canyon Fire",
              fireId: "Ventura_Canyon_v2",
              assessmentDate: "2026-06-20T00:00:00.000Z",
            },
            basins: [basin],
          }),
        roads: async () =>
          sourceResult("Census TIGERweb Roads", "tiger-roads", {}, {
            geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
            features: [{
              id: "road-in-basin",
              sourceKey: "tiger-roads", sourceName: "Census TIGERweb Roads",
              name: "Basin Road",
              class: "S1200",
              paths: [[[-119.3, 34.4], [-119.3, 34.6]]],
            }],
          }),
        hydro: async () =>
          sourceResult("USGS 3DHP Flowlines", "3dhp-flowlines", {}, {
            geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
            features: [{
              id: "flow-in-basin",
              sourceKey: "3dhp-flowlines", sourceName: "USGS 3DHP Flowlines",
              name: "Basin Creek",
              class: "Channel Line",
              paths: [[[-119.4, 34.5], [-119.2, 34.5]]],
            }],
          }),
        bridges: async () =>
          sourceResult("FHWA/BTS Bridges", "fhwa-nbi-bridges", {}, {
            assets: sourceAssets,
          }),
      },
    });

    const linked = refresh.assets.find((asset) =>
      asset.evidence?.some(
        (item) =>
          item.sourceKey === "usgs-pwfdf" &&
          item.sourceFeatureId === basin.id,
      ),
    );

    expect(refresh.assets).toHaveLength(36);
    expect(refresh.recommendations).toHaveLength(36);
    expect(linked).toMatchObject({ type: "Inferred Crossing" });
    expect(refresh.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: linked?.id,
          evidence: expect.arrayContaining([
            expect.objectContaining({
              sourceKey: "usgs-pwfdf",
              sourceFeatureId: basin.id,
            }),
          ]),
        }),
      ]),
    );
  });

  it("blocks live refresh when persisted incident geometry is missing", async () => {
    const fetchImpl = vi.fn();
    const incidentWithoutGeometry: Incident = {
      ...incident,
      locationContext: undefined,
      rainfallForecast: "1.50 - 2.75 in",
      selectedFire: {
        ...incident.selectedFire,
        name: "Ventura County Fire",
      },
    };

    const refresh = await runLiveSourceRefresh({
      incident: incidentWithoutGeometry,
      assets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(refresh.assets).toEqual([]);
    expect(refresh.recommendations).toEqual([]);
    expect(refresh.incident.coverageStatus).toBe("not_available");
    expect(refresh.incident.rainfallForecast).toBe("Not available");
    expect(refresh.sourceSnapshots).toHaveLength(1);
    expect(refresh.sourceSnapshots[0]).toMatchObject({
      sourceKey: "incident-location-context",
      status: "offline",
      coverageStatus: "not_available",
    });
    expect(refresh.sourceSnapshots[0].detail).toContain("synthetic coordinates");
  });

  it("builds inferred assets and recommendations from source-backed road and hydro geometry", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 1420 }));

    const refresh = await runLiveSourceRefresh({
    incident,
    assets: [],
    fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
      adapters: {
        nws: async () => ({
          sourceName: "NWS Forecast Grid and Active Alerts",
          sourceKey: "nws",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "24 min ago",
          detail: "NWS quantitative precipitation loaded.",
          warnings: [],
          rawPayload: {},
          coverageStatus: "available",
          derivedSignals: {
            rainfallThreat: 0.82,
            rainfallForecast: "2.05 in forecast total rainfall",
            reasonCodes: ["Heavy Rain Forecast"],
          },
        }),
        wfigs: async () => ({
          sourceName: "NIFC WFIGS Current Interagency Fire Perimeters",
          sourceKey: "wfigs",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "24 min ago",
          detail: "Current WFIGS fire perimeter loaded.",
          warnings: [],
          rawPayload: {},
          coverageStatus: "available",
          derivedSignals: {
            burnSeverity: 0.75,
            reasonCodes: ["Current Fire Perimeter"],
          },
        }),
        firms: async () => ({
          sourceName: "NASA FIRMS Active Fire",
          sourceKey: "firms",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "24 min ago",
          detail: "FIRMS hotspot context loaded.",
          warnings: [],
          rawPayload: {},
          coverageStatus: "available",
          derivedSignals: {
            burnSeverity: 0.65,
            reasonCodes: ["Recent Active Fire Hotspots"],
          },
        }),
        pwfdf: async () => buildPwfdfUnavailableResult(locationContext, "No published assessment"),
        roads: async () => ({
          sourceName: "Census TIGERweb Transportation Roads",
          sourceKey: "tiger-roads",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:24:00.000Z",
          stale: false,
          freshnessLabel: "Just now",
          detail: "1 road loaded.",
          warnings: [],
          rawPayload: {
            geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
            featureCount: 1,
            features: [
              {
                id: "road-1",
                name: "US Hwy 189",
                class: "S1200",
                sourceKey: "tiger-roads",
                sourceName: "Census TIGERweb Transportation Roads",
                sourceUrl: "https://tigerweb.example/roads",
                paths: [[
                  [-119.22, 34.45],
                  [-119.218, 34.452],
                ]],
              },
            ],
          },
          coverageStatus: "available",
          derivedSignals: { reasonCodes: ["Official Road Geometry"] },
        }),
        hydro: async () => ({
          sourceName: "USGS 3DHP Flowlines",
          sourceKey: "3dhp-flowlines",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:24:00.000Z",
          stale: false,
          freshnessLabel: "Just now",
          detail: "1 flowline loaded.",
          warnings: [],
          rawPayload: {
            geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
            featureCount: 1,
            features: [
              {
                id: "flowline-1",
                name: "Waterbody Connector",
                class: "Channel Line",
                sourceKey: "3dhp-flowlines",
                sourceName: "USGS 3DHP Flowlines",
                sourceUrl: "https://hydro.example/flowlines",
                paths: [[
                  [-119.2205, 34.4505],
                  [-119.2175, 34.4525],
                ]],
              },
            ],
          },
          coverageStatus: "available",
          derivedSignals: { reasonCodes: ["Official Hydrography"] },
        }),
      },
    });

    expect(refresh.assets).toHaveLength(1);
    expect(refresh.assets[0]).toMatchObject({
      type: "Inferred Crossing",
      source: "Census TIGERweb roads + USGS 3DHP flowlines",
      sourceFeatureIds: ["road-1", "flowline-1"],
      coverageStatus: "partial",
    });
    expect(refresh.recommendations).toHaveLength(1);
    expect(refresh.recommendations[0]).toMatchObject({
      assetName: "US Hwy 189 @ Waterbody Connector",
      changedSinceLastRefresh: "Source-Backed Candidate",
    });
    expect(refresh.recommendations[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKey: "tiger-roads" }),
        expect.objectContaining({ sourceKey: "3dhp-flowlines" }),
      ]),
    );
  });

  it("does not invent a crossing across the gap between disconnected road parts", () => {
    const road = { id: "road", sourceKey: "tiger-roads", sourceName: "TIGERweb", paths: [
      [[-119.4, 34.2], [-119.35, 34.2]], [[-119.25, 34.2], [-119.2, 34.2]],
    ] as [number, number][][] };
    const flow = { id: "flow", sourceKey: "3dhp-flowlines", sourceName: "USGS", paths: [
      [[-119.3, 34.19], [-119.3, 34.21]],
    ] as [number, number][][] };
    expect(inferCrossingAssets(incident, [road], [flow])).toEqual([]);
  });

  it("does not retain legacy inferred candidates when current road geometry is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refresh = await runLiveSourceRefresh({ incident, assets,
      fetchImpl: vi.fn(async () => { throw new Error("Unexpected provider call"); }) as unknown as typeof fetch,
      adapters: { roads: async () => { throw new Error("Road geometry unavailable"); } },
    });
    expect(refresh.assets).toEqual([]);
    expect(refresh.recommendations).toEqual([]);
    expect(refresh.sourceSnapshots.some((source) => source.stale)).toBe(true);
    vi.restoreAllMocks();
  });

  it("retains crossings on separate parts with stable source and part provenance", () => {
    const road = { id: "road", sourceKey: "tiger-roads", sourceName: "TIGERweb", sourceUrl: "https://example.com/roads/1", paths: [
      [[-119.4, 34.2], [-119.2, 34.2]], [[-119.4, 34.4], [-119.2, 34.4]],
    ] as [number, number][][] };
    const flow = { id: "flow", sourceKey: "3dhp-flowlines", sourceName: "USGS", paths: [
      [[-119.3, 34.1], [-119.3, 34.5]],
    ] as [number, number][][] };
    const result = inferCrossingAssets(incident, [road], [flow]);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((asset) => asset.id)).size).toBe(2);
    expect(result.map((asset) => asset.evidence?.[0].sourcePartIndex).sort()).toEqual([0, 1]);
    expect(result.every((asset) => asset.metrics?.inferenceGeometryVersion === SOURCE_LINE_GEOMETRY_VERSION)).toBe(true);
    expect(inferCrossingAssets(incident, [road], [flow])).toEqual(result);
    const otherLayer = inferCrossingAssets(incident, [{ ...road, sourceUrl: "https://example.com/roads/2" }], [flow]);
    expect(otherLayer[0].id).not.toBe(result[0].id);
    expect(result[1].sourceFeatureIds).toEqual(["road", "flow"]);
  });

  it("does not replace a long bent road with an artificial chord", () => {
    const road = { id: "road", sourceKey: "tiger-roads", sourceName: "TIGERweb", paths: [[
      ...Array.from({ length: 80 }, (_, i) => [-119.4, 34.2 + i / 400] as [number, number]),
      [-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.2],
    ]] as [number, number][][] };
    const flow = { id: "flow", sourceKey: "3dhp-flowlines", sourceName: "USGS", paths: [[[-119.3, 34.19], [-119.3, 34.21]]] as [number, number][][] };
    expect(inferCrossingAssets(incident, [road], [flow])).toEqual([]);
    road.paths[0][80] = [-119.3, 34.2];
    expect(inferCrossingAssets(incident, [road], [flow])).toHaveLength(1);
  });

  it("detects between-vertex crossings and preserves exact PWFDF basin evidence", () => {
    const inferred = inferCrossingAssets(
      incident,
      [{
        id: "road-segment",
        name: "Basin Road",
        class: "S1200",
        paths: [[[-119.3, 34.4], [-119.3, 34.6]]],
        sourceKey: "tiger-roads",
        sourceName: "Census TIGERweb Transportation Roads",
        sourceUrl: "https://tigerweb.example/roads",
      }],
      [{
        id: "flow-segment",
        name: "Basin Creek",
        class: "Channel Line",
        paths: [[[-119.4, 34.5], [-119.2, 34.5]]],
        sourceKey: "3dhp-flowlines",
        sourceName: "USGS 3DHP Flowlines",
        sourceUrl: "https://hydro.example/flowlines",
      }],
    );

    expect(inferred).toHaveLength(1);
    expect(inferred[0].coordinates).toEqual([-119.3, 34.5]);

    const [linked] = linkPwfdfHazardsToAssets(
      inferred,
      {
        fireName: "Ventura Canyon",
        fireId: "Ventura_Canyon_v2",
        assessmentDate: "2026-06-20T00:00:00.000Z",
      },
      [{
        id: "pwfdf-Ventura_Canyon_v2-42",
        fireId: "Ventura_Canyon_v2",
        assessmentDate: "2026-06-20T00:00:00.000Z",
        probabilityClass: "60-80%",
        volumeClass: "10,000-100,000",
        combinedHazard: "High",
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.6],
            [-119.4, 34.6], [-119.4, 34.4],
          ]],
        },
      }],
      "https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer/4",
    );

    expect(linked.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKey: "usgs-pwfdf",
        sourceFeatureId: "pwfdf-Ventura_Canyon_v2-42",
      }),
    ]));
  });

  it("prioritizes basin crossings without discarding other inferred candidates", () => {
    const basin = {
      id: "pwfdf-Ventura_Canyon_v2-42",
      fireId: "Ventura_Canyon_v2",
      assessmentDate: "2026-06-20T00:00:00.000Z",
      probabilityClass: "60-80%",
      volumeClass: "10,000-100,000",
      combinedHazard: "High" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [[
          [-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.6],
          [-119.4, 34.6], [-119.4, 34.4],
        ]] as [number, number][][],
      },
    };
    const outsideRoads = Array.from({ length: 20 }, (_, index) => ({
      id: `outside-road-${index}`,
      name: `Outside Road ${index}`,
      class: "S1200",
      paths: [[
        [-119.5 + index * 0.0001, 34.1],
        [-119.5 + index * 0.0001, 34.2],
      ]] as [number, number][][],
      sourceKey: "tiger-roads" as const,
      sourceName: "Census TIGERweb Transportation Roads",
      sourceUrl: "https://tigerweb.example/roads",
    }));
    const outsideFlowlines = Array.from({ length: 20 }, (_, index) => ({
      id: `outside-flow-${index}`,
      name: `Outside Flowline ${index}`,
      class: "Channel Line",
      paths: [[
        [-119.6, 34.15 + index * 0.0001],
        [-119.4, 34.15 + index * 0.0001],
      ]] as [number, number][][],
      sourceKey: "3dhp-flowlines" as const,
      sourceName: "USGS 3DHP Flowlines",
      sourceUrl: "https://hydro.example/flowlines",
    }));
    const inferred = inferCrossingAssets(
      incident,
      [
        ...outsideRoads,
        {
          id: "inside-road",
          name: "Basin Road",
          class: "S1200",
          paths: [[[-119.3, 34.4], [-119.3, 34.6]]],
          sourceKey: "tiger-roads",
          sourceName: "Census TIGERweb Transportation Roads",
          sourceUrl: "https://tigerweb.example/roads",
        },
      ],
      [
        ...outsideFlowlines,
        {
          id: "inside-flow",
          name: "Basin Creek",
          class: "Channel Line",
          paths: [[[-119.4, 34.5], [-119.2, 34.5]]],
          sourceKey: "3dhp-flowlines",
          sourceName: "USGS 3DHP Flowlines",
          sourceUrl: "https://hydro.example/flowlines",
        },
      ],
      [basin],
    );

    expect(inferred).toHaveLength(401);
    expect(inferred[0]).toMatchObject({
      name: "Basin Road @ Basin Creek",
      coordinates: [-119.3, 34.5],
    });
  });

  it("evaluates basin-relevant lines beyond the default source sampling limits", () => {
    const basin = {
      id: "pwfdf-Ventura_Canyon_v2-42",
      fireId: "Ventura_Canyon_v2",
      assessmentDate: "2026-06-20T00:00:00.000Z",
      probabilityClass: "60-80%",
      volumeClass: "10,000-100,000",
      combinedHazard: "High" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [[
          [-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.6],
          [-119.4, 34.6], [-119.4, 34.4],
        ]] as [number, number][][],
      },
    };
    const fillerRoads = Array.from({ length: 80 }, (_, index) => ({
      id: `filler-road-${index}`,
      name: `Filler Road ${index}`,
      class: "S1200",
      paths: [[[-119.8, 34.1], [-119.7, 34.2]]] as [number, number][][],
      sourceKey: "tiger-roads" as const,
      sourceName: "Census TIGERweb Transportation Roads",
      sourceUrl: "https://tigerweb.example/roads",
    }));
    const fillerFlowlines = Array.from({ length: 100 }, (_, index) => ({
      id: `filler-flow-${index}`,
      name: `Filler Flowline ${index}`,
      class: "Channel Line",
      paths: [[[-119.8, 34.1], [-119.7, 34.2]]] as [number, number][][],
      sourceKey: "3dhp-flowlines" as const,
      sourceName: "USGS 3DHP Flowlines",
      sourceUrl: "https://hydro.example/flowlines",
    }));

    const inferred = inferCrossingAssets(
      incident,
      [...fillerRoads, {
        id: "basin-road-after-cap",
        name: "Basin Road",
        class: "S1200",
        paths: [[[-119.3, 34.4], [-119.3, 34.6]]],
        sourceKey: "tiger-roads" as const,
        sourceName: "Census TIGERweb Transportation Roads",
        sourceUrl: "https://tigerweb.example/roads",
      }],
      [...fillerFlowlines, {
        id: "basin-flow-after-cap",
        name: "Basin Creek",
        class: "Channel Line",
        paths: [[[-119.4, 34.5], [-119.2, 34.5]]],
        sourceKey: "3dhp-flowlines" as const,
        sourceName: "USGS 3DHP Flowlines",
        sourceUrl: "https://hydro.example/flowlines",
      }],
      [basin],
    );

    expect(inferred).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Basin Road @ Basin Creek",
        sourceFeatureIds: ["basin-road-after-cap", "basin-flow-after-cap"],
      }),
    ]));
  });

  it("does not infer a crossing when segment proximity exceeds the screening threshold", () => {
    const inferred = inferCrossingAssets(
      incident,
      [{
        id: "road-far",
        name: "Far Road",
        class: "S1200",
        paths: [[[-119.3, 34.4], [-119.3, 34.6]]],
        sourceKey: "tiger-roads",
        sourceName: "Census TIGERweb Transportation Roads",
      }],
      [{
        id: "flow-far",
        name: "Far Creek",
        class: "Channel Line",
        paths: [[[-119.0, 34.5], [-118.9, 34.5]]],
        sourceKey: "3dhp-flowlines",
        sourceName: "USGS 3DHP Flowlines",
      }],
    );

    expect(inferred).toEqual([]);
  });

  it("returns recommendations and stale source warnings when one adapter fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refresh = await runLiveSourceRefresh({
      incident,
      assets: assets.map((asset) => ({ ...asset, localOrUploaded: true, origin: "uploaded" })),
      adapters: {
        nws: async () => ({
          sourceName: "NWS Forecast Grid",
          sourceKey: "nws",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "24 min ago",
          detail: "NWS quantitative precipitation loaded.",
          warnings: [],
          rawPayload: {},
          derivedSignals: {
            rainfallThreat: 0.82,
            rainfallForecast: "2.05 in forecast total rainfall",
            activeAlerts: 2,
            reasonCodes: ["Heavy Rain Forecast"],
          },
        }),
        wfigs: async () => {
          throw new Error("WFIGS timeout");
        },
        firms: async () => ({
          sourceName: "NASA FIRMS Active Fire",
          sourceKey: "firms",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T13:45:00.000Z",
          stale: false,
          freshnessLabel: "39 min ago",
          detail: "3 FIRMS hotspots found in the county area.",
          warnings: [],
          rawPayload: { hotspotCount: 3 },
          derivedSignals: {
            burnSeverity: 0.72,
            fireHotspotCount: 3,
            reasonCodes: ["Recent Active Fire Hotspots"],
          },
        }),
        pwfdf: async () => buildPwfdfUnavailableResult(locationContext, "No published assessment"),
        roads: async () => ({
          sourceName: "Census TIGERweb Transportation Roads",
          sourceKey: "tiger-roads",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:24:00.000Z",
          stale: false,
          freshnessLabel: "Just now",
          detail: "1 road loaded.",
          warnings: [],
          rawPayload: { features: [] },
          coverageStatus: "available",
          derivedSignals: { reasonCodes: ["Official Road Geometry"] },
        }),
        hydro: async () => ({
          sourceName: "USGS 3DHP Flowlines",
          sourceKey: "3dhp-flowlines",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:24:00.000Z",
          stale: false,
          freshnessLabel: "Just now",
          detail: "1 flowline loaded.",
          warnings: [],
          rawPayload: { features: [] },
          coverageStatus: "available",
          derivedSignals: { reasonCodes: ["Official Hydrography"] },
        }),
      },
    });

    expect(refresh.sourceSnapshots).toHaveLength(6);
    const failedSource = refresh.sourceSnapshots.find(
      (snapshot) => snapshot.sourceKey === "wfigs",
    );
    expect(failedSource).toMatchObject({
      status: "offline",
      rawPayload: {
        available: false,
        status: "error",
        reason: "upstream_unavailable",
      },
    });
    expect(failedSource?.warnings).toEqual([
      "NIFC WFIGS Current Interagency Fire Perimeters could not be refreshed. No replacement values were used.",
    ]);
    expect(JSON.stringify(failedSource)).not.toContain("WFIGS timeout");
    const event = JSON.parse(String(warning.mock.calls[0]?.[0]));
    expect(event).toEqual({
      event: "fireafter.live_source.failure",
      sourceKey: "wfigs",
      operation: "refresh",
      errorType: "Error",
    });
    expect(JSON.stringify(event)).not.toContain("WFIGS timeout");
    expect(refresh.sourceSnapshots.some((snapshot) => snapshot.status === "offline")).toBe(true);
    expect(refresh.incident.rainfallForecast).toContain("2.05 in");
    expect(refresh.incident.dataFreshness).toBe("Medium");
    expect(refresh.recommendations[0].reasonCodes).toEqual(
      expect.arrayContaining(["Heavy Rain Forecast", "Stale NIFC WFIGS Current Interagency Fire Perimeters"]),
    );
    warning.mockRestore();
  });

  it("does not mark the incident stale from source-dated fallback or no-hotspot evidence alone", async () => {
    const staleFallback = {
      ...sourceResult("NIFC WFIGS Year-to-Date Fire Perimeters", "wfigs-ytd", {
        fireName: "Goshen Canyon",
        burnSeverity: 0.68,
        reasonCodes: ["Recent Burn Area"],
      }),
      stale: true,
      freshnessLabel: "Published 2026",
      detail: "Goshen Canyon year-to-date perimeter fallback loaded from WFIGS (409 acres).",
    };
    const noHotspots = {
      ...sourceResult("NASA FIRMS Active Fire", "firms", {
        burnSeverity: 0.2,
        reasonCodes: [],
      }),
      stale: true,
      freshnessLabel: "No recent hotspots",
      detail: "No FIRMS hotspots found in the county area over the last 3 days.",
      coverageStatus: "not_available" as const,
    };

    const refresh = await runLiveSourceRefresh({
      incident,
      assets,
      now: new Date("2026-06-27T14:24:00.000Z"),
      adapters: {
        nws: async () => sourceResult("NWS Forecast Grid and Active Alerts", "nws", {
          rainfallThreat: 0.82,
          rainfallForecast: "2.05 in forecast total rainfall",
          activeAlerts: 1,
          reasonCodes: ["Heavy Rain Forecast"],
        }),
        observations: async () => sourceResult("NWS Latest Observations", "nws-observations"),
        wfigs: async () => sourceResult("NIFC WFIGS Current Interagency Fire Perimeters", "wfigs"),
        wfigsYtd: async () => staleFallback,
        firms: async () => noHotspots,
        mtbs: async () => sourceResult("MTBS Burn Severity", "mtbs", {
          burnSeverity: 0.7,
          reasonCodes: ["Published Burn Severity"],
        }),
        pwfdf: async () => sourceResult("USGS PWFDF", "pwfdf"),
        roads: async () => sourceResult("Census TIGERweb Transportation Roads", "tiger-roads"),
        hydro: async () => sourceResult("USGS 3DHP Flowlines", "3dhp-flowlines"),
        epqs: async () => sourceResult("USGS Elevation Point Query Service", "epqs", {
          slopeProxy: 0.5,
          reasonCodes: ["Steep Terrain"],
        }),
        bridges: async () => sourceResult("FHWA/BTS National Bridge Inventory", "nbi-bridges"),
        structures: async () => sourceResult("USGS TNM Structures", "tnm-structures"),
      },
    });

    expect(refresh.incident.status).toBe("Storm Watch");
    expect(refresh.incident.dataFreshness).toBe("High");
    expect(refresh.incident.coverageStatus).toBe("available");
  });

  it("rejects rather than silently drops persisted uploaded assets outside the incident bounds", async () => {
    const outOfCountyAsset: Asset = {
      id: "asset-wrong-county",
      incidentId: incident.id,
      name: "Glendale Fwy Verified Crossing",
      type: "Culvert",
      locationLabel: "Uploaded local asset",
      coordinates: [-118.243, 34.125],
      geometry: { type: "Point", coordinates: [-118.243, 34.125] },
      source: "wrong-county-assets.csv",
      confidence: "High",
      localOrUploaded: true,
      origin: "uploaded",
      coverageStatus: "available",
    };

    const refresh = runLiveSourceRefresh({
      incident,
      assets: [outOfCountyAsset],
      now: new Date("2026-06-27T14:24:00.000Z"),
      fetchImpl: vi.fn(async () => jsonResponse({ value: 1420 })) as unknown as typeof fetch,
      adapters: {
        nws: async () =>
          sourceResult("NWS Forecast Grid", "nws", {
            rainfallThreat: 0.2,
            rainfallForecast: "No measurable rainfall in NWS grid",
          }),
        wfigs: async () =>
          sourceResult("NIFC WFIGS Current Interagency Fire Perimeters", "wfigs", {
            burnSeverity: 0.5,
          }),
        firms: async () =>
          sourceResult("NASA FIRMS Active Fire", "firms", { burnSeverity: 0.4 }),
        pwfdf: async () =>
          buildPwfdfUnavailableResult(locationContext, "No published assessment"),
        roads: async () =>
          sourceResult("Census TIGERweb Transportation Roads", "tiger-roads", {}, {
            featureCount: 0,
            features: [],
          }),
        hydro: async () =>
          sourceResult("USGS 3DHP Flowlines", "3dhp-flowlines", {}, {
            featureCount: 0,
            features: [],
          }),
      },
    });

    await expect(refresh).rejects.toMatchObject({ code: "uploaded_geometry_invalid" });
  });

  it("tracks changed-since when asset IDs differ by matching name, type, and location", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 1420 }));

    const initial = await runLiveSourceRefresh({
      incident,
      assets: [],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date("2026-06-27T14:24:00.000Z"),
      adapters: {
        nws: async () => ({
          sourceName: "NWS Forecast Grid and Active Alerts",
          sourceKey: "nws",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "24 min ago",
          detail: "NWS quantitative precipitation loaded.",
          warnings: [],
          rawPayload: {},
          coverageStatus: "available",
          derivedSignals: {
            rainfallThreat: 0.82,
            rainfallForecast: "2.05 in forecast total rainfall",
            reasonCodes: ["Heavy Rain Forecast"],
          },
        }),
        wfigs: async () => ({
          sourceName: "NIFC WFIGS Current Interagency Fire Perimeters",
          sourceKey: "wfigs",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "24 min ago",
          detail: "Current WFIGS fire perimeter loaded.",
          warnings: [],
          rawPayload: {},
          coverageStatus: "available",
          derivedSignals: {
            burnSeverity: 0.75,
            reasonCodes: ["Current Fire Perimeter"],
          },
        }),
        firms: async () => ({
          sourceName: "NASA FIRMS Active Fire",
          sourceKey: "firms",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "24 min ago",
          detail: "FIRMS hotspot context loaded.",
          warnings: [],
          rawPayload: {},
          coverageStatus: "available",
          derivedSignals: {
            burnSeverity: 0.65,
            fireHotspotCount: 3,
            reasonCodes: ["Recent Active Fire Hotspots"],
          },
        }),
        pwfdf: async () => buildPwfdfUnavailableResult(locationContext, "No published assessment"),
        roads: async () => ({
          sourceName: "Census TIGERweb Transportation Roads",
          sourceKey: "tiger-roads",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:24:00.000Z",
          stale: false,
          freshnessLabel: "Just now",
          detail: "1 road loaded.",
          warnings: [],
          rawPayload: {
            geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
            featureCount: 1,
            features: [
              {
                id: "road-1",
                name: "US Hwy 189",
                class: "S1200",
                sourceKey: "tiger-roads",
                sourceName: "Census TIGERweb Transportation Roads",
                sourceUrl: "https://tigerweb.example/roads",
                paths: [[
                  [-119.22, 34.45],
                  [-119.218, 34.452],
                ]],
              },
            ],
          },
          coverageStatus: "available",
          derivedSignals: { reasonCodes: ["Official Road Geometry"] },
        }),
        hydro: async () => ({
          sourceName: "USGS 3DHP Flowlines",
          sourceKey: "3dhp-flowlines",
          status: "online",
          fetchedAt: "2026-06-27T14:24:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:24:00.000Z",
          stale: false,
          freshnessLabel: "Just now",
          detail: "1 flowline loaded.",
          warnings: [],
          rawPayload: {
            geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
            featureCount: 1,
            features: [
              {
                id: "flowline-1",
                name: "Waterbody Connector",
                class: "Channel Line",
                sourceKey: "3dhp-flowlines",
                sourceName: "USGS 3DHP Flowlines",
                sourceUrl: "https://hydro.example/flowlines",
                paths: [[
                  [-119.2205, 34.4505],
                  [-119.2175, 34.4525],
                ]],
              },
            ],
          },
          coverageStatus: "available",
          derivedSignals: { reasonCodes: ["Official Hydrography"] },
        }),
      },
    });

    const changed = await runLiveSourceRefresh({
      incident,
      assets: initial.assets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      adapters: {
        nws: async () => ({
          sourceName: "NWS Forecast Grid and Active Alerts",
          sourceKey: "nws",
          status: "online",
          fetchedAt: "2026-06-27T14:28:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "28 min ago",
          detail: "Updated forecast refresh.",
          warnings: [],
          rawPayload: {},
          coverageStatus: "available",
          derivedSignals: {
            rainfallThreat: 0.82,
            rainfallForecast: "2.15 in forecast total rainfall",
            reasonCodes: ["Heavy Rain Forecast"],
          },
        }),
        wfigs: async () => ({
          sourceName: "NIFC WFIGS Current Interagency Fire Perimeters",
          sourceKey: "wfigs",
          status: "online",
          fetchedAt: "2026-06-27T14:28:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "28 min ago",
          detail: "Updated WFIGS perimeter context.",
          warnings: [],
          rawPayload: {},
          coverageStatus: "available",
          derivedSignals: {
            burnSeverity: 0.75,
            reasonCodes: ["Current Fire Perimeter"],
          },
        }),
        firms: async () => ({
          sourceName: "NASA FIRMS Active Fire",
          sourceKey: "firms",
          status: "online",
          fetchedAt: "2026-06-27T14:28:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
          stale: false,
          freshnessLabel: "28 min ago",
          detail: "Updated FIRMS hotspot context.",
          warnings: [],
          rawPayload: {},
          coverageStatus: "available",
          derivedSignals: {
            burnSeverity: 0.65,
            fireHotspotCount: 3,
            reasonCodes: ["Recent Active Fire Hotspots"],
          },
        }),
        pwfdf: async () => buildPwfdfUnavailableResult(locationContext, "No published assessment"),
        roads: async () => ({
          sourceName: "Census TIGERweb Transportation Roads",
          sourceKey: "tiger-roads",
          status: "online",
          fetchedAt: "2026-06-27T14:28:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:28:00.000Z",
          stale: false,
          freshnessLabel: "Just now",
          detail: "1 road loaded.",
          warnings: [],
          rawPayload: {
            geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
            featureCount: 1,
            features: [
              {
                id: "road-1",
                name: "US Hwy 189",
                class: "S1200",
                sourceKey: "tiger-roads",
                sourceName: "Census TIGERweb Transportation Roads",
                sourceUrl: "https://tigerweb.example/roads",
                paths: [[
                  [-119.22, 34.45],
                  [-119.218, 34.452],
                ]],
              },
            ],
          },
          coverageStatus: "available",
          derivedSignals: { reasonCodes: ["Official Road Geometry"] },
        }),
        hydro: async () => ({
          sourceName: "USGS 3DHP Flowlines",
          sourceKey: "3dhp-flowlines",
          status: "online",
          fetchedAt: "2026-06-27T14:28:00.000Z",
          sourceUpdatedAt: "2026-06-27T14:28:00.000Z",
          stale: false,
          freshnessLabel: "Just now",
          detail: "1 flowline loaded.",
          warnings: [],
          rawPayload: {
            geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
            featureCount: 1,
            features: [
              {
                id: "flowline-1",
                name: "Waterbody Connector",
                class: "Channel Line",
                sourceKey: "3dhp-flowlines",
                sourceName: "USGS 3DHP Flowlines",
                sourceUrl: "https://hydro.example/flowlines",
                paths: [[
                  [-119.2205, 34.4505],
                  [-119.2175, 34.4525],
                ]],
              },
            ],
          },
          coverageStatus: "available",
          derivedSignals: { reasonCodes: ["Official Hydrography"] },
        }),
      },
      previousRecommendations: initial.recommendations.map((recommendation) => ({
        ...recommendation,
        assetId: `${recommendation.assetId}-legacy`,
      })),
      previousSourceSnapshots: initial.sourceSnapshots,
    });

    expect(changed.recommendations).toHaveLength(1);
    expect(changed.recommendations[0].changedSinceLastRefresh).toContain("position unchanged");
    expect(changed.recommendations[0].changedSinceLastRefresh).toContain("now #1");
  });
});

function arcgisLineResponse(kind: "road" | "hydro") {
  if (kind === "road") {
    return {
      features: [
        {
          attributes: {
            OBJECTID: 3877,
            OID: "1102217764068",
            NAME: "US Hwy 189",
            BASENAME: "189",
            MTFCC: "S1200",
            RTTYP: "U",
          },
          geometry: {
            paths: [
              [
                [-119.22, 34.45],
                [-119.218, 34.452],
              ],
            ],
          },
        },
      ],
    };
  }

  return {
    features: [
      {
        attributes: {
          OBJECTID: 176018,
          id3dhp: "HZG0",
          gnisidlabel: "Waterbody Connector",
          featuretypelabel: "Channel Line",
          streamorder: 2,
        },
        geometry: {
          paths: [
            [
              [-119.2205, 34.4505],
              [-119.2175, 34.4525],
            ],
          ],
        },
      },
    ],
  };
}
