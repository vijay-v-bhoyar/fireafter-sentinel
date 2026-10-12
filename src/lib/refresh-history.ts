import type { Asset, Recommendation, SourceSnapshot } from "./types";

export const REFRESH_RECOMMENDATION_SELECT = "*,asset:assets(id,incident_id,name,asset_type,location_label,local_or_uploaded,origin,source_key,coordinates:properties->coordinates,domainAssetId:properties->>domainAssetId,propertySourceKey:properties->>sourceKey)";

// Private refresh inputs, not a public projection or a new evidence assessment.
export type PreviousRecommendation = Pick<Recommendation,
  "id" | "assetId" | "assetName" | "assetType" | "locationLabel" | "riskLevel" | "score100">;
export type PreviousSource = Pick<SourceSnapshot,
  "sourceKey" | "sourceName" | "status" | "stale" | "freshnessLabel">;
export type PreviousTerrain = Pick<Asset, "id" | "coordinates" | "sourceKey" | "origin" | "localOrUploaded" | "evidence"> & {
  metrics?: Pick<NonNullable<Asset["metrics"]>,
    "slopeTerrain" | "elevationChangeMeters" | "elevationSampleMeters" | "elevationSampledAt">;
};

export function previousRecommendation(value: Recommendation): PreviousRecommendation {
  const { id, assetId, assetName, assetType, locationLabel, riskLevel, score100 } = value;
  return { id, assetId, assetName, assetType, locationLabel, riskLevel, score100 };
}
export function previousSource(value: SourceSnapshot): PreviousSource {
  const { sourceKey, sourceName, status, stale, freshnessLabel } = value;
  return { sourceKey, sourceName, status, stale, freshnessLabel };
}
export function previousTerrain(value: Asset): PreviousTerrain | null {
  const { id, coordinates, sourceKey, origin, localOrUploaded, metrics } = value;
  if (!metrics?.elevationSampledAt || metrics.slopeTerrain === undefined ||
    metrics.elevationChangeMeters === undefined || !metrics.elevationSampleMeters) return null;
  const evidence = value.evidence?.filter(item => item.sourceKey === "usgs-epqs" && item.sourceName.startsWith("USGS"));
  if (!evidence?.length) return null;
  const { slopeTerrain, elevationChangeMeters, elevationSampleMeters, elevationSampledAt } = metrics;
  return { id, coordinates, sourceKey, origin, localOrUploaded, evidence,
    metrics: { slopeTerrain, elevationChangeMeters, elevationSampleMeters, elevationSampledAt } };
}
