import type { Incident, Recommendation, SourceSnapshot } from "./types";
import { evidenceMaxAgeMinutes, projectBundleFreshness } from "./source-freshness";

export type FireAfterGeoJsonFeature = {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
  properties: {
    id: string;
    incidentId: string;
    assetId: string;
    assetName: string;
    assetType: string;
    locationLabel: string;
    recommendedAction: string;
    riskLevel: string;
    score100: number;
    confidenceLevel: string;
    scoringVersion?: string;
    scoreBasis?: string;
    changedSinceLastRefresh: string;
    sourcesUpdatedLabel: string;
    dataFreshnessHours: number;
    reasonCodes: string[];
    limitations: string[];
    evidence: string[];
    sourceSnapshotIds: string[];
  };
};

export type FireAfterGeoJsonExport = {
  type: "FeatureCollection";
  name: string;
  generatedAt: string;
  fireafter: {
    incidentId: string;
    county: string;
    state: string;
    stormWindow: string;
    decisionSupport: true;
    disclaimer: string;
    sourceFreshness: Array<{
      sourceKey?: string;
      sourceName: string;
      status: string;
      stale: boolean;
      freshnessLabel: string;
      sourceUpdatedAt: string;
      fetchedAt: string;
      sourceTimeBasis?: SourceSnapshot["sourceTimeBasis"];
      freshness?: SourceSnapshot["freshness"];
    }>;
  };
  features: FireAfterGeoJsonFeature[];
};

export function dashboardBundleToGeoJson(input: {
  incident: Incident;
  recommendations: Recommendation[];
  sourceSnapshots: SourceSnapshot[];
  generatedAt?: string;
}): FireAfterGeoJsonExport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  input = projectBundleFreshness(input, new Date(generatedAt), evidenceMaxAgeMinutes());

  return {
    type: "FeatureCollection",
    name: `FireAfter ${input.incident.county} action queue`,
    generatedAt,
    fireafter: {
      incidentId: input.incident.id,
      county: input.incident.county,
      state: input.incident.state,
      stormWindow: input.incident.stormWindow,
      decisionSupport: true,
      disclaimer:
        "FireAfter exports decision-support recommendations for operational review; it does not issue closures, evacuations, or emergency orders.",
      sourceFreshness: input.sourceSnapshots.map((source) => ({
        sourceKey: source.sourceKey,
        sourceName: source.sourceName,
        status: source.status,
        stale: source.stale,
        freshnessLabel: source.freshnessLabel,
        sourceUpdatedAt: source.sourceUpdatedAt,
        fetchedAt: source.fetchedAt,
        sourceTimeBasis: source.sourceTimeBasis,
        freshness: source.freshness,
      })),
    },
    features: recommendationsToGeoJson(input.recommendations),
  };
}

export function recommendationsToGeoJson(
  recommendations: Recommendation[],
): FireAfterGeoJsonFeature[] {
  return recommendations.flatMap((recommendation) => {
    const [longitude, latitude] = recommendation.coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];

    return [
      {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [longitude, latitude],
        },
        properties: {
          id: recommendation.id,
          incidentId: recommendation.incidentId,
          assetId: recommendation.assetId,
          assetName: recommendation.assetName,
          assetType: recommendation.assetType,
          locationLabel: recommendation.locationLabel,
          recommendedAction: recommendation.recommendedAction,
          riskLevel: recommendation.riskLevel,
          score100: recommendation.score100,
          confidenceLevel: recommendation.confidenceLevel,
          scoringVersion: recommendation.scoreBreakdown.scoringVersion,
          scoreBasis: recommendation.scoreBreakdown.scoreBasis,
          changedSinceLastRefresh: recommendation.changedSinceLastRefresh,
          sourcesUpdatedLabel: recommendation.sourcesUpdatedLabel,
          dataFreshnessHours: recommendation.dataFreshnessHours,
          reasonCodes: recommendation.reasonCodes,
          limitations: recommendation.limitations,
          evidence: (recommendation.evidence ?? []).map((evidence) =>
            `${evidence.sourceName}: ${evidence.summary}`,
          ),
          sourceSnapshotIds: recommendation.sourceSnapshotIds ?? [],
        },
      },
    ];
  });
}

export function geoJsonFileName(incident: Incident) {
  const safeCounty = incident.county
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `fireafter-${safeCounty || "incident"}-${incident.state.toLowerCase()}-action-queue.geojson`;
}
