import type { ConfidenceLevel, RiskLevel } from "./types";

export const SCORING_VERSION = "2026-09-14-unverified-uploads-v4";
export const UNKNOWN_RISK_ACTION = "Review missing or uncertain evidence with a qualified responder before using this ranking. Unknown does not mean low hazard.";

export const SCORE_WEIGHTS = {
  rainfallThreat: 0.35,
  burnSeverity: 0.2,
  slopeTerrain: 0.15,
  downstreamExposure: 0.2,
  dataFreshness: 0,
} as const;

export type ScoringInput = {
  rainfallThreat: number | undefined;
  burnSeverity: number | undefined;
  slopeTerrain: number | undefined;
  downstreamExposure: number | undefined;
  dataFreshness: number;
  confidenceMultiplier: number;
  missingSignals: string[];
  staleSignals: string[];
  sourceReliability: "official" | "mixed" | "unverified";
};

export type RiskBand = {
  label: RiskLevel;
  min: number;
  max: number;
  recommendedAction: string;
};

export const RISK_BANDS: RiskBand[] = [
  {
    label: "Very High",
    min: 0.8,
    max: 1,
    recommendedAction: "Inspect immediately. Prioritize this for operational review and staging.",
  },
  {
    label: "High",
    min: 0.6,
    max: 0.79,
    recommendedAction: "Inspect soon. Monitor closely and prepare resources.",
  },
  {
    label: "Medium",
    min: 0.4,
    max: 0.59,
    recommendedAction: "Monitor. Review if conditions change.",
  },
  {
    label: "Low",
    min: 0.2,
    max: 0.39,
    recommendedAction: "Review current evidence and local conditions; a low screening score does not establish safety.",
  },
  {
    label: "Very Low",
    min: 0,
    max: 0.19,
    recommendedAction: "Review current evidence and local conditions; a low screening score does not establish safety.",
  },
];

export function getRiskLevel(score: number): RiskBand {
  if (!Number.isFinite(score)) {
    return { label: "Unknown", min: 0, max: 1, recommendedAction: UNKNOWN_RISK_ACTION };
  }
  const score100 = Math.round(clamp(score) * 100);
  if (score100 >= 80) return RISK_BANDS[0];
  if (score100 >= 60) return RISK_BANDS[1];
  if (score100 >= 40) return RISK_BANDS[2];
  if (score100 >= 20) return RISK_BANDS[3];
  return RISK_BANDS[4];
}

export function calculatePriorityScore(input: ScoringInput) {
  const hazardKeys = ["rainfallThreat", "burnSeverity", "slopeTerrain", "downstreamExposure"] as const;
  const invalidSignals = hazardKeys.filter((key) => !validHazardSignal(input[key]));
  const evidenceIncomplete = invalidSignals.length > 0 || input.missingSignals.length > 0 ||
    input.staleSignals.length > 0 || input.sourceReliability !== "official" ||
    !validHazardSignal(input.confidenceMultiplier) || !validHazardSignal(input.dataFreshness);
  // Missing hazard terms use an upper bound for review ordering, never a measurement.
  // Freshness and confidence cannot reduce the hazard screening score.
  const hazardWeight = hazardKeys.reduce((sum, key) => sum + SCORE_WEIGHTS[key], 0);
  const baseScore = hazardKeys.reduce((sum, key) =>
    sum + (validHazardSignal(input[key]) ? input[key] : 1) * SCORE_WEIGHTS[key], 0) / hazardWeight;

  const missingPenalty = Math.min(input.missingSignals.length * 0.15, 0.5);
  const stalePenalty = Math.min(input.staleSignals.length * 0.1, 0.35);
  const reliabilityPenalty =
    input.sourceReliability === "official"
      ? 0
      : input.sourceReliability === "mixed"
        ? 0.05
        : 0.12;
  const confidenceMultiplier = Math.min(evidenceIncomplete ? 0.49 : 1, clamp(
    input.confidenceMultiplier - missingPenalty - stalePenalty - reliabilityPenalty,
  ));
  const finalScore = clamp(baseScore);
  const riskLevel = evidenceIncomplete ? "Unknown" : getRiskLevel(finalScore).label;

  return {
    scoringVersion: SCORING_VERSION,
    scoreBasis: evidenceIncomplete ? "review-only" as const : "hazard-screening" as const,
    baseScore: round(baseScore, 3),
    confidenceMultiplier: round(confidenceMultiplier, 3),
    finalScore: round(finalScore, 3),
    score100: Math.round(finalScore * 100),
    riskLevel,
    confidenceLevel: confidenceLevel(confidenceMultiplier),
    reasonCodes: [...(evidenceIncomplete ? ["Risk unassessed: evidence review required"] : []), ...buildReasonCodes(input)],
    limitations: [
      ...(evidenceIncomplete ? [UNKNOWN_RISK_ACTION] : []),
      ...invalidSignals.map((key) => `${key} is missing or invalid; no measured value is assumed.`),
      ...buildLimitations(input),
    ],
  };
}

function buildReasonCodes(input: ScoringInput): string[] {
  const reasons: string[] = [];

  if (validHazardSignal(input.rainfallThreat) && input.rainfallThreat >= 0.75) reasons.push("Heavy Rain Forecast");
  if (validHazardSignal(input.burnSeverity) && input.burnSeverity >= 0.7) reasons.push("High Burn Severity");
  if (validHazardSignal(input.slopeTerrain) && input.slopeTerrain >= 0.7) reasons.push("Steep Slope");
  if (validHazardSignal(input.downstreamExposure) && input.downstreamExposure >= 0.7) reasons.push("Downstream Exposure");
  if (input.dataFreshness >= 0.7) reasons.push("Fresh Source Data");

  for (const signal of input.missingSignals) {
    reasons.push(`Missing ${signal}`);
  }

  for (const signal of input.staleSignals) {
    reasons.push(`Stale ${signal}`);
  }

  if (reasons.length === 0) reasons.push("Routine Monitoring");
  return reasons;
}

function buildLimitations(input: ScoringInput): string[] {
  const limitations = input.missingSignals.map(
    (signal) =>
      `${signal} is unavailable; verify the missing evidence before relying on this assessment.`,
  );

  if (input.sourceReliability !== "official") {
    limitations.push("Some signals are derived from mixed public sources and should be locally validated.");
  }

  return limitations;
}

function confidenceLevel(multiplier: number): ConfidenceLevel {
  if (multiplier >= 0.78) return "High";
  if (multiplier >= 0.5) return "Medium";
  return "Low";
}

function validHazardSignal(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function round(value: number, places: number) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function clamp(value: number) {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
