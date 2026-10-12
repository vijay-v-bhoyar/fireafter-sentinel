export function validateAuthenticatedRefreshEvidence(payload, incidentId) {
  const incident = recordValue(payload?.incident);
  if (incident.id !== incidentId) {
    return { ok: false, failure: "incident_mismatch" };
  }

  const sourceSnapshots = Array.isArray(payload?.sourceSnapshots)
    ? payload.sourceSnapshots
    : [];
  const pwfdf = sourceSnapshots.find(
    (source) => source?.sourceKey === "usgs-pwfdf",
  );
  const basinCount = numberValue(recordValue(pwfdf?.rawPayload).basinCount);
  if (pwfdf?.coverageStatus !== "available" || basinCount < 1) {
    return { ok: false, failure: "validated_pwfdf_basin_layer_missing" };
  }

  const linkedRecommendationCount = (Array.isArray(payload?.recommendations)
    ? payload.recommendations
    : []
  ).filter((recommendation) =>
    Array.isArray(recommendation?.evidence) &&
    recommendation.evidence.some(
      (evidence) =>
        evidence?.sourceKey === "usgs-pwfdf" &&
        typeof evidence.sourceFeatureId === "string" &&
        evidence.sourceFeatureId.length > 0,
    )
  ).length;
  if (linkedRecommendationCount < 1) {
    return { ok: false, failure: "basin_linked_recommendation_missing" };
  }

  return { ok: true, basinCount, linkedRecommendationCount };
}

export function validateAuthenticatedReadinessEvidence(payload) {
  const gate = Array.isArray(payload?.productPromise)
    ? payload.productPromise.find((candidate) => candidate?.id === "basin_asset_linkage")
    : undefined;
  return gate?.status === "pass"
    ? { ok: true }
    : { ok: false, failure: "basin_asset_linkage_not_pass" };
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
