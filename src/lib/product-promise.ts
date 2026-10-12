import { buildRecommendationClarity } from "./recommendation-clarity";
import { pwfdfLinkageBasinsFromSnapshot } from "./pwfdf";
import { geometryBudget, prepareBasinContainment, PwfdfGeometryError } from "./pwfdf-geometry";
import { evidenceMaxAgeMinutes, projectSourceFreshness } from "./source-freshness";
import { hasCurrentCrossingGeometry } from "./source-line-geometry";
import { buildSourceCoverageMatrix } from "./source-coverage";
import type {
  AuditEvent,
  Recommendation,
  ResponderAction,
} from "./types";
import type { ReadinessBundle } from "./readiness";

export type ProductPromiseGateId =
  | "data_integration"
  | "geospatial_view"
  | "basin_asset_linkage"
  | "ranked_action_queue"
  | "responsible_handling"
  | "auditability";

export type ProductPromiseGate = {
  id: ProductPromiseGateId;
  label: string;
  status: "pass" | "gap";
  evidence: string[];
  gaps: string[];
  nextAction: string;
};

export function buildProductPromiseAudit(
  bundle: ReadinessBundle,
  evaluatedAt = new Date(),
): ProductPromiseGate[] {
  return [
    dataIntegrationGate(bundle),
    geospatialViewGate(bundle),
    basinAssetLinkageGate(bundle, evaluatedAt),
    rankedActionQueueGate(bundle),
    responsibleHandlingGate(bundle),
    auditabilityGate(bundle),
  ];
}

function dataIntegrationGate(bundle: ReadinessBundle): ProductPromiseGate {
  const coverageMatrix = buildSourceCoverageMatrix(bundle);
  const gaps: string[] = [];
  const evidence: string[] = [];
  const categories = new Set(coverageMatrix.map((item) => item.category));
  const explainedItems = coverageMatrix.filter(
    (item) => item.status && item.limitation && item.nextAction,
  );

  if (bundle.sourceSnapshots.length === 0) {
    gaps.push("Run Refresh so live, delayed, or unavailable source states are recorded.");
  }
  if (categories.size < 6 || explainedItems.length !== coverageMatrix.length) {
    gaps.push("Every planned source category needs status, limitation, and next action text.");
  }
  if (coverageMatrix.length > 0) {
    evidence.push(`${coverageMatrix.length} planned source items are classified.`);
  }
  if (bundle.sourceSnapshots.length > 0) {
    evidence.push(`${bundle.sourceSnapshots.length} source snapshot${bundle.sourceSnapshots.length === 1 ? "" : "s"} recorded.`);
  }

  return gate({
    id: "data_integration",
    label: "Data integration",
    gaps,
    evidence,
    nextAction: "Refresh the incident and review Data Source Coverage for delayed or unavailable feeds.",
  });
}

function geospatialViewGate(bundle: ReadinessBundle): ProductPromiseGate {
  const gaps: string[] = [];
  const evidence: string[] = [];

  if (!bundle.incident.locationContext?.bbox && !bundle.incident.locationContext?.boundary) {
    gaps.push("County boundary, bbox, or centroid context is required for the common geospatial view.");
  } else {
    evidence.push("County geospatial context is loaded.");
  }
  if (!hasSource(bundle, "tiger-roads")) {
    gaps.push("Road geometry must be loaded or explicitly unavailable before map review.");
  }
  if (!hasSource(bundle, "3dhp-flowlines")) {
    gaps.push("Hydrography/flowline geometry must be loaded or explicitly unavailable before map review.");
  }
  if (bundle.assets.length === 0 || bundle.recommendations.length === 0) {
    gaps.push("Map view needs assets and ranked recommendations when source coverage supports them.");
  } else {
    evidence.push(`${bundle.assets.length} asset${bundle.assets.length === 1 ? "" : "s"} and ${bundle.recommendations.length} recommendation${bundle.recommendations.length === 1 ? "" : "s"} are available for map context.`);
  }

  return gate({
    id: "geospatial_view",
    label: "Geospatial view",
    gaps,
    evidence,
    nextAction: "Refresh public road/hydro layers or upload local assets, then verify /map.",
  });
}

function basinAssetLinkageGate(bundle: ReadinessBundle, evaluatedAt: Date): ProductPromiseGate {
  const gaps: string[] = [];
  const evidence: string[] = [];
  const canRefresh = ["incident_commander", "analyst"].includes(
    bundle.currentUser?.role ?? "",
  );
  const hasFireContext = hasAnySource(bundle, ["wfigs", "firms", "mtbs-burn-severity"]);
  const hasAssetContext = hasAnySource(bundle, ["tiger-roads", "3dhp-flowlines", "local-upload"]) ||
    bundle.assets.some((asset) => asset.localOrUploaded || asset.sourceFeatureIds?.length);
  const candidates = bundle.sourceSnapshots.filter((source) => source.sourceKey === "usgs-pwfdf");
  const pwfdfSource = candidates.length === 1
    ? projectSourceFreshness(candidates[0], evaluatedAt, evidenceMaxAgeMinutes()) : undefined;
  const basins = pwfdfSource?.freshness?.state === "current" && !pwfdfSource.stale && pwfdfSource.status === "online"
    ? pwfdfLinkageBasinsFromSnapshot(pwfdfSource, bundle.incident) : [];
  const basinById = new Map(basins.map((basin) => [basin.id, basin]));
  const basinIds = new Set(basinById.keys());
  const fireCandidates = bundle.incident.fireCandidates ?? [];
  const hasPublishedFireCandidate = fireCandidates.some(
    (candidate) => Boolean(candidate.sourceKey && candidate.sourceFeatureId),
  );
  const selectedFireStillPublished = fireCandidates.some(
    (candidate) =>
      candidate.sourceKey === bundle.incident.selectedFire.sourceKey &&
      candidate.sourceFeatureId === bundle.incident.selectedFire.sourceFeatureId,
  );
  const needsFireContextSelection =
    hasPublishedFireCandidate && !selectedFireStillPublished;
  const assetById = new Map(bundle.assets.map((asset) => [asset.id, asset]));
  const duplicateAssets = new Set<string>();
  const seenAssets = new Set<string>();
  for (const asset of bundle.assets) {
    if (seenAssets.has(asset.id)) duplicateAssets.add(asset.id);
    seenAssets.add(asset.id);
  }
  const claims = (item: { evidence?: Recommendation["evidence"] }) =>
    (item.evidence ?? []).filter((evidence) => evidence.sourceKey === "usgs-pwfdf");
  const assetBasinIds = new Map<string, Set<string>>();
  const basinBudget = geometryBudget();
  try {
  const containing = new Map(basins.map(basin => [basin.id, prepareBasinContainment(basin.geometry, basinBudget)]));
  for (const asset of bundle.assets) {
    if (!asset.id || duplicateAssets.has(asset.id) || asset.incidentId !== bundle.incident.id ||
      !hasCurrentCrossingGeometry(asset)) continue;
    const ids = new Set<string>();
    const evidence = claims(asset);
    for (const item of evidence) {
      const basin = basinById.get(item.sourceFeatureId ?? "");
      if (basin && containing.get(basin.id)?.(asset.coordinates)) ids.add(basin.id);
    }
    if (evidence.length > 0 && evidence.every((item) => ids.has(item.sourceFeatureId ?? ""))) {
      assetBasinIds.set(asset.id, ids);
    }
  }
  } catch (error) {
    if (!(error instanceof PwfdfGeometryError)) throw error;
    return gate({ id: "basin_asset_linkage", label: "Basin-to-asset linkage", gaps: [error.message], evidence: [], nextAction: error.message });
  }
  const linkedAssets = bundle.assets.filter((asset) => assetBasinIds.has(asset.id));
  const recommendationIdCounts = new Map<string, number>();
  for (const recommendation of bundle.recommendations) {
    recommendationIdCounts.set(recommendation.id, (recommendationIdCounts.get(recommendation.id) ?? 0) + 1);
  }
  const linkedRecommendations = bundle.recommendations.filter((recommendation) => {
    const asset = assetById.get(recommendation.assetId);
    const evidence = claims(recommendation);
    return asset && recommendation.id && recommendationIdCounts.get(recommendation.id) === 1 &&
      recommendation.incidentId === bundle.incident.id &&
      recommendation.assetType === asset.type &&
      recommendation.coordinates[0] === asset.coordinates[0] && recommendation.coordinates[1] === asset.coordinates[1] &&
      Boolean(pwfdfSource && recommendation.sourceSnapshotIds?.includes(pwfdfSource.id)) &&
      evidence.length > 0 && evidence.every((item) => assetBasinIds.get(asset.id)?.has(item.sourceFeatureId ?? ""));
  });
  const brokenClaims = bundle.recommendations.filter((item) => claims(item).length > 0).length - linkedRecommendations.length;
  const brokenAssetClaims = bundle.assets.filter((item) => claims(item).length > 0).length - linkedAssets.length;
  const hasNoAssetOverlap =
    basinIds.size > 0 && bundle.assets.length > 0 && linkedAssets.length === 0;
  const recommendedAssetIds = new Set(linkedRecommendations.map((recommendation) => recommendation.assetId));
  const recommendationEvidenceDropped =
    linkedAssets.some((asset) => !recommendedAssetIds.has(asset.id));

  if (!hasFireContext) {
    gaps.push("Burned-basin/fire context from WFIGS, FIRMS, or MTBS must be visible.");
  }
  if (!hasAssetContext) {
    gaps.push("Downstream road, hydrography, inferred crossing, or uploaded asset context must be visible.");
  }
  if (basinIds.size === 0) {
    gaps.push("A validated USGS PWFDF combined-hazard basin layer must be available for the selected fire.");
    gaps.push("Refresh to obtain current, complete PWFDF evidence bound to this incident's selected fire; legacy, stale, partial or ambiguous snapshots cannot prove linkage.");
  }
  if (needsFireContextSelection) gaps.push("The selected fire is no longer among the published perimeter candidates; select and refresh current fire context.");
  if (brokenClaims > 0) gaps.push(`${brokenClaims} recommendation basin link(s) fail incident, asset, geometry, evidence or current-snapshot verification. Refresh and review the affected links.`);
  if (brokenAssetClaims > 0) gaps.push(`${brokenAssetClaims} asset basin link(s) cannot be verified against current incident and basin geometry. Refresh and review the affected links.`);
  if (bundle.recommendations.length === 0 || linkedRecommendations.length === 0) {
    gaps.push("At least one recommendation must reference the exact USGS PWFDF basin polygon containing its asset.");
  }
  if (linkedRecommendations.length > 0) {
    evidence.push(`${linkedRecommendations.length} recommendation${linkedRecommendations.length === 1 ? "" : "s"} have matching incident, asset coordinates, current source snapshot and containing PWFDF basin evidence.`);
  }
  if (hasNoAssetOverlap) {
    evidence.push(`${basinIds.size} validated USGS PWFDF basin${basinIds.size === 1 ? "" : "s"} and ${bundle.assets.length} asset${bundle.assets.length === 1 ? "" : "s"} are loaded, but no current asset-to-basin evidence link can be verified.`);
  }
  if (recommendationEvidenceDropped) {
    gaps.push("A basin-linked asset exists, but its recommendation lost the exact PWFDF feature evidence.");
  }

  return gate({
    id: "basin_asset_linkage",
    label: "Basin-to-asset linkage",
    gaps,
    evidence,
    nextAction: needsFireContextSelection
      ? canRefresh
        ? "Select a currently published WFIGS current or year-to-date perimeter in Fire context, then run Refresh to load its USGS PWFDF basin evidence."
        : "Sign in with an operator-issued incident commander or analyst account, select a currently published WFIGS current or year-to-date perimeter in Fire context, then run Refresh to load its USGS PWFDF basin evidence."
      : recommendationEvidenceDropped
        ? canRefresh
          ? "Refresh the incident bundle so recommendation evidence is rebuilt from the basin-linked asset, then confirm the exact PWFDF feature ID is preserved."
          : "Sign in with an operator-issued incident commander or analyst account, then refresh the incident bundle so recommendation evidence is rebuilt from the basin-linked asset."
        : hasNoAssetOverlap
          ? canRefresh
            ? "No current asset-to-basin link is verified. Review overlapping source assets for the selected fire or upload a validated local asset inside a returned basin, then run Refresh."
            : "Sign in with an operator-issued incident commander or analyst account, then select a published fire perimeter with overlapping source assets or upload a validated local asset inside a returned basin and run Refresh."
          : canRefresh
            ? "Refresh USGS PWFDF for the selected fire, then confirm a ranked asset falls inside and references a returned basin polygon."
            : "Sign in with an operator-issued incident commander or analyst account, then run Refresh and confirm a ranked asset references a returned PWFDF basin polygon.",
  });
}

function rankedActionQueueGate(bundle: ReadinessBundle): ProductPromiseGate {
  const gaps: string[] = [];
  const evidence: string[] = [];
  const topRecommendations = bundle.recommendations.slice(0, 3);
  const completeTopRecommendations = topRecommendations.filter(hasRankedItemClarity);

  if (bundle.recommendations.length === 0) {
    gaps.push("Create at least one source-backed or uploaded-asset recommendation.");
  } else if (completeTopRecommendations.length !== topRecommendations.length) {
    gaps.push("Top recommendations need visible reason codes, source timestamps, limitations, and evidence.");
  }
  if (completeTopRecommendations.length > 0) {
    evidence.push(`${completeTopRecommendations.length} top recommendation${completeTopRecommendations.length === 1 ? "" : "s"} answer the ranked-item checklist.`);
  }

  return gate({
    id: "ranked_action_queue",
    label: "Ranked action queue",
    gaps,
    evidence,
    nextAction: "Open the Action Queue and verify each top card shows asset, review action, reasons, freshness, confidence, limitations, and evidence.",
  });
}

function responsibleHandlingGate(bundle: ReadinessBundle): ProductPromiseGate {
  const gaps: string[] = [];
  const evidence: string[] = [];
  const unsafeText = bundle.recommendations.some((recommendation) =>
    hasUnsafeEmergencyCommandLanguage([
      recommendation.recommendedAction,
      ...recommendation.reasonCodes,
      ...recommendation.limitations,
    ]),
  );

  if (unsafeText) {
    gaps.push("Remove automatic closure, evacuation order, or exact-prediction language from recommendation copy.");
  } else {
    evidence.push("Recommendation copy stays in decision-support/review language.");
  }
  if (bundle.currentUser) {
    evidence.push(`Authenticated response context: ${bundle.currentUser.role ?? "member"}.`);
  }

  return gate({
    id: "responsible_handling",
    label: "Responsible handling",
    gaps,
    evidence,
    nextAction: "Keep all operational copy framed as review/support, not command automation.",
  });
}

function auditabilityGate(bundle: ReadinessBundle): ProductPromiseGate {
  const gaps: string[] = [];
  const evidence: string[] = [];
  const completeActions = bundle.actions.filter((action) =>
    action.actorName &&
    action.createdAt &&
    action.note &&
    hasRankedItemClarity(action.recommendationSnapshot) &&
    hasMatchingAuditSnapshot(action, bundle.auditEvents),
  );

  if (bundle.actions.length === 0) {
    gaps.push("Record at least one accepted or modified responder action.");
  } else if (completeActions.length !== bundle.actions.length) {
    gaps.push("Responder actions must preserve actor, timestamp, note, recommendation snapshot, and source evidence.");
  }
  if (completeActions.length > 0) {
    evidence.push(`${completeActions.length} responder action${completeActions.length === 1 ? "" : "s"} preserve audit-ready snapshots.`);
  }

  return gate({
    id: "auditability",
    label: "Auditability",
    gaps,
    evidence,
    nextAction: "Accept or modify a recommendation, then confirm History & Audit shows the immutable snapshot.",
  });
}

function gate(input: Omit<ProductPromiseGate, "status">): ProductPromiseGate {
  return {
    ...input,
    status: input.gaps.length > 0 ? "gap" : "pass",
  };
}

function hasRankedItemClarity(recommendation: Recommendation) {
  const clarity = buildRecommendationClarity(recommendation);
  const clarityValuesPresent = clarity.every((item) => item.value.trim().length > 0);
  return (
    clarityValuesPresent &&
    recommendation.reasonCodes.length > 0 &&
    recommendation.sourcesUpdatedLabel.trim().length > 0 &&
    recommendation.confidenceLevel.trim().length > 0 &&
    recommendation.limitations.length > 0 &&
    ((recommendation.evidence?.length ?? 0) > 0 ||
      (recommendation.sourceSnapshotIds?.length ?? 0) > 0)
  );
}

function hasUnsafeEmergencyCommandLanguage(values: string[]) {
  const text = values.join(" ").toLowerCase();
  return [
    /\bautomatically\s+(close|order|evacuat)/,
    /\border\s+evacuat/,
    /\bissue\s+(closure|evacuation|emergency)\s+order/,
    /\bclosure\s+review\b/,
    /\bpredict(s|ed|ing)?\s+exact\s+debris/,
  ].some((pattern) => pattern.test(text));
}

function hasMatchingAuditSnapshot(
  action: ResponderAction,
  auditEvents: AuditEvent[],
) {
  return auditEvents.some((event) => {
    const payloadSnapshot = event.payload.recommendationSnapshot;
    if (!payloadSnapshot || typeof payloadSnapshot !== "object") return false;
    const snapshot = payloadSnapshot as Partial<Recommendation>;
    return (
      event.recommendationId === action.recommendationId &&
      event.actorName.trim().length > 0 &&
      event.createdAt.trim().length > 0 &&
      snapshot.id === action.recommendationId &&
      (snapshot.evidence?.length ?? 0) > 0
    );
  });
}

function hasSource(bundle: ReadinessBundle, sourceKey: string) {
  return bundle.sourceSnapshots.some((source) => source.sourceKey === sourceKey);
}

function hasAnySource(bundle: ReadinessBundle, sourceKeys: string[]) {
  return sourceKeys.some((sourceKey) => hasSource(bundle, sourceKey));
}
