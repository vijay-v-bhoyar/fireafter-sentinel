import { ARCGIS_INVENTORY_VERSION } from "./arcgis-inventory-contract";
import type { Asset, Incident, SourceSnapshot } from "./types";
import { geometryBudget, parseArcgisBasinGeometry, prepareBasinContainment, validateBasinGeometry, PwfdfGeometryError, PWFDF_ANALYSIS_GEOMETRY_VERSION, type BasinGeometry, type GeometryBudget } from "./pwfdf-geometry";

export const PWFDF_LINKAGE_VERSION = "2026-09-14-pwfdf-discovery-v2";

const discoveryMessages = {
  pwfdf_time_invalid: "PWFDF publication time is invalid or later than the evaluation clock. Verify the provider assessment/basin dates and the server clock before refreshing; no replacement evidence was used.",
  pwfdf_incomplete: "PWFDF assessment discovery is incomplete or truncated. Retry complete discovery before using basin evidence.",
  pwfdf_ambiguous: "PWFDF assessment identity is ambiguous. Ask an authorized reviewer to resolve the conflicting fire or assessment records; no candidate was selected.",
  pwfdf_invalid: "PWFDF assessment metadata is invalid. Verify the provider schema and required fire identifiers/dates before retrying.",
};
export class PwfdfDiscoveryError extends Error {
  constructor(public readonly code: keyof typeof discoveryMessages) {
    super(discoveryMessages[code]);
    this.name = "PwfdfDiscoveryError";
  }
}

const pwfdfServiceBase =
  "https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer";
const maxBasinFeatures = 500;

export type PwfdfAssessment = {
  fireName: string;
  fireId: string;
  status?: string;
  rainfallScenario?: string;
  startDate?: string;
  assessmentDate: string;
  scienceBaseUrl?: string;
};

export type PwfdfBasinHazard = {
  id: string;
  fireId: string;
  assessmentDate: string;
  version?: string;
  probabilityClass: string;
  volumeClass: string;
  combinedHazard: "Low" | "Moderate" | "High";
  geometry: BasinGeometry;
};

export function buildPwfdfLocationsUrl(bbox: [number, number, number, number]) {
  const url = new URL(`${pwfdfServiceBase}/0/query`);
  url.searchParams.set("f", "json");
  url.searchParams.set("where", "1=1");
  url.searchParams.set("geometry", bbox.join(","));
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set(
    "outFields",
    "fire,Fire_ID,status,Rainfall,start_date,assessment_date,ScienceBaseURL",
  );
  url.searchParams.set("returnGeometry", "false");
  return url;
}

export function buildPwfdfBasinsUrl(fireId: string) {
  const url = new URL(`${pwfdfServiceBase}/4/query`);
  url.searchParams.set("f", "json");
  url.searchParams.set("where", `fire_id='${fireId.replace(/'/g, "''")}'`);
  url.searchParams.set("outSR", "4326");
  url.searchParams.set(
    "outFields",
    "OBJECTID,BP_Legend,BV_Legend,BCH_Legend,fire_id,assessment_date,version",
  );
  url.searchParams.set("returnGeometry", "true");
  // Analysis uses provider-returned positions, never display-oriented generalization.
  url.searchParams.set("resultRecordCount", String(maxBasinFeatures + 1));
  return url;
}

export function selectPwfdfAssessment(
  payload: unknown,
  selectedFireName: string,
): PwfdfAssessment | null {
  if (recordValue(payload).exceededTransferLimit === true) throw new PwfdfDiscoveryError("pwfdf_incomplete");
  const features = arcgisFeatures(payload, "assessment locations");
  const selectedName = normalizeFireName(selectedFireName);
  if (!selectedName) return null;
  const candidates = features.flatMap((feature) => {
    const attributes = recordValue(feature.attributes);
    const fireName = stringValue(attributes.fire);
    const fireId = stringValue(attributes.Fire_ID);
    const assessmentDate = dateValue(attributes.assessment_date);
    if (!fireName || !fireId || !assessmentDate) throw new PwfdfDiscoveryError("pwfdf_invalid");
    if (normalizeFireName(fireName) !== selectedName) return [];

    return [{
      fireName,
      fireId,
      status: stringValue(attributes.status),
      rainfallScenario: stringValue(attributes.Rainfall),
      startDate: dateValue(attributes.start_date),
      assessmentDate,
      scienceBaseUrl: safeHttpsUrl(attributes.ScienceBaseURL),
    }];
  });

  if (new Set(candidates.map(candidate => candidate.fireId)).size > 1) throw new PwfdfDiscoveryError("pwfdf_ambiguous");
  const latest = candidates.sort(
    (left, right) => Date.parse(right.assessmentDate) - Date.parse(left.assessmentDate),
  )[0] ?? null;
  if (latest && candidates.some(candidate => candidate.assessmentDate === latest.assessmentDate &&
    JSON.stringify(candidate) !== JSON.stringify(latest))) throw new PwfdfDiscoveryError("pwfdf_ambiguous");
  return latest;
}

export function parsePwfdfBasins(
  payload: unknown,
  assessment: PwfdfAssessment,
): PwfdfBasinHazard[] {
  const record = recordValue(payload);
  if (record.exceededTransferLimit === true) {
    throw new Error(
      `USGS PWFDF returned more than ${maxBasinFeatures} basin polygons; narrow the assessment query before operational use.`,
    );
  }
  const features = arcgisFeatures(payload, "combined-hazard basins");
  if (features.length > maxBasinFeatures) {
    throw new Error(
      `USGS PWFDF returned ${features.length} basin polygons, above the ${maxBasinFeatures}-feature safety cap.`,
    );
  }

  const budget = geometryBudget();
  const basins = features.map((feature, index) => {
    const attributes = recordValue(feature.attributes);
    const geometry = recordValue(feature.geometry);
    const fireId = stringValue(attributes.fire_id);
    if (fireId !== assessment.fireId) {
      throw new Error(`USGS PWFDF basin ${index + 1} does not match assessment ${assessment.fireId}.`);
    }
    const id = stringValue(attributes.OBJECTID) ?? numberId(attributes.OBJECTID);
    const probabilityClass = stringValue(attributes.BP_Legend);
    const volumeClass = stringValue(attributes.BV_Legend);
    const combinedHazard = combinedHazardValue(attributes.BCH_Legend);
    let polygon: BasinGeometry;
    try { polygon = parseArcgisBasinGeometry(geometry.rings, budget); }
    catch (error) {
      if (error instanceof PwfdfGeometryError) throw error;
      throw new PwfdfGeometryError();
    }
    if (!id || !probabilityClass || !volumeClass || !combinedHazard) {
      throw new Error(`USGS PWFDF basin ${index + 1} is missing required hazard attributes or valid polygon geometry.`);
    }

    const assessmentDate = dateValue(attributes.assessment_date);
    if (!assessmentDate) throw new PwfdfDiscoveryError("pwfdf_time_invalid");
    return {
      id: `pwfdf-${assessment.fireId}-${id}`,
      fireId,
      assessmentDate,
      version: stringValue(attributes.version),
      probabilityClass,
      volumeClass,
      combinedHazard,
      geometry: polygon,
    };
  });

  if (new Set(basins.map(basin => basin.id)).size !== basins.length) throw new PwfdfGeometryError();
  if (basins.length === 0) {
    throw new Error(`USGS PWFDF assessment ${assessment.fireId} returned no combined-hazard basin polygons.`);
  }
  return basins;
}

export function pwfdfBasinsFromSnapshot(
  snapshot: Pick<SourceSnapshot, "sourceKey" | "coverageStatus" | "rawPayload"> | undefined,
) {
  if (snapshot?.sourceKey !== "usgs-pwfdf" || snapshot.coverageStatus !== "available" ||
      snapshot.rawPayload?.analysisGeometryVersion !== PWFDF_ANALYSIS_GEOMETRY_VERSION) {
    return [];
  }
  const assessment = parsePersistedAssessment(snapshot.rawPayload?.assessment);
  const rawBasins = snapshot.rawPayload?.basins;
  if (!assessment || !Array.isArray(rawBasins) || !rawBasins.length || rawBasins.length > maxBasinFeatures ||
      (snapshot.rawPayload?.basinCount !== undefined && snapshot.rawPayload.basinCount !== rawBasins.length)) return [];
  const budget = geometryBudget();
  try {
    const basins = rawBasins.map(raw => parsePersistedBasin(raw, assessment, budget));
    if (basins.some(basin => basin === null)) return [];
    const complete = basins as PwfdfBasinHazard[];
    return new Set(complete.map(basin => basin.id)).size === complete.length ? complete : [];
  } catch { return []; }
}

export function pwfdfLinkageBasinsFromSnapshot(
  snapshot: SourceSnapshot | undefined,
  incident: Pick<Incident, "id" | "selectedFire">,
): PwfdfBasinHazard[] {
  if (!snapshot || snapshot.incidentId !== incident.id) return [];
  const payload = snapshot.rawPayload;
  const selected = incident.selectedFire;
  const binding = recordValue(payload?.selectedFire);
  const assessment = parsePersistedAssessment(payload?.assessment);
  const discovery = recordValue(payload?.assessmentDiscovery);
  const name = normalizeFireName(selected.name);
  if (payload?.linkageVersion !== PWFDF_LINKAGE_VERSION || payload.available !== true ||
    discovery.version !== ARCGIS_INVENTORY_VERSION || discovery.complete !== true ||
    !Number.isSafeInteger(discovery.expectedCount) || Number(discovery.expectedCount) < 1 || Number(discovery.expectedCount) > 100_000 ||
    discovery.receivedCount !== discovery.expectedCount ||
    !selected.sourceKey || !selected.sourceFeatureId || selected.coverageStatus !== "available" ||
    binding.sourceKey !== selected.sourceKey || binding.sourceFeatureId !== selected.sourceFeatureId ||
    !name || typeof binding.name !== "string" || normalizeFireName(binding.name) !== name ||
    !assessment || normalizeFireName(assessment.fireName) !== name ||
    !Array.isArray(payload.basins) || !Number.isSafeInteger(payload.basinCount) ||
    payload.basins.length !== payload.basinCount || payload.basins.length > maxBasinFeatures) return [];
  const basins = pwfdfBasinsFromSnapshot(snapshot);
  // An assurance gate must not turn a partially parsed or ambiguous inventory green.
  if (basins.length !== payload.basins.length ||
    new Set(basins.map((basin) => basin.id)).size !== basins.length) return [];
  return basins;
}

export function linkPwfdfHazardsToAssets(
  assets: Asset[],
  assessment: PwfdfAssessment | undefined,
  basins: PwfdfBasinHazard[],
  sourceUrl?: string,
): Asset[] {
  const budget = geometryBudget();
  if (basins.length > maxBasinFeatures) throw new PwfdfGeometryError("pwfdf_geometry_budget");
  basins = basins.map(basin => ({ ...basin, geometry: validateBasinGeometry(basin.geometry, budget) }));
  const indexed = basins.map(basin => ({ basin, contains: prepareBasinContainment(basin.geometry, budget) }));
  return assets.map((asset) => {
    const cleanEvidence = (asset.evidence ?? []).filter(
      (item) => item.sourceKey !== "usgs-pwfdf",
    );
    const cleanMetrics = withoutPwfdfMetrics(asset.metrics);
    if (!assessment || basins.length === 0) {
      return { ...asset, evidence: cleanEvidence, metrics: cleanMetrics };
    }
    const matches = indexed
      .filter(item => item.contains(asset.coordinates))
      .map(item => item.basin)
      .sort((left, right) => hazardRank(right.combinedHazard) - hazardRank(left.combinedHazard));
    const basin = matches[0];
    if (!basin) return { ...asset, evidence: cleanEvidence, metrics: cleanMetrics };

    cleanEvidence.push({
      sourceKey: "usgs-pwfdf",
      sourceName: "USGS Post-Wildfire Debris-Flow Hazard Assessment",
      sourceUrl,
      sourceFeatureId: basin.id,
      summary: `${basin.combinedHazard} combined debris-flow hazard; probability ${basin.probabilityClass}; volume ${basin.volumeClass}; ${assessment.rainfallScenario ?? "published design rainfall"}.`,
    });

    return {
      ...asset,
      evidence: cleanEvidence,
      metrics: {
        ...cleanMetrics,
        pwfdfProbabilityClass: basin.probabilityClass,
        pwfdfVolumeClass: basin.volumeClass,
        pwfdfCombinedHazard: basin.combinedHazard,
        pwfdfAssessmentDate: basin.assessmentDate,
        pwfdfRainfallScenario: assessment.rainfallScenario,
      },
    };
  });
}

function withoutPwfdfMetrics(metrics: Asset["metrics"] = {}): Asset["metrics"] {
  // Refresh only this adapter's metrics; retain geometry provenance and other signals.
  const clean = { ...metrics };
  delete clean.pwfdfProbabilityClass;
  delete clean.pwfdfVolumeClass;
  delete clean.pwfdfCombinedHazard;
  delete clean.pwfdfAssessmentDate;
  delete clean.pwfdfRainfallScenario;
  return clean;
}

function arcgisFeatures(payload: unknown, label: string) {
  const record = recordValue(payload);
  const error = recordValue(record.error);
  const errorMessage = stringValue(error.message);
  if (errorMessage) throw new Error(`USGS PWFDF ${label} query failed: ${errorMessage}`);
  if (!Array.isArray(record.features)) {
    throw new Error(`USGS PWFDF ${label} response did not include a features array.`);
  }
  return record.features.map((feature) => recordValue(feature));
}

function parsePersistedAssessment(value: unknown): PwfdfAssessment | null {
  const record = recordValue(value);
  const fireName = stringValue(record.fireName);
  const fireId = stringValue(record.fireId);
  const assessmentDate = dateValue(record.assessmentDate);
  if (!fireName || !fireId || !assessmentDate) return null;
  return {
    fireName,
    fireId,
    assessmentDate,
    status: stringValue(record.status),
    rainfallScenario: stringValue(record.rainfallScenario),
    startDate: dateValue(record.startDate),
    scienceBaseUrl: safeHttpsUrl(record.scienceBaseUrl),
  };
}

function parsePersistedBasin(
  value: unknown,
  assessment: PwfdfAssessment,
  budget: GeometryBudget,
): PwfdfBasinHazard | null {
  const record = recordValue(value);
  const id = stringValue(record.id);
  const fireId = stringValue(record.fireId);
  const assessmentDate = dateValue(record.assessmentDate);
  const probabilityClass = stringValue(record.probabilityClass);
  const volumeClass = stringValue(record.volumeClass);
  const combinedHazard = combinedHazardValue(record.combinedHazard);
  const geometry = validateBasinGeometry(record.geometry, budget);
  if (
    !id || fireId !== assessment.fireId || !assessmentDate || !probabilityClass ||
    !volumeClass || !combinedHazard
  ) return null;
  return {
    id,
    fireId,
    assessmentDate,
    version: stringValue(record.version),
    probabilityClass,
    volumeClass,
    combinedHazard,
    geometry,
  };
}

function normalizeFireName(value: string) {
  return value
    .toLowerCase()
    .replace(/\bfire\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function combinedHazardValue(value: unknown): PwfdfBasinHazard["combinedHazard"] | undefined {
  if (value === "Low" || value === "Moderate" || value === "High") return value;
  return undefined;
}

function dateValue(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeHttpsUrl(value: unknown) {
  const text = stringValue(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberId(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hazardRank(value: PwfdfBasinHazard["combinedHazard"]) {
  return value === "High" ? 3 : value === "Moderate" ? 2 : 1;
}
