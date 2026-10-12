import type { Recommendation } from "./types";

export type RecommendationClarityKey =
  | "asset"
  | "why"
  | "change"
  | "freshness"
  | "confidence"
  | "action";

export type RecommendationClarityItem = {
  key: RecommendationClarityKey;
  label: string;
  value: string;
  detail?: string;
};

export type RecommendationClarityChecklistEntry = {
  key: RecommendationClarityKey;
  label: string;
  status: "pass" | "warning";
  message: string;
};

const MISSING_VALUE_LABEL = "Missing signal from this refresh.";

export function buildRecommendationClarity(
  recommendation: Recommendation,
): RecommendationClarityItem[] {
  const hasAsset = Boolean(
    recommendation.assetName?.trim() &&
      recommendation.assetType?.trim() &&
      recommendation.locationLabel?.trim(),
  );
  const hasWhy = recommendation.reasonCodes.length > 0;
  const hasChange = Boolean(recommendation.changedSinceLastRefresh?.trim());
  const hasFreshness = Boolean(
    recommendation.sourcesUpdatedLabel?.trim() &&
      recommendation.sourcesUpdatedLabel.trim().toLowerCase() !== "unknown",
  );
  const hasConfidence = Boolean(recommendation.confidenceLevel?.trim());
  const hasAction = Boolean(recommendation.recommendedAction?.trim());

  return [
    {
      key: "asset",
      label: "Asset at risk",
      value: recommendation.assetName || "Asset not identified yet",
      detail: hasAsset
        ? `${recommendation.assetType} at ${recommendation.locationLabel}`
        : MISSING_VALUE_LABEL,
    },
    {
      key: "why",
      label: "Why ranked",
      value: hasWhy
        ? recommendation.reasonCodes.slice(0, 5).join(", ")
        : "Source reasoning is not available in this refresh.",
    },
    {
      key: "change",
      label: "Changed since last refresh",
      value: hasChange
        ? recommendation.changedSinceLastRefresh
        : "No change delta captured in this cycle.",
    },
    {
      key: "freshness",
      label: "Data freshness",
      value: hasFreshness
        ? recommendation.sourcesUpdatedLabel
        : "Refresh freshness not available.",
      detail: freshnessDetail(recommendation.dataFreshnessHours),
    },
    {
      key: "confidence",
      label: "Confidence",
      value: hasConfidence
        ? recommendation.confidenceLevel
        : "Low (missing source coverage)",
      detail: "Uncalibrated evidence quality; independent of the screening score.",
    },
    {
      key: "action",
      label: "Responder action to consider",
      value: hasAction
        ? recommendation.recommendedAction
        : "Review this item first and record an operational decision in History & Audit.",
    },
  ];
}

export function buildRecommendationClarityChecklist(
  recommendation: Recommendation,
): RecommendationClarityChecklistEntry[] {
  return [
    {
      key: "asset",
      label: "What asset is at risk?",
      status: recommendation.assetName?.trim() ? "pass" : "warning",
      message: recommendation.assetName?.trim()
        ? "Ready"
        : "Missing asset name.",
    },
    {
      key: "why",
      label: "Why ranked?",
      status: recommendation.reasonCodes.length > 0 ? "pass" : "warning",
      message:
        recommendation.reasonCodes.length > 0
          ? "Ready"
          : "Missing reason-code signals.",
    },
    {
      key: "change",
      label: "What changed?",
      status: recommendation.changedSinceLastRefresh?.trim() ? "pass" : "warning",
      message: recommendation.changedSinceLastRefresh?.trim()
        ? "Ready"
        : "Change signal missing.",
    },
    {
      key: "freshness",
      label: "Data freshness",
      status:
        recommendation.sourcesUpdatedLabel?.trim() &&
        recommendation.sourcesUpdatedLabel.trim().toLowerCase() !== "unknown"
          ? "pass"
          : "warning",
      message:
        recommendation.sourcesUpdatedLabel?.trim() &&
        recommendation.sourcesUpdatedLabel.trim().toLowerCase() !== "unknown"
          ? "Ready"
          : "Freshness label not available.",
    },
    {
      key: "confidence",
      label: "Confidence",
      status: recommendation.confidenceLevel?.trim() ? "pass" : "warning",
      message: recommendation.confidenceLevel?.trim()
        ? "Ready"
        : "Confidence not available.",
    },
    {
      key: "action",
      label: "What action?",
      status: recommendation.recommendedAction?.trim() ? "pass" : "warning",
      message: recommendation.recommendedAction?.trim()
        ? "Ready"
        : "Action suggestion missing.",
    },
  ];
}

export function buildEvidenceSummaries(
  recommendation: Recommendation,
  maxItems = 3,
): string[] {
  const evidenceSummaries = (recommendation.evidence ?? [])
    .map((item) => item.summary || item.sourceName || item.sourceKey)
    .filter((item): item is string => Boolean(item?.trim()))
    .slice(0, maxItems);

  if (evidenceSummaries.length > 0) return evidenceSummaries;

  return (recommendation.sourceSnapshotIds ?? [])
    .slice(0, maxItems)
    .map((sourceId) => `Source snapshot: ${sourceId}`);
}

export function displayAssetName(assetName: string) {
  // Uploaded county GIS records arrive as "Diamond Fork culvert Utah County
  // GIS OBJECTID 4"; the raw provenance suffix belongs in source evidence,
  // not the card headline. Only strip it when a meaningful name remains.
  const cleaned = assetName
    .replace(/\s+(?:[A-Z][A-Za-z.]*\s+)*GIS OBJECTID \d+$/, "")
    .trim();
  return cleaned.split(/\s+/).filter(Boolean).length >= 2 ? cleaned : assetName;
}

export function highPriorityCaption(
  highPriorityCount: number,
  recommendationCount: number,
) {
  if (highPriorityCount > 0) return "High or unassessed: review evidence";
  return recommendationCount > 0 ? "No high-priority items" : "No recommendations yet";
}

function freshnessDetail(hours: number) {
  if (!Number.isFinite(hours) || hours < 0) return undefined;
  const roundedHours = Math.round(hours);
  if (roundedHours < 1) return "under 1 hr old";
  if (roundedHours >= 48) {
    const days = Math.round(roundedHours / 24);
    return `oldest source ${days} days old`;
  }
  return `${roundedHours} hr${roundedHours === 1 ? "" : "s"} old`;
}
