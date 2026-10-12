import { createHash, randomUUID } from "node:crypto";
import { createResponderAction } from "./audit";
import { runLiveSourceRefresh } from "./live-sources";
import { isUploadedAsset, parseAssetUpload, uploadedAssetIdentity, UPLOAD_CONFIDENCE_REASON } from "./asset-import-validation";
import type {
  Asset,
  AuditEvent,
  Incident,
  LocationCandidate,
  Recommendation,
  ResponderAction,
  ResponderActionType,
  RiskLevel,
  SourceSnapshot,
} from "./types";

const nowIso = "2026-06-27T14:24:00.000Z";

const locations: LocationCandidate[] = [
  {
    id: "los-angeles-ca",
    county: "Los Angeles County",
    state: "CA",
    label: "Los Angeles County, CA",
    centroid: [-118.2437, 34.0522],
    bbox: [-118.9517, 32.8005, -117.6462, 34.8233],
    fips: "06037",
    fireWeatherZone: "CAZ548",
    population: 9663345,
    wildfireContext: "Recent canyon and foothill burn scars with dense road exposure.",
  },
  {
    id: "ventura-ca",
    county: "Ventura County",
    state: "CA",
    label: "Ventura County, CA",
    centroid: [-119.1391, 34.3705],
    bbox: [-119.4778, 33.9905, -118.6325, 34.9011],
    fips: "06111",
    fireWeatherZone: "CAZ354",
    population: 832605,
    wildfireContext: "Steep coastal ranges with repeated post-fire drainage concerns.",
  },
  {
    id: "sonoma-ca",
    county: "Sonoma County",
    state: "CA",
    label: "Sonoma County, CA",
    centroid: [-122.9888, 38.578],
    bbox: [-123.5335, 38.1397, -122.3503, 38.8525],
    fips: "06097",
    fireWeatherZone: "CAZ506",
    population: 485887,
    wildfireContext: "Wildland-urban interface basins feeding rural roads and communities.",
  },
  {
    id: "boulder-co",
    county: "Boulder County",
    state: "CO",
    label: "Boulder County, CO",
    centroid: [-105.2705, 40.015],
    bbox: [-105.6935, 39.9139, -105.0527, 40.2628],
    fips: "08013",
    fireWeatherZone: "COZ239",
    population: 329543,
    wildfireContext: "Mountain canyons, burn scars, and critical access corridors.",
  },
];

const incidents = new Map<string, Incident>();
const assets = new Map<string, Asset[]>();
const sourceSnapshots = new Map<string, SourceSnapshot[]>();
const recommendations = new Map<string, Recommendation[]>();
const actions: ResponderAction[] = [];
const auditEvents: AuditEvent[] = [];

export function searchLocations(query: string): LocationCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return locations;

  const directMatches = locations.filter((location) =>
    `${location.id} ${location.county} ${location.state} ${location.label}`
      .toLowerCase()
      .includes(normalized),
  );

  if (directMatches.length > 0) return directMatches;

  return [];
}

export function createIncident(locationId = "los-angeles-ca"): Incident {
  const location =
    locations.find((candidate) => candidate.id === locationId) ??
    searchLocations(locationId)[0];
  if (!location) {
    throw new Error(`No fixture location found for ${locationId}`);
  }
  return createIncidentFromLocation(location);
}

export function createIncidentFromLocation(location: LocationCandidate): Incident {
  upsertLocationCandidate(location);
  const incidentId = `incident-${location.id}`;
  const incident: Incident = {
    id: incidentId,
    locationId: location.id,
    county: location.county,
    state: location.state,
    title: `${location.county.replace(" County", "")} Fire`,
    code: `${location.state}-FA-${location.fips}-001`,
    status: "Monitoring",
    stormWindow: "Next 48-72 hrs",
    rainfallForecast: "Awaiting NWS refresh",
    lastRefresh: "Not refreshed",
    dataFreshness: "Low",
    activeAlerts: 0,
    selectedFire: {
      name: "Pending WFIGS fire context",
      acres: 0,
      perimeterUpdated: "Not refreshed",
      source: "NIFC WFIGS current perimeter query pending",
      coverageStatus: "not_available",
    },
    locationContext: location,
    coverageStatus: "not_available",
  };

  incidents.set(incidentId, incident);
  if (!assets.has(incidentId)) assets.set(incidentId, []);
  auditEvents.push({
    id: `audit-${incidentId}-created`,
    incidentId,
    eventType: "IncidentCreated",
    actorName: "FireAfter",
    createdAt: nowIso,
    summary: `Opened ${incident.title} workspace for ${incident.county}.`,
    payload: { incident },
  });

  return incident;
}

export function upsertLocationCandidate(location: LocationCandidate) {
  const existingIndex = locations.findIndex((candidate) => candidate.id === location.id);
  if (existingIndex >= 0) {
    locations[existingIndex] = location;
  } else {
    locations.push(location);
  }
}

export async function refreshIncident(incidentId: string) {
  const incident = incidents.get(incidentId) ?? createIncident();
  const incidentAssets = assets.get(incident.id) ?? [];
  const incidentRecommendations = recommendations.get(incident.id) ?? [];
  const incidentSourceSnapshots = sourceSnapshots.get(incident.id) ?? [];
  assets.set(incident.id, incidentAssets);
  const refreshed = await runLiveSourceRefresh({
    incident,
    assets: incidentAssets,
    previousRecommendations: incidentRecommendations,
    previousSourceSnapshots: incidentSourceSnapshots,
  });

  incidents.set(incident.id, refreshed.incident);
  assets.set(incident.id, refreshed.assets);
  sourceSnapshots.set(incident.id, refreshed.sourceSnapshots);
  recommendations.set(incident.id, refreshed.recommendations);
  auditEvents.push({
    id: `audit-${incident.id}-refresh-${auditEvents.length + 1}`,
    incidentId: incident.id,
    eventType: "SourcesRefreshed",
    actorName: "FireAfter",
    createdAt: new Date().toISOString(),
    summary: `Refreshed ${refreshed.sourceSnapshots.length} source feeds and recalculated ${refreshed.recommendations.length} recommendations.`,
    payload: {
      sourceSnapshots: refreshed.sourceSnapshots,
      recommendationCount: refreshed.recommendations.length,
    },
  });

  return refreshed;
}

export function getIncidentBundle(incidentId = "incident-los-angeles-ca") {
  const incident = incidents.get(incidentId) ?? createIncident("los-angeles-ca");
  if (!recommendations.has(incident.id)) {
    sourceSnapshots.set(incident.id, []);
    recommendations.set(incident.id, []);
  }

  return {
    incident,
    locations,
    assets: assets.get(incident.id) ?? [],
    sourceSnapshots: sourceSnapshots.get(incident.id) ?? [],
    recommendations: recommendations.get(incident.id) ?? [],
    actions: actions.filter((action) =>
      recommendations
        .get(incident.id)
        ?.some((recommendation) => recommendation.id === action.recommendationId),
    ),
    auditEvents: auditEvents.filter((event) => event.incidentId === incident.id),
  };
}

export function recordAction(input: {
  recommendationId: string;
  action: ResponderActionType;
  note: string;
  actorName: string;
  modifiedPriority?: RiskLevel;
}) {
  const recommendation = [...recommendations.values()]
    .flat()
    .find((item) => item.id === input.recommendationId);

  if (!recommendation) {
    throw new Error(`Recommendation not found: ${input.recommendationId}`);
  }

  const action = createResponderAction({
    recommendation,
    action: input.action,
    note: input.note,
    actorName: input.actorName,
    modifiedPriority: input.modifiedPriority,
  });
  actions.push(action);
  auditEvents.push(action.auditEvent);
  return action;
}

type AssetImportInput = { incidentId: string; fileName: string; content: string; actorName?: string };

export function importAssets(input: AssetImportInput & { incident?: Incident }) {
  const incident = input.incident ?? incidents.get(input.incidentId);
  if (!incident) throw new Error(`Incident not found for asset import: ${input.incidentId}`);
  const imported = prepareAssetImport(input, incident, assets.get(incident.id) ?? []);
  if (imported.assets.length > 0) {
    incidents.set(incident.id, incident);
    assets.set(incident.id, dedupeAssets([...imported.assets, ...(assets.get(incident.id) ?? [])]));
    if (imported.auditEvent) auditEvents.push(imported.auditEvent);
  }
  return imported;
}

export function prepareAssetImport(input: AssetImportInput, incident: Incident, existingAssets: Asset[] = []) {
  if (incident.id !== input.incidentId) throw new Error("Asset import incident identity mismatch.");
  const parsed = parseAssetUpload(input, incident);
  const existingByIdentity = new Map(existingAssets.filter(isUploadedAsset).map((asset) => [uploadedAssetIdentity(asset), asset.id]));
  const importedAssets = dedupeAssets(parsed.assets.flatMap((row, index) => {
    const type = normalizeAssetType(stringValue(row.properties.type));
    if (!type) {
      parsed.errors.push(`${row.label}: unsupported asset type; use culvert, bridge, road crossing, evacuation route or critical facility.`);
      return [];
    }
    const asset = buildUploadedAsset({
      incident, input, index, type, geometry: row.geometry, coordinates: row.coordinates,
      name: stringValue(row.properties.name) ?? stringValue(row.properties.asset_name) ??
        `${stringValue(row.properties.road) ?? "Local"} @ ${stringValue(row.properties.stream) ?? "Drainage"}`,
      locationLabel: stringValue(row.properties.stream) ?? stringValue(row.properties.location) ?? stringValue(row.properties.road) ?? "Uploaded local asset",
      road: stringValue(row.properties.road), stream: stringValue(row.properties.stream),
    });
    asset.id = existingByIdentity.get(uploadedAssetIdentity(asset)) ?? asset.id;
    return [asset];
  }));
  const auditEvent: AuditEvent | null = importedAssets.length ? {
    id: `audit-${incident.id}-asset-import-${randomUUID()}`,
    incidentId: incident.id,
    eventType: "AssetsImported",
    actorName: input.actorName ?? "FireAfter",
    createdAt: new Date().toISOString(),
    summary: `Imported ${importedAssets.length} local asset${importedAssets.length === 1 ? "" : "s"} from ${input.fileName}.`,
    payload: { fileName: input.fileName, assetCount: importedAssets.length, importErrors: parsed.errors, verification: "unverified" },
  } : null;
  return { assets: importedAssets, auditEvent, importErrors: parsed.errors };
}

function buildUploadedAsset(input: {
  incident: Incident;
  input: { incidentId: string; fileName: string };
  index: number;
  name: string;
  type: Asset["type"];
  locationLabel: string;
  coordinates: [number, number];
  geometry: Asset["geometry"];
  road?: string;
  stream?: string;
}): Asset {
  return {
    id: uploadedAssetId(input),
    incidentId: input.incident.id,
    name: input.name,
    type: input.type,
    locationLabel: input.locationLabel,
    coordinates: input.coordinates,
    source: input.input.fileName,
    confidence: "Low",
    localOrUploaded: true,
    geometry: input.geometry,
    origin: "uploaded",
    sourceKey: "local-upload",
    coverageStatus: "available",
    confidenceReason: UPLOAD_CONFIDENCE_REASON,
    evidence: [
      {
        sourceKey: "local-upload",
        sourceName: input.input.fileName,
        summary: "County/local uploaded asset record.",
      },
    ],
    road: input.road,
    stream: input.stream,
  };
}

function uploadedAssetId(input: {
  incident: Incident;
  input: { fileName: string };
  name: string;
  type: Asset["type"];
  coordinates: [number, number];
  geometry: Asset["geometry"];
  road?: string;
  stream?: string;
}) {
  const identity = uploadedAssetIdentity({ ...input, incidentId: input.incident.id, source: input.input.fileName });
  const digest = createHash("sha256").update(`geometry-v2:${identity}`).digest("hex");
  return `asset-${input.incident.id}-upload-${digest.slice(0, 32)}`;
}

function dedupeAssets(assetList: Asset[]) {
  const seen = new Set<string>();
  return assetList.filter((asset) => {
    const key = asset.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeAssetType(type?: string): Asset["type"] | undefined {
  const normalized = type?.toLowerCase().replace(/[_-]+/g, " ").trim();
  if (normalized === "culvert") return "Culvert";
  if (normalized === "bridge" || normalized === "nbi bridge") return "Bridge";
  if (
    normalized === "hospital" ||
    normalized === "medical center" ||
    normalized === "fire station" ||
    normalized === "fire/ems station" ||
    normalized === "ems station" ||
    normalized === "critical facility"
  ) {
    return "Critical Facility";
  }
  if (normalized === "evacuation route" || normalized === "evac route") {
    return "Evacuation Route";
  }
  if (normalized === "inferred crossing") return "Inferred Crossing";
  if (!normalized || ["road", "road crossing", "crossing"].includes(normalized)) return "Road Crossing";
  return undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
