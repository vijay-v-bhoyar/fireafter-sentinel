import type { Recommendation } from "./types";

type QueueItem = Pick<Recommendation, "riskLevel" | "score100" | "assetName" | "assetId" | "id">;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Domain IDs survive persistence; row order and timestamps do not define queue rank. */
export function compareRecommendations(left: QueueItem, right: QueueItem): number {
  return Number(right.riskLevel === "Unknown") - Number(left.riskLevel === "Unknown")
    || right.score100 - left.score100
    || compareText(left.assetName.trim().toLowerCase(), right.assetName.trim().toLowerCase())
    || compareText(left.assetId, right.assetId)
    || compareText(left.id, right.id);
}
