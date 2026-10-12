import { createHash } from "node:crypto";
import {sealNativeAcquisition,verifiedNativeAcquisition,type NativeAcquisition} from "./sentinel/native-provenance";
import { normalizeCountyBoundary, prepareCountyScope } from "./county-scope";
import { createResponseBudget, OutboundResponseError, responseByteLimit } from "./bounded-response";
import { assertRefreshOperationActive, fetchOperationResponse, RefreshOperationError, withRefreshOperation } from "./refresh-operation";
import { isUploadedAsset, projectUploadedAsset } from "./asset-import-validation";
import { calculatePriorityScore, UNKNOWN_RISK_ACTION } from "./scoring";
import { compareRecommendations } from "./recommendation-order";
import type { PreviousRecommendation, PreviousSource } from "./refresh-history";
import { SOURCE_LINE_GEOMETRY_VERSION, parseLinePaths, readSourceLineGeometry, type SourceLineFeature } from "./source-line-geometry";
import { FIRMS_PUBLIC_SOURCE_URL } from "./source-link";
import { evidenceMaxAgeMinutes, MTBS_INTERPRETATION_VERSION, publicationTimeIsValid, projectSourceFreshness } from "./source-freshness";
import { ArcgisInventoryError, fetchArcgisInventory, type ArcgisCheckpointStore } from "./arcgis-inventory";
import { InventoryCapacityError } from "./inventory-error";
import { checkpointCrossingInference, COUNTY_CROSSING_MAX_CANDIDATES, COUNTY_CROSSING_PAGE_BYTES, COUNTY_CROSSING_PAGE_CANDIDATES, type CrossingCandidate, type CrossingCheckpointStore, type CrossingCursor, type CrossingPage } from "./crossing-checkpoint";
import { ELEVATION_BATCH_URL, fetchElevationBatch } from "./elevation-batch";
import { pwfdfBasinsFromSnapshot } from "./pwfdf";
import { inventoryEvidenceGaps } from "./published-hazard";
import { PwfdfGeometryError, geometryBudget, prepareBasinContainment, PWFDF_GEOMETRY_VERSION, PWFDF_ANALYSIS_GEOMETRY_VERSION } from "./pwfdf-geometry";
import {
  buildPwfdfBasinsUrl,
  buildPwfdfLocationsUrl,
  linkPwfdfHazardsToAssets,
  parsePwfdfBasins,
  selectPwfdfAssessment,
  PWFDF_LINKAGE_VERSION,
  PwfdfDiscoveryError,
} from "./pwfdf";
import type { PwfdfBasinHazard } from "./pwfdf";
import type {
  Asset,
  CoverageStatus,
  Evidence,
  Incident,
  LocationCandidate,
  Recommendation,
  SourceSnapshot,
} from "./types";

type FetchLike = typeof fetch;

export class CountySearchUnavailableError extends Error {
  constructor() {
    super("County search is temporarily unavailable");
    this.name = "CountySearchUnavailableError";
  }
}

export type LiveSourceStatus = SourceSnapshot["status"];

export type LiveSourceDerivedSignals = {
  rainfallThreat?: number;
  rainfallForecast?: string;
  activeAlerts?: number;
  burnSeverity?: number;
  fireName?: string;
  fireAcres?: number;
  fireUpdatedAt?: string;
  fireSource?: string;
  fireSourceKey?: string | null;
  fireSourceUrl?: string | null;
  fireSourceFeatureId?: string | null;
  fireCoverageStatus?: CoverageStatus | null;
  fireCandidates?: Incident["fireCandidates"];
  fireHotspotCount?: number;
  dataFreshness?: number;
  confidenceMultiplier?: number;
  reasonCodes?: string[];
  limitations?: string[];
};

export type LiveSourceResult = {
  nativeAcquisition?: NativeAcquisition;
  sourceName: string;
  sourceKey: string;
  sourceUrl?: string;
  status: LiveSourceStatus;
  fetchedAt: string;
  sourceUpdatedAt: string;
  sourceTimeBasis?: SourceSnapshot["sourceTimeBasis"];
  validUntil?: string;
  stale: boolean;
  freshnessLabel: string;
  detail: string;
  coverageStatus?: CoverageStatus;
  rawPayload: Record<string, unknown>;
  warnings: string[];
  derivedSignals: LiveSourceDerivedSignals;
};

type SourceAdapter = (incident: Incident) => Promise<LiveSourceResult>;

export type AdapterMap = {
  nws: SourceAdapter;
  observations: SourceAdapter;
  wfigs: SourceAdapter;
  wfigsYtd: SourceAdapter;
  firms: SourceAdapter;
  mtbs: SourceAdapter;
  pwfdf: SourceAdapter;
  roads: SourceAdapter;
  hydro: SourceAdapter;
  epqs: SourceAdapter;
  bridges: SourceAdapter;
  structures: SourceAdapter;
};

export type LiveRefreshInput = {
  incident: Incident;
  assets: Asset[];
  previousRecommendations?: PreviousRecommendation[];
  previousSourceSnapshots?: PreviousSource[];
  // Fire selection relinks saved assets; it must not start a county acquisition.
  fireContextSnapshots?: SourceSnapshot[];
  adapters?: Partial<AdapterMap>;
  fetchImpl?: FetchLike;
  now?: Date;
  // Durable ingestion publishes source evidence before optional terrain work.
  skipElevation?: boolean;
  derivedAssets?: { assets: Asset[]; batchElevationUnavailable: boolean };
  crossingCheckpoint?: CrossingCheckpointStore;
  crossingMaxCandidates?: number;
  onRecommendationContext?: (context: LiveRecommendationContext) => void;
};

function sourceTimeoutMs() {
  const value = Number(process.env.FIREAFTER_SOURCE_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value >= 250 && value <= 60000 ? value : 8000;
}
const cacheTtlMinutes = evidenceMaxAgeMinutes();
const nwsBaseUrl = "https://api.weather.gov";
const wfigsLayerUrl =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query";
const wfigsYtdServiceBase =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services";
const wfigsYtdServiceNames = [
  "WFIGS_Interagency_Perimeters_YearToDate",
  "WFIGS_Interagency_Fire_Perimeters_to_Date",
];
const mtbsBurnedAreaLayerUrl =
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer/63/query";
const nbiBridgeLayerUrl =
  "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Bridge_Inventory/FeatureServer/0/query";
const tnmStructureLayerUrls = {
  hospital:
    "https://carto.nationalmap.gov/arcgis/rest/services/structures/mapserver/49/query",
  fire:
    "https://carto.nationalmap.gov/arcgis/rest/services/structures/mapserver/51/query",
};
const tigerRoadLayerUrls = [
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/2/query",
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/6/query",
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/8/query",
];
const hydroFlowlineLayerUrl =
  "https://hydro.nationalmap.gov/arcgis/rest/services/3DHP_all/MapServer/50/query";
const epqsUrl = "https://epqs.nationalmap.gov/v1/json";

export async function searchLocationsLive(
  query: string,
  fetchImpl: FetchLike = fetch,
): Promise<LocationCandidate[]> {
  const normalized = query.trim();
  if (!normalized) return [];

  try {
    const tokens = normalized
      .replace(/-/g, " ")
      .replace(/,/g, " ")
      .replace(/\bcounty\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    // A trailing two-letter state code ("Lincoln NM", "el-dorado-county-ca")
    // narrows the search instead of being stripped out of the county name.
    const stateMatch = tokens.match(/\s([A-Za-z]{2})$/);
    const stateFips = stateMatch
      ? stateFipsForAbbreviation(stateMatch[1])
      : undefined;
    const countyQuery = (
      stateFips ? tokens.slice(0, stateMatch?.index) : tokens
    ).trim();
    const whereClauses = [
      `UPPER(NAME) LIKE UPPER('%${escapeSqlLike(countyQuery)}%')`,
    ];
    if (stateFips) whereClauses.push(`STATE = '${stateFips}'`);
    const url = new URL(
      "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query",
    );
    url.searchParams.set("f", "json");
    url.searchParams.set("where", whereClauses.join(" AND "));
    url.searchParams.set(
      "outFields",
      "NAME,BASENAME,STATE,COUNTY,GEOID,OBJECTID,CENTLAT,CENTLON,INTPTLAT,INTPTLON",
    );
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("resultRecordCount", "12");

    const payload = await fetchJsonWithRetry<{ features?: TigerCountyFeature[] }>(
      url,
      { fetchImpl },
    );
    const results = (payload.features ?? [])
      .map(mapTigerCountyFeature)
      .filter((item): item is LocationCandidate => Boolean(item));

    return results;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "fireafter.live_source.failure",
        sourceKey: "tigerweb-county-search",
        operation: "county_search",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    throw new CountySearchUnavailableError();
  }
}

export async function runLiveSourceRefresh(input: LiveRefreshInput) {
  return withRefreshOperation("refresh", () => runLiveSourceRefreshWithinOperation(input));
}

async function runLiveSourceRefreshWithinOperation(input: LiveRefreshInput) {
  const now = input.now ?? new Date();
  const incident = input.incident;
  const location = incident.locationContext;
  if (!location) {
    const unavailable = buildMissingLocationContextResult(incident, now);
    return {
      incident: {
        ...incident,
        status: "Stale Data" as const,
        dataFreshness: "Low" as const,
        rainfallForecast:
          incident.rainfallForecast === "1.50 - 2.75 in"
            ? "Not available"
            : incident.rainfallForecast,
        selectedFire: {
          ...incident.selectedFire,
          name:
            incident.selectedFire.name === `${incident.county} Fire`
              ? "Not available"
              : incident.selectedFire.name,
          coverageStatus: incident.selectedFire.coverageStatus ?? "not_available",
        },
        coverageStatus: "not_available" as const,
      },
      assets: [],
      sourceSnapshots: [liveResultToSourceSnapshot(unavailable, incident.id, 0)],
      recommendations: [],
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const defaultAdapters: AdapterMap = {
    nws:
      input.adapters?.nws ??
      (() => fetchNwsSource(location, { fetchImpl, now })),
    observations:
      input.adapters?.observations ??
      (() => fetchNwsObservationsSource(location, { fetchImpl, now })),
    wfigs:
      input.adapters?.wfigs ??
      (sourceIncident => fetchWfigsSource(location, sourceIncident, { fetchImpl, now })),
    wfigsYtd:
      input.adapters?.wfigsYtd ??
      (sourceIncident =>
        fetchWfigsYearToDateSource(location, sourceIncident, { fetchImpl, now })),
    firms:
      input.adapters?.firms ??
      (() =>
        fetchFirmsSource(location, {
          fetchImpl,
          now,
          firmsMapKey: process.env.NASA_FIRMS_MAP_KEY,
          firmsSource: process.env.NASA_FIRMS_SOURCE,
        })),
    mtbs:
      input.adapters?.mtbs ??
      (() => fetchMtbsBurnSeveritySource(location, { fetchImpl, now })),
    pwfdf:
      input.adapters?.pwfdf ??
      (sourceIncident => fetchPwfdfSource(location, sourceIncident, { fetchImpl, now })),
    roads:
      input.adapters?.roads ??
      (() => fetchTigerRoadsSource(location, { fetchImpl, now })),
    hydro:
      input.adapters?.hydro ??
      (() => fetch3dhpFlowlinesSource(location, { fetchImpl, now })),
    epqs:
      input.adapters?.epqs ??
      (() => fetchEpqsSource(location, { fetchImpl, now })),
    bridges:
      input.adapters?.bridges ??
      (() => fetchNbiBridgeSource(location, { fetchImpl, now })),
    structures:
      input.adapters?.structures ??
      (() => fetchTnmStructuresSource(location, { fetchImpl, now })),
  };
  const adapters = input.adapters
    ? ({
        nws: defaultAdapters.nws,
        wfigs: defaultAdapters.wfigs,
        firms: defaultAdapters.firms,
        pwfdf: defaultAdapters.pwfdf,
        roads: defaultAdapters.roads,
        hydro: defaultAdapters.hydro,
        ...(input.adapters.observations ? { observations: defaultAdapters.observations } : {}),
        ...(input.adapters.wfigsYtd ? { wfigsYtd: defaultAdapters.wfigsYtd } : {}),
        ...(input.adapters.mtbs ? { mtbs: defaultAdapters.mtbs } : {}),
        ...(input.adapters.epqs ? { epqs: defaultAdapters.epqs } : {}),
        ...(input.adapters.bridges ? { bridges: defaultAdapters.bridges } : {}),
        ...(input.adapters.structures ? { structures: defaultAdapters.structures } : {}),
      } as Partial<AdapterMap>)
    : defaultAdapters;

  if (input.fireContextSnapshots !== undefined) {
    for (const key of Object.keys(defaultAdapters) as (keyof AdapterMap)[]) {
      if (["wfigs", "wfigsYtd", "pwfdf"].includes(key)) continue;
      const saved = input.fireContextSnapshots.find(source => source.sourceKey === sourceFailureSourceKey(key));
      adapters[key] = async () => {
        if (!saved) return { ...sourceFailureResult(key, now), fetchedAt: "", sourceUpdatedAt: "",
          detail: "No saved evidence. County sources are not acquired during fire selection." };
        const source = projectSourceFreshness(saved, now, evidenceMaxAgeMinutes());
        return { ...source, sourceKey: saved.sourceKey!, rawPayload: source.rawPayload ?? {},
          warnings: source.warnings ?? [], derivedSignals: source.derivedSignals ?? {} };
      };
    }
  }
  const entries = Object.entries(adapters) as [keyof AdapterMap, SourceAdapter][];
  const runSourceAdapter = async (
    key: keyof AdapterMap,
    adapter: SourceAdapter,
    sourceIncident: Incident,
  ) => {
    try {
      const result=await adapter(sourceIncident);
      const cached = input.fireContextSnapshots !== undefined && !["wfigs", "wfigsYtd", "pwfdf"].includes(key);
      return input.adapters?.[key] || cached ? result : sealNativeAcquisition(result, incident.id, "live");
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "fireafter.live_source.failure",
          sourceKey: sourceFailureSourceKey(key),
          operation: "refresh",
          errorType: errorType(error),
          ...(error instanceof ArcgisInventoryError ? { inventoryErrorCode: error.code } : {}),
        }),
      );
      return sourceFailureResult(key, now, error instanceof ArcgisInventoryError ? error : undefined);
    }
  };
  const wfigsResult = await runSourceAdapter(
    "wfigs",
    adapters.wfigs ?? defaultAdapters.wfigs,
    incident,
  );
  const incidentForDependentSources = applyLiveSignalsToIncident(
    incident,
    location,
    mergeDerivedSignals([wfigsResult]),
    [wfigsResult],
    now,
  );
  const remainingResults = await Promise.all(
    entries
      .filter(([key]) => key !== "wfigs")
      .map(async ([key, adapter]) => [
        key,
        await runSourceAdapter(key, adapter, incidentForDependentSources),
      ] as const),
  );
  const resultsByKey = new Map<keyof AdapterMap, LiveSourceResult>([
    ["wfigs", wfigsResult],
    ...remainingResults,
  ]);
  const results = entries.map(([key]) => resultsByKey.get(key)!);

  const sourceIncident = applyLiveSignalsToIncident(
    incident,
    location,
    mergeDerivedSignals(results),
    results,
    now,
  );
  const { assets: liveAssets, batchElevationUnavailable } = input.derivedAssets ?? await deriveAssetsForIncident({
    incident: sourceIncident,
    existingAssets: input.assets,
    sourceResults: results,
    fetchImpl,
    now,
    skipElevation: input.skipElevation,
    preserveInventory: input.fireContextSnapshots !== undefined,
    crossingCheckpoint: input.crossingCheckpoint,
    crossingMaxCandidates: input.crossingMaxCandidates,
  });
  if (batchElevationUnavailable) {
    const elevationSource = results.find((source) => source.sourceKey === "usgs-epqs");
    if (elevationSource) {
      elevationSource.status = "delayed";
      elevationSource.stale = true;
      elevationSource.coverageStatus = elevationSource.coverageStatus === "available"
        ? "partial"
        : elevationSource.coverageStatus;
      elevationSource.freshnessLabel = "Partial terrain coverage";
      elevationSource.detail = "The county-centroid sample may be available, but the USGS 3DEP county-wide batch was unavailable; per-asset slope proxies are missing for this refresh.";
      elevationSource.warnings = [...new Set([
        ...elevationSource.warnings,
        "USGS 3DEP county-wide elevation samples were unavailable; asset slope evidence remains unknown.",
      ])];
      elevationSource.rawPayload = { ...elevationSource.rawPayload, batchStatus: "unavailable" };
      elevationSource.derivedSignals = {
        ...elevationSource.derivedSignals,
        dataFreshness: Math.min(elevationSource.derivedSignals.dataFreshness ?? 0.86, 0.58),
        confidenceMultiplier: Math.min(elevationSource.derivedSignals.confidenceMultiplier ?? 0.86, 0.78),
        reasonCodes: [...new Set([
          ...(elevationSource.derivedSignals.reasonCodes ?? []),
          "County-wide Elevation Proxy Partially Available",
        ])],
        limitations: [...new Set([
          ...(elevationSource.derivedSignals.limitations ?? []),
          "Per-asset slope proxies are unavailable for this refresh; do not infer low terrain risk.",
        ])],
      };
    }
  }
  const merged = mergeDerivedSignals(results);
  const snapshots = results.map((result, index) =>
    liveResultToSourceSnapshot(result, incident.id, index),
  );
  const liveIncident = applyLiveSignalsToIncident(incident, location, merged, results, now);
  const recommendations = buildLiveRecommendations(
    liveIncident,
    liveAssets,
    merged,
    results,
    snapshots,
    now,
    input.previousRecommendations,
    input.previousSourceSnapshots,
    input.onRecommendationContext,
  );

  return {
    incident: liveIncident,
    assets: liveAssets,
    sourceSnapshots: snapshots,
    recommendations,
  };
}

export async function fetchNwsSource(
  location: LocationCandidate,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const [lon, lat] = location.centroid;
  const pointsUrl = `${nwsBaseUrl}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const points = await fetchJsonWithRetry<NwsPointResponse>(pointsUrl, {
    fetchImpl,
    headers: nwsHeaders(),
  });
  const gridUrl = points.properties?.forecastGridData;
  const countyZone = `${location.state}C${location.fips.slice(-3)}`;
  const alertsUrl = `${nwsBaseUrl}/alerts/active?zone=${encodeURIComponent(countyZone)}`;

  const [gridResult, alertsResult] = await Promise.allSettled([
    gridUrl
      ? fetchJsonWithRetry<Record<string, unknown>>(gridUrl, {
          fetchImpl,
          headers: nwsHeaders(),
        })
      : Promise.resolve({}),
    fetchJsonWithRetry<NwsAlertsResponse>(alertsUrl, {
      fetchImpl,
      headers: nwsHeaders(),
    }),
  ]);

  const rainfall =
    gridResult.status === "fulfilled"
      ? computeRainfallThreatFromGridData(gridResult.value, now)
      : unavailableRainfall("NWS precipitation grid request failed; refresh before using rainfall evidence.");
  const alerts =
    alertsResult.status === "fulfilled"
      ? summarizeNwsAlerts(alertsResult.value, location, points.properties?.forecastZone)
      : { activeAlerts: 0, relevantAlerts: [], warning: "NWS active alerts unavailable." };
  const gridFailed = gridResult.status === "rejected";
  const alertsFailed = alertsResult.status === "rejected";
  const grid = gridResult.status === "fulfilled" ? gridResult.value as { properties?: { updateTime?: unknown } } : undefined;
  const publishedAt = typeof grid?.properties?.updateTime === "string" ? grid.properties.updateTime : "";
  const publicationTime = Date.parse(publishedAt);
  const validThrough = Date.parse(rainfall.validUntil ?? "");
  const temporalFailure = !Number.isFinite(publicationTime) || publicationTime > now.getTime() ||
    !Number.isFinite(validThrough) || validThrough <= now.getTime();
  const stale = (gridFailed && alertsFailed) || temporalFailure;
  const partialFailure = gridFailed || alertsFailed || Boolean(rainfall.warning) || Boolean(alerts.warning);

  return {
    sourceName: "NWS Forecast Grid and Active Alerts",
    sourceKey: "nws",
    sourceUrl: gridUrl ?? pointsUrl,
    status: gridFailed && alertsFailed ? "offline" : partialFailure || temporalFailure ? "delayed" : "online",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: publishedAt,
    sourceTimeBasis: publishedAt ? "provider" : "unknown",
    validUntil: Number.isFinite(validThrough) ? new Date(validThrough).toISOString() : "",
    stale,
    freshnessLabel: temporalFailure ? "Forecast time unavailable or expired" : freshnessLabel(publishedAt, now),
    detail: `${rainfall.label}; ${alerts.activeAlerts} active county/forecast-zone alert${alerts.activeAlerts === 1 ? "" : "s"} matched.`,
    coverageStatus: stale ? "error" : partialFailure ? "partial" : "available",
    warnings: [
      ...(gridFailed ? ["NWS precipitation grid request failed."] : []),
      ...(temporalFailure ? ["NWS forecast publication time or validity window is missing, invalid, or expired; refresh before use."] : []),
      ...(rainfall.warning ? [rainfall.warning] : []),
      ...(alerts.warning ? [alerts.warning] : []),
    ],
    rawPayload: {
      pointOffice: points.properties?.cwa,
      gridId: points.properties?.gridId,
      gridX: points.properties?.gridX,
      gridY: points.properties?.gridY,
      relevantAlerts: alerts.relevantAlerts,
      rainfallWindow: { start: now.toISOString(), end: new Date(now.getTime() + 48 * 3_600_000).toISOString() },
      rainfallStatus: rainfall.warning ? "unavailable" : "available",
      alertCountyZone: countyZone,
      alertCoverageStatus: alertsFailed ? "unavailable" : alerts.warning ? "partial" : "available",
    },
    derivedSignals: {
      rainfallThreat: temporalFailure ? undefined : rainfall.rainfallThreat,
      rainfallForecast: rainfall.label,
      activeAlerts: alerts.activeAlerts,
      dataFreshness: stale ? 0.55 : partialFailure ? 0.75 : 0.95,
      confidenceMultiplier: stale ? 0.78 : partialFailure ? 0.84 : 0.95,
      reasonCodes: [
        ...(!temporalFailure && (rainfall.rainfallThreat ?? 0) >= 0.75 ? ["Heavy Rain Forecast"] : []),
        ...(alerts.relevantAlerts.length > 0 ? ["Active Weather Alert"] : []),
      ],
      limitations: ["Rainfall is the forecast grid at the county centroid, not a county-wide maximum or a calibrated debris-flow forecast."],
    },
  };
}

export async function fetchNwsObservationsSource(
  location: LocationCandidate,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const [lon, lat] = location.centroid;
  const pointsUrl = `${nwsBaseUrl}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const points = await fetchJsonWithRetry<NwsPointResponse>(pointsUrl, {
    fetchImpl,
    headers: nwsHeaders(),
  });
  const stationLink = points.properties?.observationStations;
  let stationsUrl: string | undefined;
  try {
    const url = new URL(stationLink ?? "");
    if (url.origin === nwsBaseUrl && !url.username && !url.password &&
      /^\/gridpoints\/[A-Za-z]{3}\/\d+,\d+\/stations$/.test(url.pathname)) stationsUrl = url.href;
  } catch { /* Untrusted or malformed linked URLs are not observation endpoints. */ }

  if (!stationsUrl) {
    return {
      sourceName: "NWS Latest Observations",
      sourceKey: "nws-observations",
      sourceUrl: pointsUrl,
      status: "delayed",
      fetchedAt: now.toISOString(),
      sourceUpdatedAt: "",
      sourceTimeBasis: "unknown",
      stale: true,
      freshnessLabel: "No station list",
      detail: "NWS point metadata did not include an observation station list.",
      coverageStatus: "not_available",
      warnings: ["NWS observation station list unavailable for this county point."],
      rawPayload: { pointsUrl },
      derivedSignals: {
        dataFreshness: 0.55,
        confidenceMultiplier: 0.78,
        reasonCodes: ["NWS Observations Not Available"],
        limitations: ["Latest NWS station observation is not available for this county point."],
      },
    };
  }

  const stations = await fetchJsonWithRetry<NwsStationsResponse>(stationsUrl, {
    fetchImpl,
    headers: nwsHeaders(),
  });
  const seen = new Set<string>();
  const candidates = (stations.features ?? []).flatMap(station => {
    const id = station.properties?.stationIdentifier ?? station.id?.split("/").filter(Boolean).at(-1);
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ stationId: id, stationName: station.properties?.name ?? id }];
  }).slice(0, 3);

  if (candidates.length === 0) {
    return {
      sourceName: "NWS Latest Observations",
      sourceKey: "nws-observations",
      sourceUrl: stationsUrl,
      status: "delayed",
      fetchedAt: now.toISOString(),
      sourceUpdatedAt: "",
      sourceTimeBasis: "unknown",
      stale: true,
      freshnessLabel: "No station",
      detail: "NWS returned no observation station for the selected county point.",
      coverageStatus: "not_available",
      warnings: ["No NWS observation station was returned for this county point."],
      rawPayload: { stationCount: stations.features?.length ?? 0 },
      derivedSignals: {
        dataFreshness: 0.55,
        confidenceMultiplier: 0.78,
        reasonCodes: ["NWS Observations Not Available"],
        limitations: ["Latest NWS station observation is not available for this county point."],
      },
    };
  }

  // One shared body/time budget covers all fallback candidates, not one fresh
  // budget per station. A missing first station must not hide the next real one.
  const budget = createResponseBudget(responseByteLimit(process.env.FIREAFTER_SOURCE_MAX_RESPONSE_BYTES), sourceTimeoutMs());
  let checked = 0;
  let selected: { stationId: string; stationName: string; latestUrl: string;
    observation: NwsObservationResponse; observedAt: string; stale: boolean } | undefined;
  for (const candidate of candidates) {
    const latestUrl = `${nwsBaseUrl}/stations/${candidate.stationId}/observations/latest`;
    checked++;
    try {
      const response = await fetchOperationResponse(latestUrl, { headers: nwsHeaders() }, budget, fetchImpl);
      if (!response.ok) continue;
      const observation = await response.json() as NwsObservationResponse;
      const observedAt = observation?.properties?.timestamp;
      if (typeof observedAt !== "string" || !publicationTimeIsValid(observedAt, now)) continue;
      const measurements = nwsObservationMeasurements(observation.properties);
      if (measurements.temperatureC === undefined && measurements.precipitationLastHourMm === undefined &&
        !(typeof observation.properties?.textDescription === "string" && observation.properties.textDescription.trim())) continue;
      const stale = isOlderThan(observedAt, now, cacheTtlMinutes * 4);
      if (!selected || Date.parse(observedAt) > Date.parse(selected.observedAt)) {
        selected = { ...candidate, latestUrl, observation, observedAt, stale };
      }
      if (!stale) break;
    } catch (error) {
      if (error instanceof RefreshOperationError) throw error;
      if (error instanceof OutboundResponseError && error.code !== "network") break;
    }
  }
  if (!selected) {
    return {
      sourceName: "NWS Latest Observations", sourceKey: "nws-observations", sourceUrl: stationsUrl,
      status: "delayed", fetchedAt: now.toISOString(), sourceUpdatedAt: "", sourceTimeBasis: "unknown", stale: true,
      freshnessLabel: "No verified observation time", coverageStatus: "not_available",
      detail: `No timestamp-verified observation was available from ${checked} NWS-listed station candidates.`,
      warnings: ["The bounded station checks failed or returned no valid observation time. No observation was fabricated."],
      rawPayload: { stationCandidatesChecked: checked },
      derivedSignals: { dataFreshness: 0.55, confidenceMultiplier: 0.78,
        reasonCodes: ["NWS Observations Not Available"], limitations: ["Latest NWS station observation is unavailable for this county point."] },
    };
  }
  const { stationId, stationName, latestUrl, observation, observedAt, stale } = selected;
  const { precipitationLastHourMm, temperatureC } = nwsObservationMeasurements(observation.properties);
  const summary = [
    typeof observation.properties?.textDescription === "string" ? observation.properties.textDescription.trim() : undefined,
    temperatureC !== undefined ? `temperature ${temperatureC} C` : undefined,
    precipitationLastHourMm !== undefined ? `hourly precipitation ${precipitationLastHourMm} mm` : undefined,
  ].filter(Boolean).join("; ");

  return {
    sourceName: "NWS Latest Observations",
    sourceKey: "nws-observations",
    sourceUrl: latestUrl,
    status: stale ? "delayed" : "online",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: observedAt,
    sourceTimeBasis: "provider",
    validUntil: new Date(Date.parse(observedAt) + cacheTtlMinutes * 4 * 60_000).toISOString(),
    stale,
    freshnessLabel: freshnessLabel(observedAt, now),
    detail: `${stationName} latest observation: ${summary}.`,
    coverageStatus: "available",
    warnings: [
      ...(stale ? ["Latest NWS observation is older than the freshness target."] : []),
      ...(checked > 1 ? ["An earlier NWS-listed station was unavailable, invalid or stale; an alternative listed station was used."] : []),
      "This is one station observation, not county-wide rainfall coverage. Missing or unsupported-unit measurements remain unavailable.",
    ],
    rawPayload: {
      stationId,
      stationName,
      stationCandidatesChecked: checked,
      textDescription: observation.properties?.textDescription,
      temperatureC,
      precipitationLastHourMm,
    },
    derivedSignals: {
      dataFreshness: stale ? 0.72 : 0.9,
      confidenceMultiplier: stale ? 0.84 : 0.92,
      reasonCodes:
        precipitationLastHourMm && precipitationLastHourMm > 0
          ? ["Observed Rainfall"]
          : ["Latest Weather Observation"],
      limitations: ["A station observation is local context, not a county-wide rainfall measurement or debris-flow prediction."],
    },
  };
}

function nwsObservationMeasurements(properties: NwsObservationResponse["properties"]) {
  const precipitation = properties?.precipitationLastHour;
  const temperature = properties?.temperature;
  return {
    precipitationLastHourMm: precipitation?.unitCode === "wmoUnit:mm" &&
      typeof precipitation.value === "number" && Number.isFinite(precipitation.value) && precipitation.value >= 0
      ? precipitation.value : undefined,
    temperatureC: temperature?.unitCode === "wmoUnit:degC" &&
      typeof temperature.value === "number" && Number.isFinite(temperature.value)
      ? temperature.value : undefined,
  };
}

export async function fetchWfigsSource(
  location: LocationCandidate,
  incident: Incident,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);
  const url = new URL(wfigsLayerUrl);
  url.searchParams.set("f", "json");
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "*");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("geometry", bbox.join(","));
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("resultRecordCount", "10");

  const payload = await fetchJsonWithRetry<{ features?: WfigsFeature[] }>(url, {
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const fireCandidates = selectWfigsFireCandidates(payload.features ?? [], incident);
  const selectedYtdContext = incident.selectedFire.sourceKey === "wfigs-ytd";
  const fire = selectedYtdContext
    ? null
    : selectWfigsFireContext(payload.features ?? [], incident);
  const selectedCurrentContext =
    incident.selectedFire.sourceKey === "wfigs" &&
    Boolean(incident.selectedFire.sourceFeatureId);

  if (!fire) {
    if (selectedYtdContext) {
      return {
        sourceName: "NIFC WFIGS Current Interagency Fire Perimeters",
        sourceKey: "wfigs",
        sourceUrl: wfigsLayerUrl,
        status: "online",
        fetchedAt: now.toISOString(),
        sourceUpdatedAt: now.toISOString(),
        stale: false,
        freshnessLabel: "Candidate context loaded",
        detail:
          "Current WFIGS candidates loaded; the explicitly selected year-to-date perimeter remains the incident fire context.",
        coverageStatus: "available",
        warnings: [],
        rawPayload: {
          featureCount: payload.features?.length ?? 0,
          fireCandidates,
        },
        derivedSignals: { fireCandidates },
      };
    }
    return {
      sourceName: "NIFC WFIGS Current Interagency Fire Perimeters",
      sourceKey: "wfigs",
      sourceUrl: wfigsLayerUrl,
      status: "delayed",
      fetchedAt: now.toISOString(),
      sourceUpdatedAt: incident.selectedFire.perimeterUpdated,
      stale: true,
      freshnessLabel: "No current perimeter",
      detail: selectedCurrentContext
        ? "The selected WFIGS fire perimeter is no longer published for this county. No replacement fire context was fabricated."
        : "No current WFIGS fire perimeter intersects this county. No replacement fire context was fabricated.",
      coverageStatus: "not_available",
      warnings: [
        selectedCurrentContext
          ? "The selected WFIGS perimeter is no longer available. Choose another published fire candidate."
          : "No current WFIGS perimeter found for the selected county.",
      ],
      rawPayload: { featureCount: payload.features?.length ?? 0, fireCandidates },
      derivedSignals: {
        fireName: selectedCurrentContext
          ? "Selected WFIGS perimeter no longer available"
          : "No current WFIGS perimeter found",
        fireAcres: 0,
        fireUpdatedAt: now.toISOString(),
        fireSource: "NIFC WFIGS current perimeter query",
        fireSourceKey: "wfigs",
        fireSourceUrl: wfigsLayerUrl,
        fireSourceFeatureId: selectedCurrentContext ? null : undefined,
        fireCoverageStatus: "not_available",
        fireCandidates,
        dataFreshness: 0.55,
        confidenceMultiplier: 0.76,
        reasonCodes: ["WFIGS Perimeter Not Available"],
        limitations: ["Current WFIGS perimeter coverage is unavailable for this county."],
      },
    };
  }

  const sourceUpdatedAt = fire.updatedAt ?? now.toISOString();
  return {
    sourceName: "NIFC WFIGS Current Interagency Fire Perimeters",
    sourceKey: "wfigs",
    sourceUrl: wfigsLayerUrl,
    status: "online",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt,
    stale: isOlderThan(sourceUpdatedAt, now, cacheTtlMinutes * 4),
    freshnessLabel: freshnessLabel(sourceUpdatedAt, now),
    detail: `${fire.name} perimeter context loaded from WFIGS (${Math.round(fire.acres).toLocaleString()} acres).`,
    coverageStatus: "available",
    warnings: [],
    rawPayload: {
      selectedFire: fire,
      fireCandidates,
      featureCount: payload.features?.length ?? 0,
    },
    derivedSignals: {
      fireName: fire.name,
      fireAcres: fire.acres,
      fireUpdatedAt: sourceUpdatedAt,
      fireSource: fire.source,
      fireSourceKey: fire.sourceKey,
      fireSourceUrl: wfigsLayerUrl,
      fireSourceFeatureId: fire.sourceFeatureId,
      fireCoverageStatus: "available",
      fireCandidates,
      dataFreshness: 0.88,
      confidenceMultiplier: 0.9,
      reasonCodes: ["Current Fire Perimeter"],
    },
  };
}

export async function fetchWfigsYearToDateSource(
  location: LocationCandidate,
  incident: Incident,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  const year = now.getUTCFullYear();
  const fetchImpl = options.fetchImpl ?? fetch;
  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);
  const resolved = await resolveWfigsYearToDatePayload({
    fetchImpl,
    year,
    bbox,
  });
  const fireCandidates = selectWfigsFireCandidates(
    resolved.payload.features ?? [],
    incident,
    "wfigs-ytd",
    "NIFC WFIGS Year-to-Date Fire Perimeters",
    resolved.layerUrl,
  );
  const selectedYtdContext =
    incident.selectedFire.sourceKey === "wfigs-ytd" &&
    Boolean(incident.selectedFire.sourceFeatureId);
  const fire = selectedYtdContext
    ? fireCandidates.find(
        (candidate) => candidate.sourceFeatureId === incident.selectedFire.sourceFeatureId,
      )
    : fireCandidates[0];

  if (fireCandidates.length === 0 || !fire) {
    return {
      sourceName: "NIFC WFIGS Year-to-Date Fire Perimeters",
      sourceKey: "wfigs-ytd",
      sourceUrl: resolved.layerUrl,
      status: "delayed",
      fetchedAt: now.toISOString(),
      sourceUpdatedAt: now.toISOString(),
      stale: true,
      freshnessLabel: "No YTD perimeter",
      detail:
        "No year-to-date WFIGS fire perimeter intersects this county. Recent burn-area fallback remains unavailable.",
      coverageStatus: "not_available",
      warnings: [
        selectedYtdContext
          ? "The selected year-to-date WFIGS perimeter is no longer available. Choose another published fire candidate."
          : "No year-to-date WFIGS perimeter found for the selected county.",
      ],
      rawPayload: {
        featureCount: resolved.featureCount,
        fireCandidates,
        year,
        serviceName: resolved.serviceName,
        serviceTried: resolved.layerUrl,
      },
      derivedSignals: {
        ...(selectedYtdContext
          ? {
              fireName: "Selected WFIGS year-to-date perimeter no longer available",
              fireAcres: 0,
              fireUpdatedAt: now.toISOString(),
              fireSource: "NIFC WFIGS Year-to-Date Fire Perimeters",
              fireSourceKey: "wfigs-ytd",
              fireSourceUrl: resolved.layerUrl,
              fireSourceFeatureId: null,
              fireCoverageStatus: "not_available" as const,
            }
          : {}),
        fireCandidates,
        dataFreshness: 0.58,
        confidenceMultiplier: 0.78,
        reasonCodes: ["WFIGS YTD Perimeter Not Available"],
        limitations: ["Recent WFIGS fire-perimeter fallback is unavailable for this county."],
      },
    };
  }

  const sourceUpdatedAt = fire.updatedAt ?? now.toISOString();
  return {
    sourceName: "NIFC WFIGS Year-to-Date Fire Perimeters",
    sourceKey: "wfigs-ytd",
    sourceUrl: resolved.layerUrl,
    status: "online",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt,
    stale: isOlderThan(sourceUpdatedAt, now, 24 * 60),
    freshnessLabel: freshnessLabel(sourceUpdatedAt, now),
    detail: `${fire.name} year-to-date perimeter fallback loaded from WFIGS (${Math.round(fire.acres).toLocaleString()} acres).`,
    coverageStatus: "available",
    warnings: [],
    rawPayload: {
      selectedFire: fire,
      fireCandidates,
      featureCount: resolved.featureCount,
      year,
      serviceName: resolved.serviceName,
    },
    derivedSignals: {
      ...(selectedYtdContext
        ? {
            fireName: fire.name,
            fireAcres: fire.acres,
            fireUpdatedAt: fire.updatedAt,
            fireSource: fire.source,
            fireSourceKey: fire.sourceKey,
            fireSourceUrl: fire.sourceUrl,
            fireSourceFeatureId: fire.sourceFeatureId,
            fireCoverageStatus: "available" as const,
          }
        : {}),
      fireCandidates,
      dataFreshness: 0.78,
      confidenceMultiplier: 0.84,
      reasonCodes: ["Recent Fire Perimeter Fallback"],
    },
  };
}

export async function fetchFirmsSource(
  location: LocationCandidate,
  options: {
    fetchImpl?: FetchLike;
    now?: Date;
    firmsMapKey?: string;
    firmsSource?: string;
  } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  const key = options.firmsMapKey?.trim();
  if (!key) {
    return {
      sourceName: "NASA FIRMS Active Fire",
      sourceKey: "firms",
      sourceUrl: "https://firms.modaps.eosdis.nasa.gov/api/area/",
      status: "delayed",
      fetchedAt: now.toISOString(),
      sourceUpdatedAt: now.toISOString(),
      stale: true,
      freshnessLabel: "MAP_KEY required",
      detail: "NASA FIRMS hotspot context is disabled until a MAP_KEY is configured.",
      coverageStatus: "not_available",
      warnings: ["NASA_FIRMS_MAP_KEY is not configured."],
      rawPayload: { configured: false },
      derivedSignals: {
        fireHotspotCount: 0,
        dataFreshness: 0.45,
        confidenceMultiplier: 0.72,
        reasonCodes: ["FIRMS Key Missing"],
        limitations: ["Active fire hotspot context is unavailable without a NASA FIRMS MAP_KEY."],
      },
    };
  }

  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);
  const source = normalizeFirmsSource(options.firmsSource);
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/${bbox.join(",")}/3`;
  let text: string;
  try {
    text = await fetchTextWithRetry(url, {
      fetchImpl: options.fetchImpl ?? fetch,
    });
  } catch {
    // Provider and transport errors can contain the private request URL.
    throw new Error("NASA FIRMS request failed. Verify the server MAP_KEY and provider availability.");
  }
  const rows = parseFirmsCsv(text);
  const latest = latestFirmsDate(rows) ?? now.toISOString();

  return {
    sourceName: "NASA FIRMS Active Fire",
    sourceKey: "firms",
    sourceUrl: FIRMS_PUBLIC_SOURCE_URL,
    status: "online",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: latest,
    stale: rows.length === 0,
    freshnessLabel: rows.length > 0 ? freshnessLabel(latest, now) : "No recent hotspots",
    detail:
      rows.length > 0
        ? `${rows.length} FIRMS hotspot${rows.length === 1 ? "" : "s"} found in the county area.`
        : "No FIRMS hotspots found in the county area over the last 3 days.",
    coverageStatus: rows.length > 0 ? "available" : "not_available",
    warnings: [],
    rawPayload: {
      hotspotCount: rows.length,
      latest,
      source,
      sensors: [...new Set(rows.map((row) => row.satellite).filter(Boolean))],
      sample: rows.slice(0, 10),
    },
    derivedSignals: {
      fireHotspotCount: rows.length,
      dataFreshness: rows.length > 0 ? 0.9 : 0.65,
      confidenceMultiplier: 0.88,
      reasonCodes: rows.length > 0 ? ["Recent Active Fire Hotspots"] : [],
    },
  };
}

async function resolveWfigsYearToDatePayload({
  fetchImpl,
  year,
  bbox,
}: {
  fetchImpl: FetchLike;
  year: number;
  bbox: [number, number, number, number];
}): Promise<{
  payload: { features?: WfigsFeature[]; error?: ArcgisError };
  serviceName: string;
  layerUrl: string;
  featureCount: number;
}> {
  let lastError: unknown = new Error("WFIGS year-to-date service unavailable.");
  const candidateServices = [...wfigsYtdServiceNames, `WFIGS_${year}_Interagency_Fire_Perimeters_to_Date`];

  for (const serviceName of candidateServices) {
    const layerUrl = `${wfigsYtdServiceBase}/${serviceName}/FeatureServer/0/query`;
    const url = new URL(layerUrl);
    url.searchParams.set("f", "json");
    url.searchParams.set("where", "1=1");
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("geometry", bbox.join(","));
    url.searchParams.set("geometryType", "esriGeometryEnvelope");
    url.searchParams.set("inSR", "4326");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    url.searchParams.set("resultRecordCount", "10");

    try {
      const payload = await fetchJsonWithRetry<{
        features?: WfigsFeature[];
        error?: ArcgisError;
      }>(url, { fetchImpl });
      if (payload.error) {
        lastError = new Error(
          `ArcGIS query failed for ${layerUrl}: ${payload.error.message ?? `code ${payload.error.code}`}`,
        );
        continue;
      }
      return {
        payload,
        serviceName,
        layerUrl,
        featureCount: payload.features?.length ?? 0,
      };
    } catch (error) {
      lastError = error;
    }
  }

  const fallbackUrl = `${wfigsYtdServiceBase}/WFIGS_${year}_Interagency_Fire_Perimeters_to_Date/FeatureServer/0/query`;
  const message = lastError instanceof Error ? lastError.message : "Unknown WFIGS YTD failure.";
  throw new Error(`${fallbackUrl}: ${message}`);
}

export async function fetchPwfdfSource(
  location: LocationCandidate,
  incident: Incident,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);

  try {
    const locationsUrl = new URL(buildPwfdfLocationsUrl(bbox));
    const locationsPayload = await fetchArcgisInventory(locationsUrl.origin + locationsUrl.pathname, bbox,
      { fetchImpl, outFields: locationsUrl.searchParams.get("outFields")! });
    const assessment = selectPwfdfAssessment(
      locationsPayload,
      incident.selectedFire.name,
    );
    if (!assessment) {
      return buildPwfdfUnavailableResult(
        location,
        `No exact USGS PWFDF assessment match was found for ${incident.selectedFire.name}.`,
        now,
      );
    }
    if (!publicationTimeIsValid(assessment.assessmentDate, now)) {
      throw new PwfdfDiscoveryError("pwfdf_time_invalid");
    }
    const basinsPayload = await fetchJsonWithRetry<unknown>(
      buildPwfdfBasinsUrl(assessment.fireId),
      { fetchImpl },
    );
    const basins = parsePwfdfBasins(basinsPayload, assessment);
    if (basins.some(basin => !publicationTimeIsValid(basin.assessmentDate, now))) {
      throw new PwfdfDiscoveryError("pwfdf_time_invalid");
    }
    const stale = isOlderThan(assessment.assessmentDate, now, 365 * 24 * 60);
    const hazardCounts = basins.reduce<Record<string, number>>((counts, basin) => {
      counts[basin.combinedHazard] = (counts[basin.combinedHazard] ?? 0) + 1;
      return counts;
    }, {});
    const sourceUrl = assessment.scienceBaseUrl ??
      "https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer/4";
    const warnings = stale
      ? ["The matched PWFDF assessment is older than one year; confirm its operational relevance."]
      : [];
    warnings.push("A normalized-name candidate is not verified cross-provider fire identity. An authoritative crosswalk or authorized reviewer confirmation is still required.");
    return {
      sourceName: "USGS PWFDF Assessment",
      sourceKey: "usgs-pwfdf",
      sourceUrl,
      status: "online",
      fetchedAt: now.toISOString(),
      sourceUpdatedAt: assessment.assessmentDate,
      sourceTimeBasis: "provider",
      stale,
      freshnessLabel: freshnessLabel(assessment.assessmentDate, now),
      detail: `Loaded ${basins.length} validated USGS PWFDF combined-hazard basin polygon${basins.length === 1 ? "" : "s"} for ${assessment.fireName} (${assessment.fireId}).`,
      coverageStatus: "available",
      warnings,
      rawPayload: {
        available: true,
        linkageVersion: PWFDF_LINKAGE_VERSION,
        geometryVersion: PWFDF_GEOMETRY_VERSION,
        analysisGeometryVersion: PWFDF_ANALYSIS_GEOMETRY_VERSION,
        assessmentDiscovery: locationsPayload.inventory,
        selectedFire: {
          name: incident.selectedFire.name,
          sourceKey: incident.selectedFire.sourceKey,
          sourceFeatureId: incident.selectedFire.sourceFeatureId,
        },
        assessment,
        basinCount: basins.length,
        hazardCounts,
        basins,
      },
      derivedSignals: {
        confidenceMultiplier: stale ? 0.82 : 0.96,
        dataFreshness: stale ? 0.65 : 0.92,
        reasonCodes: ["USGS PWFDF Basin Hazard"],
        limitations: [
          "PWFDF classes are screening-level estimates for published design rainfall scenarios; field validation remains required.",
          ...warnings,
        ],
      },
    };
  } catch (error) {
    const failureCode = error instanceof PwfdfDiscoveryError || error instanceof PwfdfGeometryError ? error.code :
      error instanceof ArcgisInventoryError ? `pwfdf_inventory_${error.code}` : "pwfdf_unavailable";
    const reason = error instanceof PwfdfDiscoveryError || error instanceof ArcgisInventoryError || error instanceof PwfdfGeometryError ? error.message :
      "PWFDF lookup is unavailable. Verify provider connectivity and its assessment/basin contract, then retry; no replacement evidence was used.";
    console.warn("[fireafter] PWFDF assessment unavailable", { operation: "assessment_discovery", code: failureCode });
    const unavailable = buildPwfdfUnavailableResult(
      location,
      reason,
      now,
    );
    return { ...unavailable, rawPayload: { ...unavailable.rawPayload, failureCode } };
  }
}

export async function fetchTigerRoadsSource(
  location: LocationCandidate,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (location.sourceKey === "tigerweb-counties" && location.boundary === undefined) throw new ArcgisInventoryError("invalid_geometry");
  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);
  const settled = await Promise.allSettled(
    tigerRoadLayerUrls.map((layerUrl) =>
      fetchArcgisLineLayer(layerUrl, bbox, {
        fetchImpl,
        outFields: "OBJECTID,OID,NAME,BASENAME,MTFCC,RTTYP",
        boundary: location.boundary,
      }),
    ),
  );
  const successful = settled.filter(
    (item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchArcgisLineLayer>>> =>
      item.status === "fulfilled",
  );
  if (successful.length === 0) {
    const firstError = settled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    throw firstError?.reason ?? new Error("TIGERweb road query failed");
  }

  const features = uniqueLineFeatures(successful.flatMap((item) => item.value.features));
  const partial = successful.length !== tigerRoadLayerUrls.length;

  return {
    sourceName: "Census TIGERweb Transportation Roads",
    sourceKey: "tiger-roads",
    sourceUrl: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer",
    status: partial ? "delayed" : "online",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: now.toISOString(),
    stale: features.length === 0,
    freshnessLabel: features.length > 0 ? "Just now" : "No road features",
    detail:
      features.length > 0
        ? `${features.length} TIGERweb road feature${features.length === 1 ? "" : "s"} loaded for asset inference.`
        : `No TIGERweb road features intersect the ${location.boundary !== undefined ? "verified county boundary" : "stored study extent"}.`,
    coverageStatus: features.length > 0 ? (partial ? "partial" : "available") : "not_available",
    warnings: [
      ...(partial ? ["One or more TIGERweb transportation layers failed or timed out."] : []),
      ...settled.flatMap((item) => item.status === "rejected" && item.reason instanceof ArcgisInventoryError ? [item.reason.message] : []),
      ...(features.length === 0 ? ["No source-backed road geometries were available for this county."] : []),
    ],
    rawPayload: {
      featureCount: features.length,
      features: compactLineFeatures(features),
      geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
      layerUrls: tigerRoadLayerUrls,
      inventoryComplete: !partial,
      inventories: successful.map((item) => item.value.inventory),
    },
    derivedSignals: {
      dataFreshness: features.length > 0 ? 0.85 : 0.5,
      confidenceMultiplier: features.length > 0 ? 0.86 : 0.68,
      reasonCodes: features.length > 0 ? ["Official Road Geometry"] : ["Road Geometry Not Available"],
      limitations:
        features.length > 0
          ? ["TIGERweb roads identify road geometry, not verified culvert ownership or condition."]
          : ["Road/crossing candidates cannot be inferred without transportation geometry."],
    },
  };
}

export async function fetch3dhpFlowlinesSource(
  location: LocationCandidate,
  options: { fetchImpl?: FetchLike; now?: Date; checkpoint?: ArcgisCheckpointStore } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  if (location.sourceKey === "tigerweb-counties" && location.boundary === undefined) throw new ArcgisInventoryError("invalid_geometry");
  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);
  const { features, inventory } = await fetchArcgisLineLayer(hydroFlowlineLayerUrl, bbox, {
    fetchImpl: options.fetchImpl ?? fetch,
    outFields: "OBJECTID,id3dhp,gnisidlabel,featuretypelabel,streamorder",
    checkpoint: options.checkpoint,
    boundary: location.boundary,
  });

  return {
    sourceName: "USGS 3DHP Flowlines",
    sourceKey: "3dhp-flowlines",
    sourceUrl: "https://hydro.nationalmap.gov/arcgis/rest/services/3DHP_all/MapServer/50",
    status: "online",
    fetchedAt: options.checkpoint ? inventory.startedAt : now.toISOString(),
    sourceUpdatedAt: options.checkpoint ? inventory.startedAt : now.toISOString(),
    stale: features.length === 0,
    freshnessLabel: features.length > 0 ? "Just now" : "No flowlines",
    detail:
      features.length > 0
        ? `${features.length} USGS 3DHP flowline feature${features.length === 1 ? "" : "s"} loaded for crossing inference.`
        : `No USGS 3DHP flowlines intersect the ${inventory.geometryHash ? "verified county boundary" : "stored study extent"}.`,
    coverageStatus: features.length > 0 ? "available" : "not_available",
    warnings: features.length > 0 ? [] : ["No source-backed hydrography was available for this county."],
    rawPayload: {
      featureCount: features.length,
      features: compactLineFeatures(features),
      geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
      inventoryComplete: true,
      inventory,
    },
    derivedSignals: {
      dataFreshness: features.length > 0 ? 0.82 : 0.5,
      confidenceMultiplier: features.length > 0 ? 0.84 : 0.68,
      reasonCodes: features.length > 0 ? ["Official Hydrography"] : ["Hydrography Not Available"],
      limitations:
        features.length > 0
          ? ["3DHP flowlines support screening-level crossing inference; field verification is still required."]
          : ["Road/stream crossing candidates cannot be inferred without hydrography."],
    },
  };
}

export async function fetchEpqsSource(
  location: LocationCandidate,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  const [lon, lat] = location.centroid;
  const fetchImpl = options.fetchImpl ?? fetch;
  let elevationMeters: number | undefined;
  let usedBatchFallback = false;
  try {
    elevationMeters = await fetchEpqsElevationMeters(lon, lat, fetchImpl);
  } catch {
    assertRefreshOperationActive();
  }
  if (elevationMeters === undefined) {
    usedBatchFallback = true;
    try {
      const elevationAt = await fetchElevationBatch([[lon, lat]], fetchImpl, new AbortController().signal);
      elevationMeters = elevationAt([lon, lat]);
    } catch (error) {
      assertRefreshOperationActive();
      if (!(error instanceof InventoryCapacityError) || error.code === "elevation_invalid") throw error;
    }
  }
  const sourceName = usedBatchFallback ? "USGS 3DEP Elevation Samples" : "USGS Elevation Point Query Service";
  const sourceUrl = usedBatchFallback ? ELEVATION_BATCH_URL : "https://epqs.nationalmap.gov/v1/docs";

  if (elevationMeters === undefined) {
    return {
      sourceName,
      sourceKey: "usgs-epqs",
      sourceUrl,
      status: "delayed",
      fetchedAt: now.toISOString(),
      sourceUpdatedAt: now.toISOString(),
      sourceTimeBasis: "retrieval",
      stale: true,
      freshnessLabel: "No elevation sample",
      detail: "USGS elevation endpoints did not return a usable county-centroid sample within their bounded checks.",
      coverageStatus: "not_available",
      warnings: ["County-centroid elevation is unavailable; no zero elevation or slope was assumed."],
      rawPayload: { centroid: location.centroid },
      derivedSignals: {
        dataFreshness: 0.58,
        confidenceMultiplier: 0.78,
        reasonCodes: ["DEM Elevation Proxy Not Available"],
        limitations: ["DEM/elevation slope proxy is unavailable for this refresh."],
      },
    };
  }

  return {
    sourceName,
    sourceKey: "usgs-epqs",
    sourceUrl,
    status: "online",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: now.toISOString(),
    sourceTimeBasis: "retrieval",
    stale: false,
    freshnessLabel: "Just now",
    detail: `${usedBatchFallback ? "3DEP" : "EPQS"} county-centroid elevation sample loaded (${round(elevationMeters, 1)} meters). This is elevation context, not an asset slope measurement.`,
    coverageStatus: "available",
    warnings: usedBatchFallback ? ["EPQS was unavailable or returned no usable sample; a coordinate-validated USGS 3DEP sample was used."] : [],
    rawPayload: {
      centroid: location.centroid,
      elevationMeters: round(elevationMeters, 1),
      sampleProvider: usedBatchFallback ? "3dep" : "epqs",
    },
    derivedSignals: {
      dataFreshness: 0.86,
      confidenceMultiplier: 0.86,
      reasonCodes: ["DEM Elevation Proxy"],
      limitations: [
        "A county-centroid elevation is context only. Asset slope requires separate paired samples; neither is a full raster hydrologic model.",
      ],
    },
  };
}

export async function fetchMtbsBurnSeveritySource(
  location: LocationCandidate,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);
  const url = new URL(mtbsBurnedAreaLayerUrl);
  url.searchParams.set("f", "json");
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "objectid,fire_id,fire_name,year,acres,irwinid");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("geometry", bbox.join(","));
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("resultRecordCount", "10");

  const payload = await fetchJsonWithRetry<{
    features?: Array<{ attributes?: Record<string, unknown> }>;
    exceededTransferLimit?: boolean; error?: ArcgisError;
  }>(url, { fetchImpl: options.fetchImpl ?? fetch });
  if (payload.error || !Array.isArray(payload.features)) {
    throw new Error("MTBS boundary inventory is unavailable or has an invalid response.");
  }
  const features = payload.features.map((feature) => {
    const attrs = feature.attributes ?? {};
    return {
      id: numberValue(attrs.objectid), fireId: stringValue(attrs.fire_id),
      name: stringValue(attrs.fire_name), year: numberValue(attrs.year),
      acres: numberValue(attrs.acres), irwinId: stringValue(attrs.irwinid),
    };
  });
  // This verified provider layer contains boundaries, not severity acreage measurements.
  const warning = "Incident burn severity is unavailable. The configured MTBS boundary layer does not supply severity measurements or a verified selected-fire link. Integrate a validated, fire-linked MTBS severity raster/statistics contract before using this signal.";
  return {
    sourceName: "MTBS Burned-Area Boundary Context",
    sourceKey: "mtbs-burn-severity",
    sourceUrl: mtbsBurnedAreaLayerUrl.replace("/query", ""),
    status: "delayed",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: "",
    sourceTimeBasis: "unknown",
    stale: true,
    freshnessLabel: "Severity measurements unavailable",
    detail: features.length
      ? `${features.length} county-intersecting MTBS boundary records sampled; not attributed to the selected fire and not burn-severity measurements.`
      : "No MTBS boundary records returned for this county query; incident severity remains unavailable.",
    coverageStatus: "not_available",
    warnings: [warning, ...(payload.exceededTransferLimit ? ["MTBS county boundary sample is truncated; it is not a complete inventory."] : [])],
    rawPayload: {
      interpretationVersion: MTBS_INTERPRETATION_VERSION,
      attribution: "county-context-only", measurementStatus: "unavailable",
      inventoryComplete: false, returnedCount: features.length, sample: features,
    },
    derivedSignals: {
      reasonCodes: ["MTBS Burn Severity Not Available"],
      limitations: [warning],
    },
  };
}

export async function fetchNbiBridgeSource(
  location: LocationCandidate,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);
  const { features, inventory } = await fetchArcgisPointLayer(nbiBridgeLayerUrl, bbox, {
    fetchImpl: options.fetchImpl ?? fetch,
    outFields:
      "OBJECTID,STRUCTURE_NUMBER_008,FACILITY_CARRIED_007,FEATURES_DESC_006A,LOCATION_009",
  });
  const assets = features.map((feature) => {
    const attrs = feature.attributes;
    const road =
      stringValue(attrs.FACILITY_CARRIED_007) ??
      stringValue(attrs.ROUTE_NUMBER_005D) ??
      "Unnamed route";
    const crossed =
      stringValue(attrs.FEATURES_DESC_006A) ??
      stringValue(attrs.FEATURE_INTERSECTED_006) ??
      stringValue(attrs.LOCATION_009) ??
      "mapped crossing";
    const id = feature.id;
    return {
      name: `${road} bridge @ ${crossed}`,
      type: "Bridge" as const,
      locationLabel: crossed,
      coordinates: feature.coordinates,
      source: "FHWA/BTS National Bridge Inventory",
      confidence: "High" as const,
      localOrUploaded: false,
      origin: "source" as const,
      sourceKey: "fhwa-nbi-bridges",
      sourceUrl: "https://geodata.bts.gov/maps/usdot::national-bridge-inventory/about",
      sourceFeatureId: id,
      coverageStatus: "available" as CoverageStatus,
      confidenceReason: "Official FHWA/BTS NBI bridge point inside the county extent.",
      evidence: [
        {
          sourceKey: "fhwa-nbi-bridges",
          sourceName: "FHWA/BTS National Bridge Inventory",
          sourceUrl: "https://geodata.bts.gov/maps/usdot::national-bridge-inventory/about",
          sourceFeatureId: id,
          summary: `${road} bridge record from the National Bridge Inventory.`,
        },
      ] satisfies Evidence[],
      road,
      stream: crossed,
      metrics: {
        downstreamExposure: 0.72,
        roadClass: "bridge",
      },
    };
  });

  return {
    sourceName: "FHWA/BTS National Bridge Inventory",
    sourceKey: "fhwa-nbi-bridges",
    sourceUrl: "https://geodata.bts.gov/maps/usdot::national-bridge-inventory/about",
    status: "online",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: now.toISOString(),
    stale: assets.length === 0,
    freshnessLabel: assets.length > 0 ? "Just now" : "No bridges",
    detail:
      assets.length > 0
        ? `${assets.length} NBI bridge candidate${assets.length === 1 ? "" : "s"} loaded.`
        : "No NBI bridge candidates returned inside the county bounding box.",
    coverageStatus: assets.length > 0 ? "available" : "not_available",
    warnings: assets.length > 0 ? [] : ["No FHWA/BTS NBI bridge candidates loaded for this county."],
    rawPayload: {
      featureCount: assets.length,
      assets,
      inventoryComplete: true,
      inventory,
    },
    derivedSignals: {
      dataFreshness: assets.length > 0 ? 0.82 : 0.56,
      confidenceMultiplier: assets.length > 0 ? 0.88 : 0.76,
      reasonCodes: assets.length > 0 ? ["Official Bridge Inventory"] : ["Bridge Inventory Not Available"],
      limitations:
        assets.length > 0
          ? ["NBI bridge points support exposure screening; bridge condition still requires source-specific review."]
          : ["Bridge exposure is unavailable without NBI or local bridge inventory coverage."],
    },
  };
}

export async function fetchTnmStructuresSource(
  location: LocationCandidate,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<LiveSourceResult> {
  const now = options.now ?? new Date();
  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);
  const [hospitalResult, fireResult] = await Promise.allSettled([
    fetchArcgisPointLayer(tnmStructureLayerUrls.hospital, bbox, {
      fetchImpl: options.fetchImpl ?? fetch,
      outFields: "OBJECTID,NAME,ADDRESS,CITY,STATE,FCODE,FTYPE",
    }),
    fetchArcgisPointLayer(tnmStructureLayerUrls.fire, bbox, {
      fetchImpl: options.fetchImpl ?? fetch,
      outFields: "OBJECTID,NAME,ADDRESS,CITY,STATE,FCODE,FTYPE",
    }),
  ]);
  const hospitalFeatures = hospitalResult.status === "fulfilled" ? hospitalResult.value.features : [];
  const fireFeatures = fireResult.status === "fulfilled" ? fireResult.value.features : [];
  if (hospitalResult.status === "rejected" && fireResult.status === "rejected") {
    throw hospitalResult.reason ?? fireResult.reason ?? new Error("TNM Structures query failed");
  }

  const assets = [
    ...hospitalFeatures.map((feature) => tnmStructureAsset(feature, "hospital")),
    ...fireFeatures.map((feature) => tnmStructureAsset(feature, "fire")),
  ];
  const partial = hospitalResult.status === "rejected" || fireResult.status === "rejected";

  return {
    sourceName: "USGS TNM Structures",
    sourceKey: "tnm-structures",
    sourceUrl: "https://carto.nationalmap.gov/arcgis/rest/services/structures/mapserver",
    status: partial ? "delayed" : "online",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: now.toISOString(),
    stale: assets.length === 0,
    freshnessLabel: assets.length > 0 ? "Just now" : "No structures",
    detail:
      assets.length > 0
        ? `${assets.length} TNM hospital/fire/EMS critical facilit${assets.length === 1 ? "y" : "ies"} loaded.`
        : "No TNM hospital/fire/EMS structures returned inside the county bounding box.",
    coverageStatus: assets.length > 0 ? (partial ? "partial" : "available") : "not_available",
    warnings: [
      ...(partial ? ["One TNM Structures layer failed or timed out."] : []),
      ...[hospitalResult, fireResult].flatMap((item) => item.status === "rejected" && item.reason instanceof ArcgisInventoryError ? [item.reason.message] : []),
      ...(assets.length === 0 ? ["No USGS TNM critical-facility candidates loaded for this county."] : []),
    ],
    rawPayload: {
      featureCount: assets.length,
      assets,
      inventoryComplete: !partial,
      inventories: {
        hospital: hospitalResult.status === "fulfilled" ? hospitalResult.value.inventory : null,
        fire: fireResult.status === "fulfilled" ? fireResult.value.inventory : null,
      },
    },
    derivedSignals: {
      dataFreshness: assets.length > 0 ? 0.82 : 0.56,
      confidenceMultiplier: assets.length > 0 ? 0.86 : 0.76,
      reasonCodes: assets.length > 0 ? ["Critical Facility Exposure"] : ["Critical Facilities Not Available"],
      limitations:
        assets.length > 0
          ? ["TNM Structures identifies selected public facilities; local critical-infrastructure uploads can improve coverage."]
          : ["Critical-facility exposure is unavailable without TNM Structures or local facility uploads."],
    },
  };
}

export function computeRainfallThreatFromGridData(gridData: unknown, now: Date = new Date()) {
  const properties = gridData && typeof gridData === "object"
    ? (gridData as Record<string, unknown>).properties : undefined;
  const precipitation = properties && typeof properties === "object"
    ? (properties as Record<string, unknown>).quantitativePrecipitation : undefined;
  const quantity = precipitation && typeof precipitation === "object"
    ? precipitation as Record<string, unknown> : undefined;
  if (quantity?.uom !== "wmoUnit:mm" || !Array.isArray(quantity.values)) {
    return unavailableRainfall("NWS precipitation units or data are missing/unsupported; no dry-weather value is assumed.");
  }
  const values = nwsQuantitativePrecipitationValues(gridData);
  const nowMs = now.getTime();
  const cutoffMs = nowMs + 48 * 60 * 60 * 1000;
  if (!Number.isFinite(nowMs) || values.length !== quantity.values.length || values.length === 0) {
    return unavailableRainfall("NWS precipitation entries are empty or malformed; refresh or check the provider contract.");
  }
  const windows = values.map((item) => {
    const window = parseNwsValidTimeWindow(item.validTime);
    return window ? { ...window, value: item.value } : null;
  });
  if (windows.some((window) => window === null)) {
    return unavailableRainfall("NWS precipitation contains invalid time intervals.");
  }
  const relevant = windows.filter((window) => window !== null)
    .filter((window) => window.endMs > nowMs && window.startMs < cutoffMs)
    .sort((a, b) => a.startMs - b.startMs);
  let coveredUntil = nowMs;
  let previousEnd = -Infinity;
  let totalMm = 0;
  for (const window of relevant) {
    if (window.startMs > coveredUntil || window.startMs < previousEnd ||
      typeof window.value !== "number" || !Number.isFinite(window.value) || window.value < 0) {
      return unavailableRainfall("NWS 48-hour rainfall coverage has gaps, overlapping intervals, or missing/invalid measurements.");
    }
    // A nonzero accumulation straddling the horizon cannot be prorated without inventing rainfall timing.
    if ((window.startMs < nowMs || window.endMs > cutoffMs) && window.value !== 0) {
      return unavailableRainfall("NWS rainfall intervals cross the rolling 48-hour boundary; an exact total is unavailable without finer time resolution.");
    }
    totalMm += window.value;
    previousEnd = window.endMs;
    coveredUntil = window.endMs;
  }
  if (coveredUntil < cutoffMs) {
    return unavailableRainfall("NWS precipitation does not cover the complete next 48 hours; missing coverage is not dry weather.");
  }
  const totalInches = totalMm / 25.4;
  const rainfallThreat = clamp(totalInches / 2.5);

  return {
    totalInches: round(totalInches, 2),
    rainfallThreat: round(rainfallThreat, 3),
    validUntil: new Date(coveredUntil).toISOString(),
    warning: undefined,
    label:
      totalInches > 0
        ? `${round(totalInches, 2).toFixed(2)} in forecast total rainfall`
        : "No measurable rainfall in NWS grid",
  };
}

function unavailableRainfall(warning: string) {
  return {
    totalInches: undefined, rainfallThreat: undefined, validUntil: undefined,
    label: "48-hour rainfall unavailable", warning,
  };
}

function parseNwsValidTimeWindow(validTime: string) {
  if (validTime.split("/").length !== 2) return null;
  const [startText, durationText] = validTime.split("/");
  const startMs = Date.parse(startText ?? "");
  const durationMs = parseIsoDurationMs(durationText);
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) return null;

  return {
    startMs,
    endMs: startMs + durationMs,
  };
}

function parseIsoDurationMs(duration: string | undefined) {
  if (!duration) return 0;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
    duration,
  );
  if (!match) return 0;

  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return (
    Number(days) * 24 * 60 * 60 * 1000 +
    Number(hours) * 60 * 60 * 1000 +
    Number(minutes) * 60 * 1000 +
    Number(seconds) * 1000
  );
}

export function parseFirmsCsv(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /^No fires found/i.test(trimmed)) return [];
  const [headerLine, ...lines] = trimmed.split(/\r?\n/);
  const headers = headerLine.split(",").map((header) => header.trim());
  return lines
    .filter(Boolean)
    .map((line) => {
      const values = line.split(",").map((value) => value.trim());
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    });
}

export function selectWfigsFireContext(
  features: WfigsFeature[],
  incident: Incident,
) {
  const candidates = selectWfigsFireCandidates(features, incident);
  const preferredId =
    incident.selectedFire.sourceKey === "wfigs"
      ? incident.selectedFire.sourceFeatureId
      : undefined;

  if (preferredId) {
    return candidates.find((candidate) => candidate.sourceFeatureId === preferredId) ?? null;
  }
  return candidates[0] ?? null;
}

export async function resolveWfigsFireCandidate(
  location: LocationCandidate,
  incident: Incident,
  input: { sourceKey: "wfigs" | "wfigs-ytd"; sourceFeatureId: string },
  options: { fetchImpl?: FetchLike; now?: Date } = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bbox = location.bbox ?? bboxAroundCentroid(location.centroid);
  let features: WfigsFeature[] = [];
  let sourceName = "NIFC WFIGS Current Interagency Fire Perimeters";
  let sourceUrl = wfigsLayerUrl;

  if (input.sourceKey === "wfigs") {
    const url = new URL(wfigsLayerUrl);
    url.searchParams.set("f", "json");
    url.searchParams.set("where", "1=1");
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("geometry", bbox.join(","));
    url.searchParams.set("geometryType", "esriGeometryEnvelope");
    url.searchParams.set("inSR", "4326");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    url.searchParams.set("resultRecordCount", "10");
    const payload = await fetchJsonWithRetry<{ features?: WfigsFeature[]; error?: ArcgisError }>(
      url,
      { fetchImpl },
    );
    if (payload.error) throw new Error("WFIGS current perimeter query returned an error.");
    features = payload.features ?? [];
  } else {
    const resolved = await resolveWfigsYearToDatePayload({
      fetchImpl,
      year: (options.now ?? new Date()).getUTCFullYear(),
      bbox,
    });
    features = resolved.payload.features ?? [];
    sourceName = "NIFC WFIGS Year-to-Date Fire Perimeters";
    sourceUrl = resolved.layerUrl;
  }

  const candidates = selectWfigsFireCandidates(
    features,
    incident,
    input.sourceKey,
    sourceName,
    sourceUrl,
  );
  const selected = candidates.find(
    (candidate) => candidate.sourceFeatureId === input.sourceFeatureId,
  );
  if (!selected) {
    throw new Error(
      `The selected ${input.sourceKey === "wfigs-ytd" ? "year-to-date " : "current "}WFIGS fire perimeter is no longer published. Refresh candidates and choose another perimeter.`,
    );
  }
  return selected;
}

function selectWfigsFireCandidates(
  features: WfigsFeature[],
  incident: Incident,
  sourceKey = "wfigs",
  sourceName = "NIFC WFIGS Current Interagency Fire Perimeters",
  sourceUrl = wfigsLayerUrl,
) {
  return features
    .map((feature) => {
      const attrs = feature.attributes ?? {};
      const name =
        stringValue(attrs.IncidentName) ??
        stringValue(attrs.poly_IncidentName) ??
        stringValue(attrs.irwin_IncidentName) ??
        incident.selectedFire.name;
      const acres =
        numberValue(attrs.GISAcres) ??
        numberValue(attrs.poly_GISAcres) ??
        numberValue(attrs.CalculatedAcres) ??
        incident.selectedFire.acres;
      const updatedMs =
        numberValue(attrs.DateCurrent) ??
        numberValue(attrs.poly_DateCurrent) ??
        numberValue(attrs.CreateDate) ??
        0;
      const objectId =
        stringValue(attrs.OBJECTID) ??
        stringValue(attrs.poly_IRWINID) ??
        stringValue(attrs.IRWINID) ??
        (numberValue(attrs.OBJECTID) !== undefined ? String(numberValue(attrs.OBJECTID)) : undefined);
      return {
        name,
        acres,
        perimeterUpdated:
          updatedMs > 0 ? formatDisplayDateTime(new Date(updatedMs).toISOString()) : "Unknown",
        updatedMs,
        updatedAt: updatedMs > 0 ? new Date(updatedMs).toISOString() : undefined,
        source: sourceName,
        sourceKey,
        sourceUrl,
        sourceFeatureId: objectId,
        coverageStatus: "available" as CoverageStatus,
      };
    })
    .filter((item) => item.name && item.acres > 0)
    .sort((a, b) => b.updatedMs - a.updatedMs || b.acres - a.acres);
}

export function buildPwfdfUnavailableResult(
  location: LocationCandidate,
  reason: string,
  now = new Date(),
): LiveSourceResult {
  return {
    sourceName: "USGS PWFDF Assessment",
    sourceKey: "usgs-pwfdf",
    sourceUrl: "https://www.usgs.gov/programs/landslide-hazards/science/postfire-debris-flow-hazard-assessment-data",
    status: "delayed",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: now.toISOString(),
    stale: true,
    freshnessLabel: "Not available",
    detail: `${location.county}: ${reason}. PWFDF-specific basin likelihood and volume fields are not available for this incident.`,
    coverageStatus: "not_available",
    warnings: [reason],
    rawPayload: { available: false, reason },
    derivedSignals: {
      dataFreshness: 0.5,
      confidenceMultiplier: 0.76,
      reasonCodes: ["PWFDF Not Available"],
      limitations: ["No matching USGS PWFDF assessment is available for this incident."],
    },
  };
}

async function deriveAssetsForIncident(input: {
  incident: Incident;
  existingAssets: Asset[];
  sourceResults: LiveSourceResult[];
  fetchImpl: FetchLike;
  now: Date;
  skipElevation?: boolean;
  preserveInventory?: boolean;
  crossingCheckpoint?: CrossingCheckpointStore;
  crossingMaxCandidates?: number;
}): Promise<{ assets: Asset[]; batchElevationUnavailable: boolean }> {
  const pwfdfSource = input.sourceResults.find(
    (source) => source.sourceKey === "usgs-pwfdf" && source.coverageStatus === "available",
  );
  const rawAssessment = pwfdfSource?.rawPayload.assessment;
  const assessment = rawAssessment && typeof rawAssessment === "object"
    ? rawAssessment as Parameters<typeof linkPwfdfHazardsToAssets>[1]
    : undefined;
  const basins = pwfdfBasinsFromSnapshot(pwfdfSource);
  if (pwfdfSource && basins.length === 0) throw new PwfdfGeometryError();
  if (input.preserveInventory) {
    const scope = prepareCountyScope(input.incident);
    return {
      assets: linkPwfdfHazardsToAssets(input.existingAssets.filter(asset => scope.contains(asset.coordinates)),
        assessment, basins, pwfdfSource?.sourceUrl),
      batchElevationUnavailable: false,
    };
  }
  const uploadValidationBudget = { vertices: 0, comparisons: 0 };
  const uploadedAssets = input.existingAssets
    .filter(isUploadedAsset)
    .map((asset) => projectUploadedAsset(asset, input.incident, uploadValidationBudget));
  const roadFeatures = lineFeaturesFromResult(input.sourceResults, "tiger-roads");
  const hydroFeatures = lineFeaturesFromResult(input.sourceResults, "3dhp-flowlines");
  const sourceAssets = sourceAssetsFromResults(input.incident, input.sourceResults);
  const inferredAssets =
    roadFeatures.length > 0 && hydroFeatures.length > 0
      ? input.crossingCheckpoint
        ? await inferCrossingAssetsResumable(input.incident, roadFeatures, hydroFeatures, basins, input.crossingCheckpoint,
          { maxCandidates: input.crossingMaxCandidates })
        : inferCrossingAssets(input.incident, roadFeatures, hydroFeatures, basins)
      : [];
  const scope = prepareCountyScope(input.incident);
  const candidateAssets = dedupeAssets([
    ...uploadedAssets,
    ...sourceAssets,
    ...inferredAssets,
  ]).filter(asset => scope.contains(asset.coordinates));
  const linked = linkPwfdfHazardsToAssets(
    candidateAssets,
    assessment,
    basins,
    pwfdfSource?.sourceUrl,
  );
  const ordered = [
    ...linked.filter(hasPwfdfBasinEvidence),
    ...linked.filter((asset) => !hasPwfdfBasinEvidence(asset)),
  ];

  if (input.skipElevation) return { assets: ordered, batchElevationUnavailable: true };
  return enrichAssetsWithElevation(ordered, input.fetchImpl);
}

function hasPwfdfBasinEvidence(asset: Asset) {
  return asset.evidence?.some(
    (item) =>
      item.sourceKey === "usgs-pwfdf" && Boolean(item.sourceFeatureId),
  ) ?? false;
}

export function inferCrossingAssets(
  incident: Incident,
  roads: SourceLineFeature[],
  flowlines: SourceLineFeature[],
  priorityBasins: PwfdfBasinHazard[] = [],
  limits: { maxWork?: number; maxCandidates?: number } = {},
): Asset[] {
  const spend = crossingWorkBudget(limits);
  const page = inferCrossingPage(incident, roads, flowlines, { road: 0, part: 0, pair: 0 }, 0,
    limits.maxCandidates ?? 20_000, spend, false);
  return orderCrossingCandidates(page.candidates, priorityBasins, spend);
}

export async function inferCrossingAssetsResumable(
  incident: Incident, roads: SourceLineFeature[], flowlines: SourceLineFeature[],
  priorityBasins: PwfdfBasinHazard[], checkpoint: CrossingCheckpointStore,
  limits: { maxWork?: number; maxCandidates?: number } = {},
): Promise<Asset[]> {
  crossingWorkBudget(limits, true);
  const maxCandidates = limits.maxCandidates ?? 20_000;
  const scope = createHash("sha256").update(JSON.stringify([
    maxCandidates > 20_000 ? "crossing-traversal-v2" : "crossing-traversal-v1", SOURCE_LINE_GEOMETRY_VERSION, incident.id, roads, flowlines, priorityBasins,
    limits.maxWork ?? 2_000_000, maxCandidates,
  ])).digest("hex");
  const candidates = await checkpointCrossingInference(scope, checkpoint, (next, priorCandidates) =>
    inferCrossingPage(incident, roads, flowlines, next, priorCandidates, maxCandidates, crossingWorkBudget(limits, true), true), maxCandidates);
  return orderCrossingCandidates(candidates, priorityBasins, crossingWorkBudget(limits, true));
}

function crossingWorkBudget(limits: { maxWork?: number; maxCandidates?: number }, resumable = false) {
  const maxWork = limits.maxWork ?? 2_000_000;
  const maxCandidates = limits.maxCandidates ?? 20_000;
  if (!Number.isSafeInteger(maxWork) || maxWork < 1 || maxWork > 2_000_000 ||
    !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > (resumable ? COUNTY_CROSSING_MAX_CANDIDATES : 20_000)) {
    throw new Error("Invalid crossing inference budget.");
  }
  const deadline = performance.now() + 10_000;
  let work = 0;
  return (amount = 1) => {
    work += amount;
    if (work > maxWork || performance.now() > deadline) {
      throw new InventoryCapacityError("inference_work");
    }
  };
}

function inferCrossingPage(
  incident: Incident, roads: SourceLineFeature[], flowlines: SourceLineFeature[],
  start: CrossingCursor, priorCandidates: number, maxCandidates: number,
  spend: (amount?: number) => void, resumable: boolean,
): CrossingPage {
  const next = { ...start };
  const candidates: CrossingCandidate[] = [];
  if (next.road > roads.length || (next.road === roads.length && (next.part !== 0 || next.pair !== 0))) throw new Error("crossing_cursor_invalid");
  const flowIndex = partitionFlowlineParts(flowlines.flatMap((flowline) =>
    flowline.paths.map((path, partIndex) => {
      spend(path.length);
      return { flowline, partIndex, tree: buildSegmentTree(path) };
    })), spend);
  let acknowledgedCandidates = 0;
  const paged = resumable && maxCandidates > 20_000;
  let candidateBytes = 0;
  try {
  for (; next.road < roads.length; next.road++, next.part = 0, next.pair = 0) {
    const road = roads[next.road];
    if (next.part >= road.paths.length) throw new Error("crossing_cursor_invalid");
    for (; next.part < road.paths.length; next.part++, next.pair = 0) {
      const roadPartIndex = next.part;
      const roadPath = road.paths[roadPartIndex];
      spend(roadPath.length);
      const roadTree = buildSegmentTree(roadPath);
      const pairs = [...nearbyFlowlineParts(flowIndex, roadTree.bounds, spend)];
      if (next.pair > pairs.length) throw new Error("crossing_cursor_invalid");
      for (; next.pair < pairs.length; next.pair++) {
      const { flowline, partIndex: flowPartIndex, tree } = pairs[next.pair];
      for (const nearest of crossingCoordinatePairs(roadTree, tree, spend)) {
      if (nearest.distanceMeters > 220) continue;
      if (priorCandidates + candidates.length >= maxCandidates) {
        throw new InventoryCapacityError("inference_candidates");
      }
      const roadName = road.name || road.class || "Unnamed road";
      const streamName = flowline.name || "USGS 3DHP flowline";
      const roadClass = road.class ?? "road";
      const confidence = nearest.distanceMeters <= 90 ? "Medium" : "Low";
      const exposure = exposureFromRoadClass(roadClass, nearest.distanceMeters);
      const evidence: Evidence[] = [
        {
          sourceKey: "tiger-roads",
          sourceName: "Census TIGERweb Transportation Roads",
          sourceUrl: road.sourceUrl,
          sourceFeatureId: road.id,
          sourcePartIndex: roadPartIndex,
          summary: `${roadName} road geometry from TIGERweb.`,
        },
        {
          sourceKey: "3dhp-flowlines",
          sourceName: "USGS 3DHP Flowlines",
          sourceUrl: flowline.sourceUrl,
          sourceFeatureId: flowline.id,
          sourcePartIndex: flowPartIndex,
          summary: `${streamName} flowline geometry from USGS 3DHP.`,
        },
      ];

      candidates.push({
        distanceMeters: nearest.distanceMeters,
        asset: {
          id: `asset-${incident.id}-${createHash("sha256").update(JSON.stringify([
            SOURCE_LINE_GEOMETRY_VERSION, road.sourceUrl ?? road.sourceKey, road.id, roadPartIndex,
            flowline.sourceUrl ?? flowline.sourceKey, flowline.id, flowPartIndex,
            nearest.coordinate,
          ])).digest("hex").slice(0, 32)}`,
          incidentId: incident.id,
          name: `${roadName} @ ${streamName}`,
          type: "Inferred Crossing",
          locationLabel: streamName,
          coordinates: nearest.coordinate,
          source: "Census TIGERweb roads + USGS 3DHP flowlines",
          confidence,
          localOrUploaded: false,
          geometry: { type: "Point", coordinates: nearest.coordinate },
          origin: "inferred",
          sourceKey: "tiger-roads+3dhp-flowlines",
          sourceFeatureIds: [road.id, flowline.id],
          coverageStatus: "partial",
          confidenceReason:
            "Inferred from real road and flowline geometries; not a verified culvert inventory.",
          evidence,
          metrics: {
            inferenceGeometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
            downstreamExposure: exposure,
            hydroDistanceMeters: round(nearest.distanceMeters, 1),
            roadClass,
          },
          road: roadName,
          stream: streamName,
        },
      });
      if (paged) {
        candidateBytes += Buffer.byteLength(JSON.stringify(candidates[candidates.length - 1])) + 1;
        // Reserve space for page metadata. An indivisible pair that exceeds the
        // hard page bound fails; it must never be split or silently sampled.
        if (candidates.length > COUNTY_CROSSING_PAGE_CANDIDATES || candidateBytes > COUNTY_CROSSING_PAGE_BYTES - 1024) {
          throw new InventoryCapacityError("inference_work");
        }
      }
      }
      acknowledgedCandidates = candidates.length;
      if (paged && (candidates.length >= COUNTY_CROSSING_PAGE_CANDIDATES / 2 || candidateBytes >= COUNTY_CROSSING_PAGE_BYTES / 2)) {
        next.pair++;
        return { next, candidates, complete: false };
      }
      }
    }
  }
  } catch (error) {
    if (!resumable || !(error instanceof InventoryCapacityError) || error.code !== "inference_work" ||
      (next.road === start.road && next.part === start.part && next.pair === start.pair)) throw error;
    // The unfinished pair is recomputed after resume, never published halfway.
    return { next, candidates: candidates.slice(0, acknowledgedCandidates), complete: false };
  }
  return { next, candidates, complete: true };
}

function orderCrossingCandidates(candidates: CrossingCandidate[], priorityBasins: PwfdfBasinHazard[], spend: () => void) {
  const basinBudget = geometryBudget();
  const priorityContains = priorityBasins.map(basin => prepareBasinContainment(basin.geometry, basinBudget));
  return dedupeAssets(
    candidates
      .map((candidate) => ({
        ...candidate,
          basinLinked: priorityContains.some((contains) => {
            spend();
            try { return contains(candidate.asset.coordinates); }
            catch (error) {
              if (error instanceof PwfdfGeometryError) throw new InventoryCapacityError("inference_work");
              throw error;
            }
          }),
      }))
      .sort(
        (a, b) =>
          Number(b.basinLinked) - Number(a.basinLinked) ||
          a.distanceMeters - b.distanceMeters || a.asset.id.localeCompare(b.asset.id),
      )
      .map((candidate) => candidate.asset),
  );
}

function boundsForCoordinates(coordinates: [number, number][]) {
  if (coordinates.length === 0) return null;
  const bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  for (const [longitude, latitude] of coordinates) {
    bounds.west = Math.min(bounds.west, longitude);
    bounds.south = Math.min(bounds.south, latitude);
    bounds.east = Math.max(bounds.east, longitude);
    bounds.north = Math.max(bounds.north, latitude);
  }
  return bounds;
}

export async function enrichAssetsWithElevation(
  assets: Asset[],
  fetchImpl: FetchLike,
  options: { retryTransient?: boolean } = {},
): Promise<{ assets: Asset[]; batchElevationUnavailable: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const pending = assets.filter((asset) => asset.metrics?.slopeTerrain === undefined);
  const useBatch = pending.length > 16;
  let elevationAt: ((point: readonly [number, number]) => number | undefined) | undefined;
  let batchElevationUnavailable = false;
  const withoutElevationEvidence = (asset: Asset): Asset => ({
    ...asset,
    confidence: asset.confidence === "High" ? "Medium" : asset.confidence,
    confidenceReason: `${asset.confidenceReason ?? "Asset source loaded."} USGS elevation slope proxy was unavailable for this refresh.`,
  });
  const enrich = async (asset: Asset): Promise<Asset> => {
      assertRefreshOperationActive();
      if (!batchElevationUnavailable) controller.signal.throwIfAborted();
      if (asset.metrics?.slopeTerrain !== undefined) return asset;
      try {
        const [lon, lat] = asset.coordinates;
        const [center, upstream] = useBatch ? [elevationAt?.([lon, lat]), elevationAt?.([lon, lat + 0.004])] : await Promise.all([
          fetchEpqsElevationMeters(lon, lat, fetchImpl, controller.signal),
          fetchEpqsElevationMeters(lon, lat + 0.004, fetchImpl, controller.signal),
        ]);
        if (center === undefined || upstream === undefined) {
          return batchElevationUnavailable ? withoutElevationEvidence(asset) : asset;
        }
        const elevationChangeMeters = Math.abs(upstream - center);
        const slopeTerrain = clamp(elevationChangeMeters / 70);
        return {
          ...asset,
          metrics: {
            ...asset.metrics,
            slopeTerrain: round(slopeTerrain, 3),
            elevationChangeMeters: round(elevationChangeMeters, 1),
            elevationSampleMeters: [round(center, 1), round(upstream, 1)],
            elevationSampledAt: new Date().toISOString(),
          },
          evidence: [
            ...(asset.evidence ?? []),
            {
              sourceKey: "usgs-epqs",
              sourceName: useBatch ? "USGS 3DEP batch elevation" : "USGS Elevation Point Query Service",
              sourceUrl: useBatch ? ELEVATION_BATCH_URL : "https://epqs.nationalmap.gov/v1/docs",
              summary: useBatch ? "Validated 3DEP point samples used for a screening-level slope proxy; not a hydrologic model." : "Elevation samples used for screening-level slope proxy.",
            },
          ],
        };
      } catch {
        controller.signal.throwIfAborted();
        return {
          ...asset,
          confidence: asset.confidence === "High" ? "Medium" : asset.confidence,
          confidenceReason: `${asset.confidenceReason ?? "Asset source loaded."} EPQS slope proxy was unavailable.`,
        } satisfies Asset;
      }
  };
  const enriched: Asset[] = new Array(assets.length);
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const index = next++;
      enriched[index] = await enrich(assets[index]);
    }
  };
  try {
    if (useBatch) {
      try {
        elevationAt = await fetchElevationBatch(pending.flatMap((asset) => {
          const [lon, lat] = asset.coordinates;
          return [[lon, lat], [lon, lat + 0.004]] as [number, number][];
        }), fetchImpl, controller.signal, options);
      } catch (error) {
        const transientProviderFailure = error instanceof InventoryCapacityError &&
          (error.code === "elevation_deadline" || error.code === "elevation_unavailable");
        if (!transientProviderFailure) throw error;
        // The optional elevation budget may expire without canceling the whole
        // inventory. Discard ALL batch samples; root expiry/cancellation still fails.
        assertRefreshOperationActive();
        clearTimeout(timeout);
        batchElevationUnavailable = true;
        console.warn("[fireafter] batch elevation unavailable", { code: error.code, assetCount: pending.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, assets.length) }, worker));
    console.info("[fireafter] asset inventory processed", { assetCount: assets.length, elevationWorkers: Math.min(4, assets.length) });
    return { assets: enriched, batchElevationUnavailable };
  } catch (error) {
    controller.abort();
    if (error instanceof InventoryCapacityError || error instanceof RefreshOperationError) throw error;
    throw new InventoryCapacityError("elevation_deadline");
  } finally {
    clearTimeout(timeout);
  }
}

function sourceAssetsFromResults(
  incident: Incident,
  sourceResults: LiveSourceResult[],
): Asset[] {
  return sourceResults.flatMap((source) => {
    const rawAssets = source.rawPayload.assets;
    if (!Array.isArray(rawAssets)) return [];

    return rawAssets
      .map((item): Asset | null => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const coordinates = coordinateValue(record.coordinates);
        const name = stringValue(record.name);
        const type = assetTypeValue(record.type);
        if (!coordinates || !name || !type) return null;
        const sourceFeatureId = stringValue(record.sourceFeatureId);
        const sourceKey = stringValue(record.sourceKey) ?? source.sourceKey;
        const evidence = Array.isArray(record.evidence)
          ? (record.evidence as Evidence[])
          : [
              {
                sourceKey,
                sourceName: source.sourceName,
                sourceUrl: source.sourceUrl,
                sourceFeatureId,
                summary: `${name} loaded from ${source.sourceName}.`,
              },
            ];

        return {
          id: `asset-${incident.id}-${slugify(sourceKey)}-${slugify(sourceFeatureId ?? name)}`,
          incidentId: incident.id,
          name,
          type,
          locationLabel: stringValue(record.locationLabel) ?? incident.county,
          coordinates,
          source: stringValue(record.source) ?? source.sourceName,
          confidence: confidenceValue(record.confidence) ?? "Medium",
          localOrUploaded: false,
          geometry: { type: "Point", coordinates },
          origin: "source",
          sourceKey,
          sourceUrl: stringValue(record.sourceUrl) ?? source.sourceUrl,
          sourceFeatureId,
          sourceFeatureIds: sourceFeatureId ? [sourceFeatureId] : undefined,
          coverageStatus: "available",
          confidenceReason:
            stringValue(record.confidenceReason) ??
            `Source-backed asset candidate from ${source.sourceName}.`,
          evidence,
          metrics: metricsValue(record.metrics),
          road: stringValue(record.road),
          stream: stringValue(record.stream),
        };
      })
      .filter((asset): asset is Asset => Boolean(asset));
  });
}

function oldestOnlineSourceAgeHours(
  sourceResults: LiveSourceResult[],
  now: Date,
): number {
  const ages = sourceResults
    .filter((source) => source.status === "online")
    .map((source) => Date.parse(source.sourceUpdatedAt))
    .filter((ms) => Number.isFinite(ms) && ms <= now.getTime())
    .map((ms) => (now.getTime() - ms) / 3600000);
  if (ages.length === 0) return 0;
  return Math.round(Math.max(...ages));
}

export type ScoredLiveRecommendation = Recommendation & { localOrUploaded: boolean };
export const RECOMMENDATION_PAGE_SIZE = 128;
export type LiveRecommendationContext = {
  version: 1;
  incidentId: string;
  rainfallThreat?: number;
  burnSeverity?: number;
  dataFreshness: number;
  confidenceMultiplier: number;
  scoringStaleSignals: string[];
  hasSourceWarnings: boolean;
  reasonCodes: string[];
  limitations: string[];
  sourcesUpdatedLabel: string;
  evidenceAgeHours: number;
  sourceSnapshotIds: string[];
  createdAt: string;
  sourceChangesMessage: string;
  previousByAsset: [string, PreviousRecommendationEntry][];
  previousByNameType: [string, PreviousRecommendationEntry][];
};

export function prepareLiveRecommendationContext(
  incident: Incident,
  signals: LiveSourceDerivedSignals,
  sourceResults: LiveSourceResult[],
  sourceSnapshots: SourceSnapshot[],
  now: Date,
  previousRecommendations: PreviousRecommendation[] = [],
  previousSourceSnapshots: PreviousSource[] = [],
): LiveRecommendationContext {
  const staleSignals = sourceResults
    .filter((source) => source.stale || source.status !== "online")
    .map((source) => source.sourceName);
  const scoringStaleSignals =
    staleSignals.length > 0 ? ["source freshness"] : [];
  const sourceWarnings = sourceResults.flatMap((source) => source.warnings);
  const rainfallThreat = signals.rainfallThreat;
  const burnSeverity = signals.burnSeverity;
  const dataFreshness = signals.dataFreshness ?? (staleSignals.length > 0 ? 0.6 : 0.9);
  const confidenceMultiplier =
    signals.confidenceMultiplier ?? (staleSignals.length > 0 ? 0.82 : 0.94);
  const sourcesUpdatedLabel = sourceResults
    .map((source) => source.freshnessLabel)
    .find((label) => label !== "Not available") ?? "Live refresh complete";
  const evidenceAgeHours = oldestOnlineSourceAgeHours(sourceResults, now);
  const previousRecommendationContext = mapPreviousRecommendations(previousRecommendations);
  const sourceChangeSummary = buildSourceChangeSummary(sourceResults, previousSourceSnapshots);
  const sourceChangesMessage = sourceChangeSummary
    ? `Sources updated: ${sourceChangeSummary}`
    : "";
  return {
    version: 1, incidentId: incident.id, rainfallThreat, burnSeverity, dataFreshness, confidenceMultiplier,
    scoringStaleSignals, hasSourceWarnings: sourceWarnings.length > 0,
    reasonCodes: unique([...(signals.reasonCodes ?? []), ...sourceResults.flatMap(source => source.derivedSignals.reasonCodes ?? [])]),
    limitations: unique([...(signals.limitations ?? []), ...sourceResults.flatMap(source => source.derivedSignals.limitations ?? [])]),
    sourcesUpdatedLabel, evidenceAgeHours, sourceSnapshotIds: sourceSnapshots.map(source => source.id), createdAt: now.toISOString(),
    sourceChangesMessage, previousByAsset: [...previousRecommendationContext.byAsset], previousByNameType: [...previousRecommendationContext.byNameType],
  };
}

export function createLiveRecommendationScorer(input: LiveRecommendationContext) {
  if (input.version !== 1) throw new Error("recommendation_context_invalid");
  const context = structuredClone(input);
  const { rainfallThreat, burnSeverity, dataFreshness, confidenceMultiplier, scoringStaleSignals,
    hasSourceWarnings, sourcesUpdatedLabel, evidenceAgeHours, sourceChangesMessage } = context;
  const byAsset = new Map(context.previousByAsset), byNameType = new Map(context.previousByNameType);
  const checkPage = (length: number) => {
    if (length > RECOMMENDATION_PAGE_SIZE) throw new Error("recommendation_page_capacity");
  };
  const scorePage = (incidentAssets: Asset[]): ScoredLiveRecommendation[] => {
    checkPage(incidentAssets.length);
    return incidentAssets.map((asset): ScoredLiveRecommendation => {
      const slopeTerrain = asset.metrics?.slopeTerrain;
      const downstreamExposure = asset.metrics?.downstreamExposure;
      const missingSignals = [
        ...(hasSourceWarnings ? ["live source signal"] : []),
        ...(rainfallThreat === undefined ? ["rainfall threat"] : []),
        ...(burnSeverity === undefined ? ["fire or burn severity"] : []),
        ...(slopeTerrain === undefined ? ["EPQS slope proxy"] : []),
        ...(downstreamExposure === undefined ? ["downstream exposure proxy"] : []),
        ...inventoryEvidenceGaps(asset),
      ];
      const scoreInput = {
        rainfallThreat,
        burnSeverity,
        slopeTerrain,
        downstreamExposure,
        dataFreshness,
        confidenceMultiplier,
        missingSignals,
        staleSignals: scoringStaleSignals,
        sourceReliability: scoringStaleSignals.length > 0 ? "mixed" : "official",
      } as const;
      const score = calculatePriorityScore(scoreInput);
      return {
        id: `rec-${context.incidentId}-${asset.id}`,
        incidentId: context.incidentId,
        assetId: asset.id,
        assetName: asset.name,
        assetType: asset.type,
        locationLabel: asset.locationLabel,
        coordinates: asset.coordinates,
        recommendedAction: actionForRisk(score.riskLevel, asset.type),
        finalScore: score.finalScore,
        score100: score.score100,
        riskLevel: score.riskLevel,
        confidenceLevel: score.confidenceLevel,
        reasonCodes: unique([
          ...score.reasonCodes,
          ...context.reasonCodes,
        ]),
        limitations: unique([
          ...score.limitations,
          ...context.limitations,
        ]).slice(0, 6),
        changedSinceLastRefresh: asset.localOrUploaded
          ? "Local Asset Recalculated"
          : "Source-Backed Candidate",
        localOrUploaded: asset.localOrUploaded,
        sourcesUpdatedLabel,
        dataFreshnessHours: evidenceAgeHours,
        scoreBreakdown: {
          scoringVersion: score.scoringVersion,
          scoreBasis: score.scoreBasis,
          rainfallThreat: scoreInput.rainfallThreat ?? 0,
          burnSeverity: scoreInput.burnSeverity ?? 0,
          slopeTerrain: scoreInput.slopeTerrain ?? 0,
          downstreamExposure: scoreInput.downstreamExposure ?? 0,
          dataFreshness: scoreInput.dataFreshness,
          confidenceMultiplier: score.confidenceMultiplier,
          baseScore: score.baseScore,
          finalScore: score.finalScore,
          metricStatus: {
            rainfallThreat: rainfallThreat === undefined ? "not_available" : "available",
            burnSeverity: burnSeverity === undefined ? "not_available" : "available",
            slopeTerrain: slopeTerrain === undefined ? "not_available" : "available",
            downstreamExposure: downstreamExposure === undefined ? "not_available" : "available",
            dataFreshness: scoringStaleSignals.length > 0 ? "partial" : "available",
          },
        },
        evidence: asset.evidence,
        sourceSnapshotIds: [...context.sourceSnapshotIds],
        createdAt: context.createdAt,
      } satisfies ScoredLiveRecommendation;
    });
  };
  const finalizePage = (scoredRecommendations: ScoredLiveRecommendation[], rankForId: (id: string) => number | undefined): Recommendation[] => {
    checkPage(scoredRecommendations.length);
    return scoredRecommendations.map((recommendation) => {
      const currentRank = rankForId(recommendation.id);
      if (!Number.isSafeInteger(currentRank) || currentRank! < 1) throw new Error("recommendation_rank_missing");
      const normalizedName = recommendation.assetName.trim().toLowerCase();
      const normalizedLocation = recommendation.locationLabel.trim().toLowerCase();
      const compositeKey = `${recommendation.assetType}|${normalizedName}|${normalizedLocation}`;
      const previous = byAsset.get(recommendation.assetId) ?? byNameType.get(compositeKey);
      const delta = buildChangedSinceRefreshMessage({
        recommendation,
        previous,
        currentRank: currentRank!,
        sourceChangesMessage,
        isLocalAsset: recommendation.localOrUploaded,
      });
      return {
        ...recommendation,
        changedSinceLastRefresh: delta,
      };
    });
  };
  return { scorePage, finalizePage };
}

function buildLiveRecommendations(
  incident: Incident, incidentAssets: Asset[], signals: LiveSourceDerivedSignals,
  sourceResults: LiveSourceResult[], sourceSnapshots: SourceSnapshot[], now: Date,
  previousRecommendations: PreviousRecommendation[] = [], previousSourceSnapshots: PreviousSource[] = [],
  captureContext?: (context: LiveRecommendationContext) => void,
): Recommendation[] {
  const context = prepareLiveRecommendationContext(incident, signals, sourceResults, sourceSnapshots, now,
    previousRecommendations, previousSourceSnapshots);
  const scorer = createLiveRecommendationScorer(context);
  captureContext?.(structuredClone(context));
  const scored: ScoredLiveRecommendation[] = [];
  for (let offset = 0; offset < incidentAssets.length; offset += RECOMMENDATION_PAGE_SIZE) {
    scored.push(...scorer.scorePage(incidentAssets.slice(offset, offset + RECOMMENDATION_PAGE_SIZE)));
  }
  scored.sort(compareRecommendations);
  let rank = 0;
  const result: Recommendation[] = [];
  for (let offset = 0; offset < scored.length; offset += RECOMMENDATION_PAGE_SIZE) {
    result.push(...scorer.finalizePage(scored.slice(offset, offset + RECOMMENDATION_PAGE_SIZE), () => ++rank));
  }
  return result;
}

type PreviousRecommendationEntry = {
  riskLevel: Recommendation["riskLevel"];
  score100: number;
  rank: number;
};

function mapPreviousRecommendations(recommendations: PreviousRecommendation[]) {
  const byAsset = new Map<string, PreviousRecommendationEntry>();
  const byNameType = new Map<
    string,
    PreviousRecommendationEntry
  >();

  [...recommendations]
    .sort(compareRecommendations)
    .forEach((recommendation, index) => {
      const normalizedName = recommendation.assetName.trim().toLowerCase();
      const normalizedLocation = recommendation.locationLabel.trim().toLowerCase();
      const compositeKey = `${recommendation.assetType}|${normalizedName}|${normalizedLocation}`;

      byAsset.set(recommendation.assetId, {
        riskLevel: recommendation.riskLevel,
        score100: recommendation.score100,
        rank: index + 1,
      });
      if (!byNameType.has(compositeKey)) {
        byNameType.set(compositeKey, {
          riskLevel: recommendation.riskLevel,
          score100: recommendation.score100,
          rank: index + 1,
        });
      }
    });

  return {
    byAsset,
    byNameType,
  };
}

type ChangeBuildInput = {
  recommendation: Recommendation;
  currentRank: number;
  sourceChangesMessage: string;
  previous?: PreviousRecommendationEntry;
  isLocalAsset: boolean;
};

function buildChangedSinceRefreshMessage(input: ChangeBuildInput) {
  const prior = input.previous;
  const base =
    input.isLocalAsset
      ? "Local Asset Recalculated"
      : "Source-Backed Candidate";

  if (!prior) {
    return sourceMessageWithFallback(base, input.sourceChangesMessage);
  }

  const rankDelta = prior.rank - input.currentRank;
  const movementLabel =
    rankDelta === 0
      ? "position unchanged"
      : rankDelta > 0
        ? `moved up ${rankDelta} position${rankDelta === 1 ? "" : "s"}`
        : `moved down ${Math.abs(rankDelta)} position${Math.abs(rankDelta) === 1 ? "" : "s"}`;

  const riskChanged =
    input.recommendation.riskLevel !== prior.riskLevel
      ? `risk level changed from ${prior.riskLevel} to ${input.recommendation.riskLevel}`
      : "";
  const scoreChange = prior.score100 - input.recommendation.score100;
  const scoreDeltaLabel =
    scoreChange === 0
      ? "score stable"
      : scoreChange > 0
        ? `score declined by ${scoreChange} points`
        : `score increased by ${Math.abs(scoreChange)} points`;

  const positionMessage = `At refresh: ${movementLabel} (was #${prior.rank}, now #${input.currentRank})`;
  const deltaParts = [positionMessage, riskChanged, scoreDeltaLabel].filter(Boolean);
  const deltaText = deltaParts.join(", ").replace(/,\s*$/, "");

  return sourceMessageWithFallback(`${deltaText}.`, input.sourceChangesMessage);
}

function sourceMessageWithFallback(
  base: string,
  sourceChangesMessage: string,
) {
  if (!sourceChangesMessage) return base;
  if (base === "Source-Backed Candidate" || base === "Local Asset Recalculated") {
    return `${base}. ${sourceChangesMessage}`;
  }
  return `${base} ${sourceChangesMessage}`;
}

function buildSourceChangeSummary(
  sources: LiveSourceResult[],
  previousSnapshots: PreviousSource[],
) {
  if (previousSnapshots.length === 0) return "";

  const previousByKey = new Map(
    previousSnapshots
      .filter((snapshot) => Boolean(snapshot.sourceKey))
      .map((snapshot) => [snapshot.sourceKey as string, snapshot]),
  );
  const currentByKey = new Map(
    sources.filter((source) => Boolean(source.sourceKey)).map((source) => [source.sourceKey, source]),
  );
  const changedSources: string[] = [];

  for (const [sourceKey, current] of currentByKey) {
    const previous = previousByKey.get(sourceKey);
    if (!previous) {
      changedSources.push(`${current.sourceName} added`);
      continue;
    }

    if (
      previous.status !== current.status ||
      previous.stale !== current.stale ||
      previous.freshnessLabel !== current.freshnessLabel
    ) {
      changedSources.push(
        `${current.sourceName} (${previous.status} -> ${current.status})`,
      );
    }
  }

  for (const [sourceKey, previous] of previousByKey) {
    if (!currentByKey.has(sourceKey)) {
      changedSources.push(`${previous.sourceName} missing in refresh`);
    }
  }

  if (changedSources.length === 0) return "";
  return unique(changedSources).slice(0, 4).join("; ");
}

export function applyLiveSignalsToIncident(
  incident: Incident,
  location: LocationCandidate,
  signals: LiveSourceDerivedSignals,
  sourceResults: LiveSourceResult[],
  now: Date,
): Incident {
  const limitedSources = sourceResults.filter(sourceLimitsIncidentFreshness).length;
  const dataFreshness =
    limitedSources === 0 ? "High" : limitedSources <= 2 ? "Medium" : "Low";
  const alertCoverage = sourceResults.find((source) => source.sourceKey === "nws")?.rawPayload.alertCoverageStatus;

  return {
    ...incident,
    status: limitedSources >= 3 ? "Stale Data" : "Storm Watch",
    rainfallForecast: signals.rainfallForecast ?? "Rainfall unavailable",
    lastRefresh: formatDisplayTime(now.toISOString()),
    dataFreshness,
    activeAlerts: signals.activeAlerts ?? 0,
    alertCoverageStatus: alertCoverage === "available" || alertCoverage === "partial" ? alertCoverage : "unavailable",
    locationContext: location,
    selectedFire: {
      name: signals.fireName ?? incident.selectedFire.name,
      acres: signals.fireAcres ?? incident.selectedFire.acres,
      perimeterUpdated:
        signals.fireUpdatedAt ? formatDisplayDateTime(signals.fireUpdatedAt) : incident.selectedFire.perimeterUpdated,
      source: signals.fireSource ?? incident.selectedFire.source,
      sourceKey:
        signals.fireSourceKey === null
          ? undefined
          : signals.fireSourceKey ?? (signals.fireSource ? "wfigs" : incident.selectedFire.sourceKey),
      sourceUrl:
        signals.fireSourceUrl === null
          ? undefined
          : signals.fireSourceUrl ?? incident.selectedFire.sourceUrl,
      sourceFeatureId:
        signals.fireSourceFeatureId === null
          ? undefined
          : signals.fireSourceFeatureId ?? incident.selectedFire.sourceFeatureId,
      coverageStatus:
        signals.fireCoverageStatus === null
          ? "not_available"
          : signals.fireCoverageStatus ?? incident.selectedFire.coverageStatus,
    },
    fireCandidates: signals.fireCandidates ?? incident.fireCandidates,
    coverageStatus: limitedSources >= 3 ? "stale" : limitedSources > 0 ? "partial" : "available",
  };
}

function sourceLimitsIncidentFreshness(source: LiveSourceResult) {
  return (
    source.status !== "online" ||
    source.coverageStatus === "error"
  );
}

function liveResultToSourceSnapshot(
  result: LiveSourceResult,
  incidentId: string,
  index: number,
): SourceSnapshot {
  const acquisition=verifiedNativeAcquisition(result,incidentId);
  return {
    ...(acquisition?{nativeAcquisition:acquisition}:{}),
    id: `source-${incidentId}-${result.sourceKey}-${index}-${createHash("sha256").update(JSON.stringify(result)).digest("hex").slice(0, 24)}`,
    incidentId,
    sourceKey: result.sourceKey,
    sourceUrl: result.sourceUrl,
    sourceName: result.sourceName,
    fetchedAt: result.fetchedAt,
    sourceUpdatedAt: result.sourceUpdatedAt,
    sourceTimeBasis: result.sourceTimeBasis,
    validUntil: result.validUntil,
    status: result.status,
    stale: result.stale,
    freshnessLabel: result.freshnessLabel,
    detail: result.warnings.length > 0 ? `${result.detail} ${result.warnings.join(" ")}` : result.detail,
    coverageStatus: result.coverageStatus,
    warnings: result.warnings,
    rawPayload: result.rawPayload,
    derivedSignals: result.derivedSignals as Record<string, unknown>,
  };
}

function mergeDerivedSignals(results: LiveSourceResult[]): LiveSourceDerivedSignals {
  return results.reduce<LiveSourceDerivedSignals>((merged, result) => {
    const next = result.derivedSignals;
    return {
      ...merged,
      rainfallThreat: maxValue(merged.rainfallThreat, next.rainfallThreat),
      rainfallForecast: next.rainfallForecast ?? merged.rainfallForecast,
      activeAlerts: maxValue(merged.activeAlerts, next.activeAlerts),
      burnSeverity: maxValue(merged.burnSeverity, next.burnSeverity),
      fireName: next.fireName ?? merged.fireName,
      fireAcres: maxValue(merged.fireAcres, next.fireAcres),
      fireUpdatedAt: next.fireUpdatedAt ?? merged.fireUpdatedAt,
      fireSource: next.fireSource ?? merged.fireSource,
      fireSourceKey:
        next.fireSourceKey !== undefined ? next.fireSourceKey : merged.fireSourceKey,
      fireSourceUrl:
        next.fireSourceUrl !== undefined ? next.fireSourceUrl : merged.fireSourceUrl,
      fireSourceFeatureId:
        next.fireSourceFeatureId !== undefined
          ? next.fireSourceFeatureId
          : merged.fireSourceFeatureId,
      fireCoverageStatus:
        next.fireCoverageStatus !== undefined
          ? next.fireCoverageStatus
          : merged.fireCoverageStatus,
      fireCandidates: mergeFireCandidates(merged.fireCandidates, next.fireCandidates),
      fireHotspotCount: maxValue(merged.fireHotspotCount, next.fireHotspotCount),
      dataFreshness: minDefined(merged.dataFreshness, next.dataFreshness),
      confidenceMultiplier: minDefined(
        merged.confidenceMultiplier,
        next.confidenceMultiplier,
      ),
      reasonCodes: unique([...(merged.reasonCodes ?? []), ...(next.reasonCodes ?? [])]),
      limitations: unique([...(merged.limitations ?? []), ...(next.limitations ?? [])]),
    };
  }, {});
}

function mergeFireCandidates(
  current: Incident["fireCandidates"],
  next: Incident["fireCandidates"],
) {
  const candidates = [...(current ?? []), ...(next ?? [])];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.sourceKey ?? "unknown"}:${candidate.sourceFeatureId ?? candidate.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

export function sourceFailureResult(
  key: keyof AdapterMap,
  now: Date,
  inventoryError?: ArcgisInventoryError,
): LiveSourceResult {
  const names: Record<keyof AdapterMap, string> = {
    nws: "NWS Forecast Grid and Active Alerts",
    observations: "NWS Latest Observations",
    wfigs: "NIFC WFIGS Current Interagency Fire Perimeters",
    wfigsYtd: "NIFC WFIGS Year-to-Date Fire Perimeters",
    firms: "NASA FIRMS Active Fire",
    mtbs: "MTBS Burn Severity",
    pwfdf: "USGS PWFDF Assessment",
    roads: "Census TIGERweb Transportation Roads",
    hydro: "USGS 3DHP Flowlines",
    epqs: "USGS Elevation Point Query Service",
    bridges: "FHWA/BTS National Bridge Inventory",
    structures: "USGS TNM Structures",
  };
  const sourceKeys: Record<keyof AdapterMap, string> = {
    nws: "nws",
    observations: "nws-observations",
    wfigs: "wfigs",
    wfigsYtd: "wfigs-ytd",
    firms: "firms",
    mtbs: "mtbs-burn-severity",
    pwfdf: "usgs-pwfdf",
    roads: "tiger-roads",
    hydro: "3dhp-flowlines",
    epqs: "usgs-epqs",
    bridges: "fhwa-nbi-bridges",
    structures: "tnm-structures",
  };
  return {
    sourceName: names[key],
    sourceKey: sourceKeys[key],
    status: "offline",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: now.toISOString(),
    stale: true,
    freshnessLabel: "Source error",
    detail: inventoryError?.message ?? `${names[key]} could not be refreshed. FireAfter will not fabricate replacement values for this source.`,
    coverageStatus: "error",
    warnings: [
      ...(inventoryError ? [inventoryError.message] : []),
      `${names[key]} could not be refreshed. No replacement values were used.`,
    ],
    rawPayload: {
      available: false,
      status: "error",
      reason: inventoryError?.code ?? "upstream_unavailable",
      ...(inventoryError ? { inventoryComplete: false } : {}),
    },
    derivedSignals: {
      dataFreshness: 0.45,
      confidenceMultiplier: 0.7,
      reasonCodes: [`Stale ${names[key]}`],
      limitations: [`${names[key]} failed during refresh.`],
    },
  };
}

function buildMissingLocationContextResult(
  incident: Incident,
  now: Date,
): LiveSourceResult {
  return {
    sourceName: "Incident County Geometry",
    sourceKey: "incident-location-context",
    status: "offline",
    fetchedAt: now.toISOString(),
    sourceUpdatedAt: now.toISOString(),
    stale: true,
    freshnessLabel: "Geometry unavailable",
    detail:
      "Live refresh requires persisted county geometry. FireAfter did not run source adapters against synthetic coordinates.",
    coverageStatus: "not_available",
    warnings: [
      `No locationContext/bbox is persisted for ${incident.county}, ${incident.state}. Search and open the county again before production refresh.`,
    ],
    rawPayload: {
      incidentId: incident.id,
      county: incident.county,
      state: incident.state,
      missing: ["locationContext.centroid", "locationContext.bbox"],
    },
    derivedSignals: {
      dataFreshness: 0.3,
      confidenceMultiplier: 0.5,
      reasonCodes: ["County Geometry Not Available"],
      limitations: [
        "Live source refresh is blocked until county geometry is selected from TIGERweb.",
      ],
    },
  };
}

function sourceFailureSourceKey(key: keyof AdapterMap) {
  return {
    nws: "nws",
    observations: "nws-observations",
    wfigs: "wfigs",
    wfigsYtd: "wfigs-ytd",
    firms: "firms",
    mtbs: "mtbs-burn-severity",
    pwfdf: "usgs-pwfdf",
    roads: "tiger-roads",
    hydro: "3dhp-flowlines",
    epqs: "usgs-epqs",
    bridges: "fhwa-nbi-bridges",
    structures: "tnm-structures",
  }[key];
}

function errorType(error: unknown) {
  return error instanceof Error && error.name.trim() ? error.name : "UnknownError";
}

async function fetchJsonWithRetry<T>(
  input: string | URL,
  options: { fetchImpl?: FetchLike; headers?: HeadersInit; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetchWithRetry(input, options);
  return (await response.json()) as T;
}

async function fetchTextWithRetry(
  input: string | URL,
  options: { fetchImpl?: FetchLike; headers?: HeadersInit; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const response = await fetchWithRetry(input, options);
  return response.text();
}

async function fetchWithRetry(
  input: string | URL,
  options: { fetchImpl?: FetchLike; headers?: HeadersInit; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const budget = createResponseBudget(responseByteLimit(process.env.FIREAFTER_SOURCE_MAX_RESPONSE_BYTES), options.timeoutMs ?? sourceTimeoutMs());
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchOperationResponse(input, { headers: options.headers, signal: options.signal }, budget, fetchImpl);
      if (!response.ok) {
        throw new Error(`Upstream HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === 1 || (error instanceof OutboundResponseError && error.code !== "network")) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Source fetch failed");
}

async function fetchArcgisLineLayer(
  layerUrl: string,
  bbox: [number, number, number, number],
  options: {
    fetchImpl: FetchLike;
    outFields: string;
    checkpoint?: ArcgisCheckpointStore;
    boundary?: unknown;
  },
) {
  const result = await fetchArcgisInventory(layerUrl, bbox, options);
  const features = result.features.map((feature) => {
    try {
      const mapped = mapArcgisLineFeature(feature as ArcgisLineFeature, layerUrl);
      if (!mapped) throw new ArcgisInventoryError("invalid_geometry");
      return { ...mapped, id: String(feature.attributes[result.inventory.objectIdFieldName]) };
    } catch { throw new ArcgisInventoryError("invalid_geometry"); }
  });
  return { features, inventory: result.inventory };
}

async function fetchArcgisPointLayer(
  layerUrl: string,
  bbox: [number, number, number, number],
  options: {
    fetchImpl: FetchLike;
    outFields: string;
  },
) {
  const result = await fetchArcgisInventory(layerUrl, bbox, options);
  const features = result.features.map((feature) => {
    const geometry = (feature as ArcgisPointFeature).geometry;
    if (typeof geometry?.x !== "number" || typeof geometry.y !== "number" ||
      !Number.isFinite(geometry.x) || !Number.isFinite(geometry.y) ||
      Math.abs(geometry.x) > 180 || Math.abs(geometry.y) > 90) throw new ArcgisInventoryError("invalid_geometry");
    const mapped = mapArcgisPointFeature(feature as ArcgisPointFeature, layerUrl);
    if (!mapped) throw new ArcgisInventoryError("invalid_geometry");
    return { ...mapped, id: String(feature.attributes[result.inventory.objectIdFieldName]) };
  });
  return { features, inventory: result.inventory };
}

function mapArcgisLineFeature(
  feature: ArcgisLineFeature,
  sourceUrl: string,
): SourceLineFeature | null {
  const attrs = feature.attributes ?? {};
  const paths = parseLinePaths(feature.geometry?.paths);
  if (!paths) throw new Error("Invalid source line geometry; refresh with complete, valid multipart paths.");

  const isHydro = sourceUrl.includes("3DHP");
  const objectId =
    stringValue(attrs.OBJECTID) ??
    stringValue(attrs.objectid) ??
    (numberValue(attrs.OBJECTID) !== undefined ? String(numberValue(attrs.OBJECTID)) : undefined) ??
    stringValue(attrs.OID) ??
    stringValue(attrs.LINEARID) ??
    stringValue(attrs.permanent_identifier) ??
    stringValue(attrs.id3dhp);
  const name =
    stringValue(attrs.FULLNAME) ??
    stringValue(attrs.NAME) ??
    stringValue(attrs.BASENAME) ??
    stringValue(attrs.gnis_name) ??
    stringValue(attrs.GNIS_NAME) ??
    stringValue(attrs.gnisidlabel) ??
    stringValue(attrs.featuretypelabel);
  const klass =
    stringValue(attrs.MTFCC) ??
    stringValue(attrs.RTTYP) ??
    stringValue(attrs.ftype) ??
    stringValue(attrs.fcode) ??
    stringValue(attrs.featuretypelabel) ??
    stringValue(attrs.streamorder);

  return {
    id: objectId ?? `${isHydro ? "hydro" : "road"}-${createHash("sha256").update(JSON.stringify(paths)).digest("hex").slice(0, 32)}`,
    name,
    class: klass,
    paths,
    sourceKey: isHydro ? "3dhp-flowlines" : "tiger-roads",
    sourceName: isHydro ? "USGS 3DHP Flowlines" : "Census TIGERweb Transportation Roads",
    sourceUrl,
  };
}

function mapArcgisPointFeature(
  feature: ArcgisPointFeature,
  sourceUrl: string,
): SourcePointFeature | null {
  const attrs = feature.attributes ?? {};
  const x = numberValue(feature.geometry?.x);
  const y = numberValue(feature.geometry?.y);
  if (x === undefined || y === undefined) return null;
  const objectId =
    stringValue(attrs.OBJECTID) ??
    stringValue(attrs.objectid) ??
    (numberValue(attrs.OBJECTID) !== undefined ? String(numberValue(attrs.OBJECTID)) : undefined) ??
    stringValue(attrs.GlobalID) ??
    stringValue(attrs.GLOBALID) ??
    stringValue(attrs.STRUCTURE_NUMBER_008);

  return {
    id: objectId ?? `point-${slugify(sourceUrl)}-${x}-${y}`,
    coordinates: [x, y],
    attributes: attrs,
    sourceUrl,
  };
}

function tnmStructureAsset(
  feature: SourcePointFeature,
  kind: "hospital" | "fire",
) {
  const name =
    stringValue(feature.attributes.name) ??
    stringValue(feature.attributes.NAME) ??
    (kind === "hospital" ? "Unnamed hospital/medical center" : "Unnamed fire/EMS station");
  const sourceFeatureId = `${kind}-${feature.id}`;
  const facilityKind =
    kind === "hospital" ? "Hospital / Medical Center" : "Fire Station / EMS Station";

  return {
    name,
    type: "Critical Facility" as const,
    locationLabel:
      stringValue(feature.attributes.city) ??
      stringValue(feature.attributes.CITY) ??
      stringValue(feature.attributes.address) ??
      stringValue(feature.attributes.ADDRESS) ??
      facilityKind,
    coordinates: feature.coordinates,
    source: "USGS TNM Structures",
    confidence: "Medium" as const,
    localOrUploaded: false,
    origin: "source" as const,
    sourceKey: "tnm-structures",
    sourceUrl: "https://carto.nationalmap.gov/arcgis/rest/services/structures/mapserver",
    sourceFeatureId,
    coverageStatus: "available" as CoverageStatus,
    confidenceReason: `${facilityKind} candidate from USGS TNM Structures.`,
    evidence: [
      {
        sourceKey: "tnm-structures",
        sourceName: "USGS TNM Structures",
        sourceUrl: "https://carto.nationalmap.gov/arcgis/rest/services/structures/mapserver",
        sourceFeatureId,
        summary: `${facilityKind} from The National Map Structures dataset.`,
      },
    ] satisfies Evidence[],
    metrics: {
      downstreamExposure: kind === "hospital" ? 0.74 : 0.7,
      roadClass: facilityKind,
    },
  };
}

function compactLineFeatures(features: SourceLineFeature[]) {
  return features.map((feature) => ({
    id: feature.id,
    name: feature.name,
    class: feature.class,
    sourceKey: feature.sourceKey,
    sourceName: feature.sourceName,
    sourceUrl: feature.sourceUrl,
    paths: feature.paths,
  }));
}

function uniqueLineFeatures(features: SourceLineFeature[]) {
  const seen = new Set<string>();
  return features.filter((feature) => {
    const key = `${feature.sourceKey}:${feature.sourceUrl}:${feature.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lineFeaturesFromResult(
  results: LiveSourceResult[],
  sourceKey: string,
): SourceLineFeature[] {
  return readSourceLineGeometry(results.find((source) => source.sourceKey === sourceKey)?.rawPayload, sourceKey).features;
}

function crossingCoordinatePairs(
  road: SegmentTree,
  flowline: SegmentTree,
  spend: () => void,
) {
  const crossings = new Map<string, { coordinate: [number, number]; distanceMeters: number }>();
  let nearest:
    | {
        coordinate: [number, number];
        distanceMeters: number;
      }
    | null = null;
  // Visit only road segments near this complete flowline part, then restore
  // original road order so equal-distance candidate selection is unchanged.
  const roadSegments: LineSegment[] = [];
  const roadPending = [road];
  while (roadPending.length) {
    spend();
    const node = roadPending.pop()!;
    if (!lineBoundsWithinScreeningDistance(node.bounds, flowline.bounds)) continue;
    if (node.children) roadPending.push(...node.children);
    if (node.segments) roadSegments.push(...node.segments);
  }
  roadSegments.sort((a, b) => { spend(); return a.index - b.index; });
  for (const { start, end } of roadSegments) {
    spend();
    const bounds = boundsForCoordinates([start, end])!;
    const pending = [flowline];
    while (pending.length) {
      spend();
      const node = pending.pop()!;
      if (!lineBoundsWithinScreeningDistance(bounds, node.bounds)) continue;
      if (node.children) pending.push(...node.children);
      for (const segment of node.segments ?? []) {
        spend();
        const candidate = closestSegmentPair(start, end, segment.start, segment.end);
        if (!nearest || candidate.distanceMeters < nearest.distanceMeters) nearest = candidate;
        if (candidate.distanceMeters === 0) {
          const coordinate = candidate.coordinate.map((value) => Number(value.toFixed(10))) as [number, number];
          crossings.set(coordinate.join(","), { coordinate, distanceMeters: 0 });
        }
      }
    }
  }

  // Shared vertices are one crossing; separate intersections on the same parts
  // are distinct. If no intersection exists, retain only the nearest screening candidate.
  if (crossings.size) return [...crossings.values()];
  return nearest ? [{ ...nearest, coordinate: nearest.coordinate.map((value) => Number(value.toFixed(10))) as [number, number] }] : [];
}

type LineSegment = { start: [number, number]; end: [number, number]; index: number };
type SegmentTree = {
  bounds: NonNullable<ReturnType<typeof boundsForCoordinates>>;
  segments?: LineSegment[];
  children?: [SegmentTree, SegmentTree];
};

type FlowlinePart = { flowline: SourceLineFeature; partIndex: number; tree: SegmentTree };
type FlowlinePartTree = {
  bounds: SegmentTree["bounds"];
  parts?: FlowlinePart[];
  children?: FlowlinePartTree[];
};

// Index complete parts, then use the existing exact segment comparison. No
// vertex sampling, joined parts or county-wide road/flowline Cartesian scan.
function partitionFlowlineParts(parts: FlowlinePart[], spend: () => void): FlowlinePartTree | undefined {
  if (!parts.length) return undefined;
  const bounds = { ...parts[0].tree.bounds };
  for (const { tree } of parts) {
    spend();
    bounds.west = Math.min(bounds.west, tree.bounds.west);
    bounds.east = Math.max(bounds.east, tree.bounds.east);
    bounds.south = Math.min(bounds.south, tree.bounds.south);
    bounds.north = Math.max(bounds.north, tree.bounds.north);
  }
  if (parts.length <= 8) return { bounds, parts };
  // Cell keys only group parts. Pruning uses their complete, unrounded bounds,
  // including geometry that extends beyond its center's cell.
  let width = 128;
  let level = new Map<number, FlowlinePartTree>();
  for (const part of parts) {
    spend();
    const b = part.tree.bounds;
    const x = bounds.east === bounds.west ? 0 : Math.min(width - 1,
      Math.floor(((b.west + b.east) / 2 - bounds.west) / (bounds.east - bounds.west) * width));
    const y = bounds.north === bounds.south ? 0 : Math.min(width - 1,
      Math.floor(((b.south + b.north) / 2 - bounds.south) / (bounds.north - bounds.south) * width));
    const key = y * width + x;
    const node = level.get(key);
    if (node) { node.parts!.push(part); includeLineBounds(node.bounds, b); }
    else level.set(key, { bounds: { ...b }, parts: [part] });
  }
  while (width > 1) {
    const parents = new Map<number, FlowlinePartTree>();
    for (const [key, child] of level) {
      spend();
      const parentKey = Math.floor(Math.floor(key / width) / 2) * (width / 2) + Math.floor((key % width) / 2);
      const parent = parents.get(parentKey);
      if (parent) { parent.children!.push(child); includeLineBounds(parent.bounds, child.bounds); }
      else parents.set(parentKey, { bounds: { ...child.bounds }, children: [child] });
    }
    level = parents;
    width /= 2;
  }
  return level.get(0);
}

function includeLineBounds(target: SegmentTree["bounds"], other: SegmentTree["bounds"]) {
  target.west = Math.min(target.west, other.west);
  target.east = Math.max(target.east, other.east);
  target.south = Math.min(target.south, other.south);
  target.north = Math.max(target.north, other.north);
}

function* nearbyFlowlineParts(root: FlowlinePartTree | undefined, bounds: SegmentTree["bounds"], spend: () => void): Generator<FlowlinePart> {
  const pending = root ? [root] : [];
  while (pending.length) {
    spend();
    const node = pending.pop()!;
    if (!lineBoundsWithinScreeningDistance(bounds, node.bounds)) continue;
    if (node.children) pending.push(...node.children);
    for (const part of node.parts ?? []) {
      spend();
      if (lineBoundsWithinScreeningDistance(bounds, part.tree.bounds)) yield part;
    }
  }
}

function buildSegmentTree(path: [number, number][]): SegmentTree {
  return partitionSegments(path.slice(1).map((end, index) => ({ start: path[index], end, index })));
}

function partitionSegments(segments: LineSegment[]): SegmentTree {
  const bounds = boundsForCoordinates(segments.flatMap((segment) => [segment.start, segment.end]))!;
  if (segments.length <= 8) return { bounds, segments };
  const axis = bounds.east - bounds.west >= bounds.north - bounds.south ? 0 : 1;
  segments.sort((a, b) => (a.start[axis] + a.end[axis]) - (b.start[axis] + b.end[axis]));
  const middle = Math.floor(segments.length / 2);
  return { bounds, children: [partitionSegments(segments.slice(0, middle)), partitionSegments(segments.slice(middle))] };
}

function lineBoundsWithinScreeningDistance(a: SegmentTree["bounds"], b: SegmentTree["bounds"]) {
  const latitudeGap = Math.max(0, a.south - b.north, b.south - a.north);
  if (latitudeGap * 110_000 > 220) return false;
  const longitudeGap = Math.min(...[-360, 0, 360].map(shift =>
    Math.max(0, a.west - (b.east + shift), (b.west + shift) - a.east)));
  const maxLatitude = Math.max(Math.abs(a.south), Math.abs(a.north), Math.abs(b.south), Math.abs(b.north));
  // Conservative spherical lower bound; prune only impossible 220 m candidates.
  // This index never simplifies a segment or joins separate parts.
  return longitudeGap * 60_000 * Math.cos(maxLatitude * Math.PI / 180) <= 220;
}

// Compare source segments rather than only their vertices so a real crossing
// between provider points is not discarded before PWFDF linkage runs.
function closestSegmentPair(
  roadStart: [number, number],
  roadEnd: [number, number],
  flowStart: [number, number],
  flowEnd: [number, number],
) {
  const intersection = segmentIntersection(roadStart, roadEnd, flowStart, flowEnd);
  if (intersection) {
    return { coordinate: intersection, distanceMeters: 0 };
  }

  const candidates = [
    closestPointPair(roadStart, closestPointOnSegment(roadStart, flowStart, flowEnd)),
    closestPointPair(roadEnd, closestPointOnSegment(roadEnd, flowStart, flowEnd)),
    closestPointPair(closestPointOnSegment(flowStart, roadStart, roadEnd), flowStart),
    closestPointPair(closestPointOnSegment(flowEnd, roadStart, roadEnd), flowEnd),
  ];
  return candidates.reduce((closest, candidate) =>
    candidate.distanceMeters < closest.distanceMeters ? candidate : closest,
  );
}

function closestPointPair(
  first: [number, number],
  second: [number, number],
) {
  return {
    coordinate: [
      (first[0] + second[0]) / 2,
      (first[1] + second[1]) / 2,
    ] as [number, number],
    distanceMeters: distanceMeters(first, second),
  };
}

function closestPointOnSegment(
  point: [number, number],
  start: [number, number],
  end: [number, number],
): [number, number] {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return start;
  const projection =
    ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaY) /
    lengthSquared;
  const ratio = Math.max(0, Math.min(1, projection));
  return [start[0] + deltaX * ratio, start[1] + deltaY * ratio];
}

function segmentIntersection(
  firstStart: [number, number],
  firstEnd: [number, number],
  secondStart: [number, number],
  secondEnd: [number, number],
): [number, number] | null {
  const firstVector: [number, number] = [
    firstEnd[0] - firstStart[0],
    firstEnd[1] - firstStart[1],
  ];
  const secondVector: [number, number] = [
    secondEnd[0] - secondStart[0],
    secondEnd[1] - secondStart[1],
  ];
  const denominator = crossProduct(firstVector, secondVector);
  if (Math.abs(denominator) < Number.EPSILON) return null;

  const offset: [number, number] = [
    secondStart[0] - firstStart[0],
    secondStart[1] - firstStart[1],
  ];
  const firstRatio = crossProduct(offset, secondVector) / denominator;
  const secondRatio = crossProduct(offset, firstVector) / denominator;
  if (
    firstRatio < 0 || firstRatio > 1 ||
    secondRatio < 0 || secondRatio > 1
  ) {
    return null;
  }
  return [
    firstStart[0] + firstVector[0] * firstRatio,
    firstStart[1] + firstVector[1] * firstRatio,
  ];
}

function crossProduct(first: [number, number], second: [number, number]) {
  return first[0] * second[1] - first[1] * second[0];
}

function distanceMeters(a: [number, number], b: [number, number]) {
  const radiusMeters = 6371000;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const deltaLat = ((b[1] - a[1]) * Math.PI) / 180;
  const deltaLon = ((b[0] - a[0]) * Math.PI) / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * radiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

function exposureFromRoadClass(roadClass: string, hydroDistanceMeters: number) {
  const upper = roadClass.toUpperCase();
  const classScore =
    upper.includes("S1100") || upper === "I"
      ? 0.9
      : upper.includes("S1200") || upper === "U" || upper === "S"
        ? 0.78
        : upper.includes("S1400") || upper === "M"
          ? 0.62
          : 0.55;
  const proximityScore = clamp(1 - hydroDistanceMeters / 240);
  return round(classScore * 0.65 + proximityScore * 0.35, 3);
}

async function fetchEpqsElevationMeters(
  lon: number,
  lat: number,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
) {
  const url = new URL(epqsUrl);
  url.searchParams.set("x", String(lon));
  url.searchParams.set("y", String(lat));
  url.searchParams.set("units", "Meters");
  url.searchParams.set("wkid", "4326");
  const payload = await fetchJsonWithRetry<Record<string, unknown>>(url, {
    fetchImpl,
    timeoutMs: 2500,
    signal,
  });

  return (
    elevationValue(payload.value) ??
    elevationValue(payload.elevation) ??
    nestedEpqsElevation(payload)
  );
}

function elevationValue(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= -500 && parsed <= 9000 ? parsed : undefined;
}

function dedupeAssets(assets: Asset[]) {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    const key = asset.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeNwsAlerts(alerts: NwsAlertsResponse, location: LocationCandidate, forecastZoneUrl?: string) {
  if (!Array.isArray(alerts.features)) {
    return { activeAlerts: 0, relevantAlerts: [], warning: "NWS alert response is invalid; absence of alerts is not verified." };
  }
  const features = alerts.features;
  const countyZone = `${location.state}C${location.fips.slice(-3)}`;
  const forecastZone = forecastZoneUrl?.match(/\/zones\/forecast\/([A-Z]{2}Z\d{3})$/)?.[1];
  const localZones = [countyZone, ...(forecastZone?.startsWith(location.state) ? [forecastZone] : [])];
  let unscoped = false;
  const relevant = features.filter((feature) => {
    const props = feature.properties ?? {};
    const ugc = props.geocode?.UGC;
    const same = props.geocode?.SAME;
    const codes = [...(Array.isArray(ugc) ? ugc : []), ...(Array.isArray(same) ? same : [])];
    if (codes.length === 0) unscoped = true;
    return codes.some((code) => typeof code === "string" &&
      (localZones.includes(code) || code === `0${location.fips}`));
  });
  return {
    activeAlerts: relevant.length,
    relevantAlerts: relevant.slice(0, 5).map((feature) => ({
      event: feature.properties?.event,
      headline: feature.properties?.headline,
      severity: feature.properties?.severity,
    })),
    warning: unscoped ? "Some NWS alerts have no usable geographic codes; county alert coverage is incomplete." : undefined,
  };
}

function latestFirmsDate(rows: Array<Record<string, string>>) {
  const latest = rows
    .map((row) => {
      const time = `${row.acq_time ?? "0000"}`.padStart(4, "0");
      return Date.parse(`${row.acq_date}T${time.slice(0, 2)}:${time.slice(2, 4)}:00Z`);
    })
    .filter((value) => !Number.isNaN(value))
    .sort((a, b) => b - a)[0];
  return latest ? new Date(latest).toISOString() : undefined;
}

function normalizeFirmsSource(source?: string) {
  const normalized = source?.trim().toUpperCase();
  const supported = new Set([
    "LANDSAT_NRT",
    "MODIS_NRT",
    "MODIS_SP",
    "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA20_SP",
    "VIIRS_NOAA21_NRT",
    "VIIRS_SNPP_NRT",
    "VIIRS_SNPP_SP",
  ]);
  return normalized && supported.has(normalized) ? normalized : "VIIRS_SNPP_NRT";
}

function mapTigerCountyFeature(feature: TigerCountyFeature): LocationCandidate | null {
  const attrs = feature.attributes ?? {};
  const name = stringValue(attrs.NAME);
  const stateFips = stringValue(attrs.STATE);
  const state = stateAbbreviationForFips(stateFips) ?? stateFips;
  const countyfp = stringValue(attrs.COUNTY);
  const fips = stringValue(attrs.GEOID) ?? `${stateFips ?? ""}${countyfp ?? ""}`;
  const extent = feature.geometry?.rings
    ? bboxFromRings(feature.geometry.rings)
    : undefined;
  if (!name || !state || !fips || !extent) return null;
  const centroidLon = numberValue(attrs.CENTLON) ?? numberValue(attrs.INTPTLON);
  const centroidLat = numberValue(attrs.CENTLAT) ?? numberValue(attrs.INTPTLAT);
  const centroid: [number, number] = [
    round(centroidLon ?? (extent[0] + extent[2]) / 2, 4),
    round(centroidLat ?? (extent[1] + extent[3]) / 2, 4),
  ];

  return {
    id: `${slugify(name)}-${state.toLowerCase()}`,
    county: name.endsWith("County") ? name : `${name} County`,
    state,
    label: `${name.endsWith("County") ? name : `${name} County`}, ${state}`,
    centroid,
    bbox: extent,
    fips,
    fireWeatherZone: "auto",
    population: numberValue(attrs.POPULATION) ?? 0,
    wildfireContext:
      "Live Census TIGERweb county geometry loaded; local wildfire and asset confidence depends on available source coverage.",
    boundary: normalizeCountyBoundary({ type: "Polygon", coordinates: feature.geometry!.rings }),
    sourceKey: "tigerweb-counties",
    sourceUrl:
      "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1",
    coverageStatus: "available",
  };
}

function stateFipsForAbbreviation(abbreviation: string): string | undefined {
  const wanted = abbreviation.toUpperCase();
  for (const [fips, state] of Object.entries(stateFipsAbbreviations)) {
    if (state === wanted) return fips;
  }
  return undefined;
}

function stateAbbreviationForFips(fips?: string) {
  return fips ? stateFipsAbbreviations[fips] : undefined;
}

const stateFipsAbbreviations: Record<string, string> = {
    "01": "AL",
    "02": "AK",
    "04": "AZ",
    "05": "AR",
    "06": "CA",
    "08": "CO",
    "09": "CT",
    "10": "DE",
    "11": "DC",
    "12": "FL",
    "13": "GA",
    "15": "HI",
    "16": "ID",
    "17": "IL",
    "18": "IN",
    "19": "IA",
    "20": "KS",
    "21": "KY",
    "22": "LA",
    "23": "ME",
    "24": "MD",
    "25": "MA",
    "26": "MI",
    "27": "MN",
    "28": "MS",
    "29": "MO",
    "30": "MT",
    "31": "NE",
    "32": "NV",
    "33": "NH",
    "34": "NJ",
    "35": "NM",
    "36": "NY",
    "37": "NC",
    "38": "ND",
    "39": "OH",
    "40": "OK",
    "41": "OR",
    "42": "PA",
    "44": "RI",
    "45": "SC",
    "46": "SD",
    "47": "TN",
    "48": "TX",
    "49": "UT",
    "50": "VT",
    "51": "VA",
    "53": "WA",
    "54": "WV",
    "55": "WI",
    "56": "WY",
    "60": "AS",
    "66": "GU",
    "69": "MP",
    "72": "PR",
    "78": "VI",
};

function bboxAroundCentroid([lon, lat]: [number, number]): [number, number, number, number] {
  return [lon - 0.45, lat - 0.35, lon + 0.45, lat + 0.35];
}

function bboxFromRings(rings: number[][][]): [number, number, number, number] {
  const points = rings.flat();
  const lons = points.map((point) => Number(point[0])).filter(Number.isFinite);
  const lats = points.map((point) => Number(point[1])).filter(Number.isFinite);
  return [
    Math.min(...lons),
    Math.min(...lats),
    Math.max(...lons),
    Math.max(...lats),
  ];
}

function actionForRisk(riskLevel: Recommendation["riskLevel"], assetType: Asset["type"]) {
  if (riskLevel === "Unknown") return UNKNOWN_RISK_ACTION;
  if (riskLevel === "Very High") {
    return `Inspect ${assetType.toLowerCase()} and upstream channel for immediate operational review.`;
  }
  if (riskLevel === "High") {
    return `Inspect ${assetType.toLowerCase()} and clear debris. Monitor closely.`;
  }
  return `Monitor ${assetType.toLowerCase()} and review if rainfall forecast increases.`;
}

function nwsHeaders() {
  const userAgent = process.env.FIREAFTER_NWS_USER_AGENT?.trim();
  if (
    !userAgent ||
    userAgent.includes("fireafter.local") ||
    !/(@|https?:\/\/)/i.test(userAgent)
  ) {
    throw new Error(
      "FIREAFTER_NWS_USER_AGENT must include an operator contact email or URL for api.weather.gov.",
    );
  }

  return {
    "User-Agent": userAgent,
    Accept: "application/geo+json, application/json",
  };
}

function nestedEpqsElevation(payload: Record<string, unknown>) {
  const service = payload.USGS_Elevation_Point_Query_Service;
  if (!service || typeof service !== "object") return undefined;
  const query = (service as Record<string, unknown>).Elevation_Query;
  if (!query || typeof query !== "object") return undefined;
  return elevationValue((query as Record<string, unknown>).Elevation);
}

function nwsQuantitativePrecipitationValues(gridData: unknown): NwsGridValue[] {
  if (!gridData || typeof gridData !== "object") return [];
  const properties = (gridData as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object") return [];
  const precipitation = (properties as Record<string, unknown>)
    .quantitativePrecipitation;
  if (!precipitation || typeof precipitation !== "object") return [];
  const values = (precipitation as Record<string, unknown>).values;
  if (!Array.isArray(values)) return [];

  return values.flatMap((value): NwsGridValue[] => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.validTime !== "string" ||
      (item.value !== null && typeof item.value !== "number")
    ) {
      return [];
    }
    return [{ validTime: item.validTime, value: item.value }];
  });
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function coordinateValue(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : undefined;
}

function assetTypeValue(value: unknown): Asset["type"] | undefined {
  if (value === "Road Crossing") return value;
  if (value === "Culvert") return value;
  if (value === "Bridge") return value;
  if (value === "Evacuation Route") return value;
  if (value === "Critical Facility") return value;
  if (value === "Inferred Crossing") return value;
  return undefined;
}

function confidenceValue(value: unknown): Asset["confidence"] | undefined {
  if (value === "High" || value === "Medium" || value === "Low") return value;
  return undefined;
}

function metricsValue(value: unknown): Asset["metrics"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    slopeTerrain: numberValue(record.slopeTerrain),
    downstreamExposure: numberValue(record.downstreamExposure),
    elevationChangeMeters: numberValue(record.elevationChangeMeters),
    elevationSampleMeters: Array.isArray(record.elevationSampleMeters)
      ? record.elevationSampleMeters
          .map(numberValue)
          .filter((item): item is number => item !== undefined)
      : undefined,
    roadClass: stringValue(record.roadClass),
    hydroDistanceMeters: numberValue(record.hydroDistanceMeters),
  };
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function maxValue(current?: number, next?: number) {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.max(current, next);
}

function minDefined(current?: number, next?: number) {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.min(current, next);
}

function clamp(value: number) {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number, places = 3) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function isOlderThan(value: string, now: Date, minutes: number) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return true;
  return now.getTime() - parsed > minutes * 60 * 1000;
}

function freshnessLabel(value: string, now: Date) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "Unknown age";
  const minutes = Math.max(0, Math.round((now.getTime() - parsed) / 60000));
  if (minutes < 2) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function formatDisplayTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatDisplayDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function escapeSqlLike(value: string) {
  return value.replace(/'/g, "''");
}

type NwsPointResponse = {
  properties?: {
    cwa?: string;
    gridId?: string;
    gridX?: number;
    gridY?: number;
    forecastGridData?: string;
    forecastZone?: string;
    observationStations?: string;
  };
};

type NwsStationsResponse = {
  features?: Array<{
    id?: string;
    properties?: {
      stationIdentifier?: string;
      name?: string;
    };
  }>;
};

type NwsObservationResponse = {
  properties?: {
    timestamp?: string;
    textDescription?: string;
    temperature?: { value?: number | null; unitCode?: string };
    precipitationLastHour?: { value?: number | null; unitCode?: string };
  };
};

type NwsAlertsResponse = {
  features?: Array<{
    properties?: {
      areaDesc?: string;
      event?: string;
      headline?: string;
      severity?: string;
      geocode?: { UGC?: string[]; SAME?: string[] };
    };
  }>;
};

type NwsGridValue = {
  validTime: string;
  value: number | null;
};

type WfigsFeature = {
  attributes?: Record<string, unknown>;
  geometry?: {
    rings?: number[][][];
  };
};

type TigerCountyFeature = {
  attributes?: Record<string, unknown>;
  geometry?: {
    rings?: number[][][];
  };
};

type ArcgisLineFeature = {
  attributes?: Record<string, unknown>;
  geometry?: {
    paths?: number[][][];
  };
};

type ArcgisPointFeature = {
  attributes?: Record<string, unknown>;
  geometry?: {
    x?: number;
    y?: number;
  };
};

type ArcgisError = {
  code?: number;
  message?: string;
};

type SourcePointFeature = {
  id: string;
  coordinates: [number, number];
  attributes: Record<string, unknown>;
  sourceUrl?: string;
};
