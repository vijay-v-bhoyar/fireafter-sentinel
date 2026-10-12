import { UNKNOWN_RISK_ACTION } from "./scoring";
import { compareRecommendations } from "./recommendation-order";
import { linkPwfdfHazardsToAssets } from "./pwfdf";
import { PWFDF_ANALYSIS_GEOMETRY_VERSION, PWFDF_ANALYSIS_GEOMETRY_FAILURE, PWFDF_ANALYSIS_GEOMETRY_MESSAGE } from "./pwfdf-geometry";
import type { Asset, Incident, Recommendation, SourceSnapshot } from "./types";

export const DEFAULT_EVIDENCE_MAX_AGE_MINUTES = 30;
export const MTBS_INTERPRETATION_VERSION = "2026-09-12-source-semantics-v1";
export const EXPIRED_EVIDENCE_MESSAGE = "Source evidence has expired or its time cannot be verified. Refresh and review the evidence before relying on this ranking.";

export function publicationTimeIsValid(value: unknown, now: Date): boolean {
  const published = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(published) && Number.isFinite(now.getTime()) && published <= now.getTime();
}

function invalidRecordedPublication(value: unknown, now: Date): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const record = value as Record<string, unknown>;
  return !publicationTimeIsValid(record.assessmentDate, now);
}

export function evidenceMaxAgeMinutes(value: unknown = process.env.FIREAFTER_CACHE_TTL_MINUTES) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440
    ? minutes : DEFAULT_EVIDENCE_MAX_AGE_MINUTES;
}

// Use after freshness projection; reachability alone does not establish usable evidence.
export function hasCurrentSourceEvidence(source: SourceSnapshot): boolean {
  return source.freshness?.state === "current" && source.status === "online" &&
    !source.stale && source.coverageStatus === "available";
}

export function projectSourceFreshness(
  source: SourceSnapshot,
  now: Date,
  maxAgeMinutes = DEFAULT_EVIDENCE_MAX_AGE_MINUTES,
): SourceSnapshot {
  if (["wfigs", "wfigs-ytd", "firms", "mtbs-burn-severity"].includes(source.sourceKey ?? "")) {
    source = { ...source, derivedSignals: { ...source.derivedSignals, burnSeverity: undefined } };
  }
  if (source.sourceKey === "mtbs-burn-severity" && source.rawPayload?.interpretationVersion !== MTBS_INTERPRETATION_VERSION) {
    source = {
      ...source, status: "delayed", stale: true, coverageStatus: "not_available",
      detail: "Legacy MTBS interpretation requires refresh. Boundary records do not establish incident burn severity.",
      warnings: ["Refresh source interpretation; integrate validated fire-linked severity measurements before using burn severity."],
    };
  }
  const fetched = Date.parse(source.fetchedAt);
  const nowMs = now.getTime();
  const maximum = evidenceMaxAgeMinutes(maxAgeMinutes);
  const fetchValid = Number.isFinite(fetched) && Number.isFinite(nowMs) && fetched <= nowMs;
  const validUntil = source.validUntil === undefined ? Infinity : Date.parse(source.validUntil);
  const forecast = source.sourceKey === "nws" || source.sourceKey === "nws-forecast";
  const pwfdf = source.sourceKey === "usgs-pwfdf" && source.coverageStatus === "available";
  const payload = source.rawPayload ?? {};
  const analysisInvalid = source.sourceKey === "usgs-pwfdf" &&
    (pwfdf || payload.failureCode === PWFDF_ANALYSIS_GEOMETRY_FAILURE) &&
    payload.analysisGeometryVersion !== PWFDF_ANALYSIS_GEOMETRY_VERSION;
  const basins = source.rawPayload?.basins;
  // Legacy PWFDF snapshots lack the marker; their provider dates still require validation.
  const providerInvalid = ((source.sourceTimeBasis === "provider" || pwfdf) &&
    !publicationTimeIsValid(source.sourceUpdatedAt, now)) ||
    (pwfdf && (("assessment" in payload && invalidRecordedPublication(payload.assessment, now)) ||
      ("basins" in payload && (!Array.isArray(basins) || basins.some(basin => invalidRecordedPublication(basin, now)))))) ||
    (forecast && (source.sourceTimeBasis !== "provider" || source.validUntil === undefined));
  const expires = Math.min(fetched + maximum * 60_000, validUntil);
  const state = !fetchValid || Number.isNaN(validUntil) || providerInvalid || analysisInvalid
    ? "invalid" : nowMs >= expires ? "expired" : "current";
  const ageMinutes = fetchValid ? Math.floor((nowMs - fetched) / 60_000) : null;
  const freshnessLabel = state === "invalid" ? "Check time unavailable or invalid"
    : state === "expired" ? `Check expired (${ageMinutes} min since retrieval)`
      : `Checked ${ageMinutes} min ago${source.stale ? "; source remains limited" : ""}`;
  return {
    ...source,
    status: state === "current" ? source.status : source.status === "offline" ? "offline" : "delayed",
    stale: source.stale || state !== "current",
    freshnessLabel,
    ...(analysisInvalid ? {
      coverageStatus: "not_available" as const,
      detail: PWFDF_ANALYSIS_GEOMETRY_MESSAGE,
      warnings: [...new Set([...(source.warnings ?? []), PWFDF_ANALYSIS_GEOMETRY_MESSAGE])],
      rawPayload: { ...payload, available: false, failureCode: PWFDF_ANALYSIS_GEOMETRY_FAILURE },
    } : {}),
    ...(forecast && state !== "current" ? {
      detail: "NWS forecast evidence is expired or its time cannot be verified. Refresh before using rainfall or alert summaries.",
      derivedSignals: { ...source.derivedSignals, rainfallThreat: undefined, activeAlerts: undefined },
    } : {}),
    freshness: {
      state, evaluatedAt: Number.isFinite(nowMs) ? now.toISOString() : "",
      expiresAt: fetchValid && Number.isFinite(expires) ? new Date(expires).toISOString() : null,
      maxAgeMinutes: maximum,
    },
  };
}

export function projectRecommendationFreshness(
  recommendations: Recommendation[],
  sources: SourceSnapshot[],
  now: Date,
): Recommendation[] {
  const expired = sources.length === 0 || sources.some((source) => source.freshness?.state !== "current");
  const unverifiedBasins = sources.some(source => source.sourceKey === "usgs-pwfdf" &&
    source.rawPayload?.failureCode === PWFDF_ANALYSIS_GEOMETRY_FAILURE);
  const ages = sources.map((source) => (now.getTime() - Date.parse(source.sourceUpdatedAt || source.fetchedAt)) / 3_600_000)
    .filter((age) => Number.isFinite(age) && age >= 0);
  return recommendations.map((recommendation): Recommendation => ({
    ...recommendation,
    ...(unverifiedBasins ? { evidence: recommendation.evidence?.filter(item => item.sourceKey !== "usgs-pwfdf") } : {}),
    sourcesUpdatedLabel: expired ? "Evidence expired or time unverified" : "Source checks current",
    dataFreshnessHours: ages.length ? Math.round(Math.max(...ages) * 100) / 100 : recommendation.dataFreshnessHours,
    ...(expired ? {
      riskLevel: "Unknown",
      confidenceLevel: "Low",
      recommendedAction: UNKNOWN_RISK_ACTION,
      reasonCodes: [...new Set(["Source evidence expired or time unverified", ...recommendation.reasonCodes.filter((reason) => reason !== "Fresh Source Data")])],
      limitations: [...new Set([EXPIRED_EVIDENCE_MESSAGE, ...recommendation.limitations])],
      scoreBreakdown: {
        ...recommendation.scoreBreakdown,
        scoreBasis: recommendation.scoreBreakdown.scoreBasis === "legacy-unassessed" ? "legacy-unassessed" : "review-only",
        dataFreshness: 0,
        confidenceMultiplier: Math.min(recommendation.scoreBreakdown.confidenceMultiplier, 0.49),
        metricStatus: {
          rainfallThreat: "not_available", burnSeverity: "not_available",
          slopeTerrain: "not_available", downstreamExposure: "not_available",
          dataFreshness: "not_available",
        },
      },
    } : {}),
  })).sort(compareRecommendations);
}

export function projectBundleFreshness<T extends {
  incident: Incident; sourceSnapshots: SourceSnapshot[]; recommendations: Recommendation[]; assets?: Asset[];
}>(bundle: T, now = new Date(), maxAgeMinutes = DEFAULT_EVIDENCE_MAX_AGE_MINUTES): T {
  const sourceSnapshots = bundle.sourceSnapshots.map((source) => projectSourceFreshness(source, now, maxAgeMinutes));
  const unverifiedBasins = sourceSnapshots.some(source => source.sourceKey === "usgs-pwfdf" &&
    source.rawPayload?.failureCode === PWFDF_ANALYSIS_GEOMETRY_FAILURE);
  const expired = sourceSnapshots.length === 0 || sourceSnapshots.some((source) => source.freshness?.state !== "current");
  const weatherCurrent = sourceSnapshots.some((source) => source.sourceKey === "nws" && source.freshness?.state === "current");
  return {
    ...bundle,
    incident: {
      ...bundle.incident,
      ...(!weatherCurrent ? { alertCoverageStatus: "unavailable" as const, rainfallForecast: "Rainfall unavailable or expired" } : {}),
      ...(expired ? { status: "Stale Data" as const, dataFreshness: "Low" as const } : {}),
    },
    sourceSnapshots,
    ...(unverifiedBasins && bundle.assets ? { assets: linkPwfdfHazardsToAssets(bundle.assets, undefined, []) } : {}),
    recommendations: projectRecommendationFreshness(bundle.recommendations, sourceSnapshots, now),
  };
}
