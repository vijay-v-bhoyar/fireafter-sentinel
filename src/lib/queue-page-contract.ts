import { z } from "zod";
import type { Recommendation } from "./types";

export const QUEUE_PAGE_BYTES = 4 * 1024 * 1024;
export const QUEUE_PAGE_UNAVAILABLE = "The queue page could not be verified within its limits. Retry a smaller page or ask an operator to check the stored inventory. No records were changed.";
export class QueuePageError extends Error {
  constructor(readonly status: number, message = QUEUE_PAGE_UNAVAILABLE, readonly code = `QP${status}`) { super(message); }
}
export const QueuePageQuerySchema = z.object({
  incidentId: z.string().trim().min(1).max(256),
  start: z.string().regex(/^(?:0|[1-9]\d{0,4})$/).default("0"),
  limit: z.enum(["1", "10", "25", "50"]).default("10"),
  revision: z.uuid().optional(), state: z.enum(["current", "expired"]).optional(),
}).strict().refine(value => value.start === "0" || Boolean(value.revision && value.state), { message: "Continuation requires revision and evidence state." });
export type QueuePageQuery = z.infer<typeof QueuePageQuerySchema>;
const coverage = z.enum(["available", "partial", "not_available", "stale", "error"]);
const finite = z.number().finite();
const evidence = z.object({ sourceKey: z.string(), sourceName: z.string(), sourceUrl: z.string().optional(),
  sourceFeatureId: z.string().optional(), sourcePartIndex: z.number().int().nonnegative().optional(), summary: z.string() }).strict();
export const QueueRecommendationSchema: z.ZodType<Recommendation> = z.object({
  inventoryRevision: z.uuid(), id: z.string().min(1), incidentId: z.string().min(1), assetId: z.string().min(1), assetName: z.string(),
  assetType: z.enum(["Road Crossing", "Culvert", "Bridge", "Evacuation Route", "Critical Facility", "Inferred Crossing"]),
  locationLabel: z.string(), coordinates: z.tuple([finite.min(-180).max(180), finite.min(-90).max(90)]),
  recommendedAction: z.string(), finalScore: finite, score100: finite.min(0).max(100),
  riskLevel: z.enum(["Unknown", "Very High", "High", "Medium", "Low", "Very Low"]), confidenceLevel: z.enum(["High", "Medium", "Low"]),
  reasonCodes: z.array(z.string()), limitations: z.array(z.string()), changedSinceLastRefresh: z.string(), sourcesUpdatedLabel: z.string(),
  dataFreshnessHours: finite.nonnegative(), scoreBreakdown: z.object({
    scoringVersion: z.string().optional(), scoreBasis: z.enum(["hazard-screening", "review-only", "legacy-unassessed"]).optional(),
    rainfallThreat: finite, burnSeverity: finite, slopeTerrain: finite, downstreamExposure: finite, dataFreshness: finite,
    confidenceMultiplier: finite, baseScore: finite, finalScore: finite,
    metricStatus: z.object({ rainfallThreat: coverage, burnSeverity: coverage, slopeTerrain: coverage, downstreamExposure: coverage, dataFreshness: coverage }).strict().optional(),
  }).strict(), evidence: z.array(evidence).optional(), sourceSnapshotIds: z.array(z.string()).optional(), createdAt: z.string(),
}).strict();
export const QueuePageSchema = z.object({
  incidentId: z.string().min(1), canonicalIncidentId: z.string().min(1), revision: z.uuid(),
  state: z.enum(["current", "expired"]), evaluatedAt: z.iso.datetime(), expiresAt: z.iso.datetime().nullable(),
  start: z.number().int().min(0).max(99999), limit: z.number().int().min(1).max(50), totalStored: z.number().int().min(0).max(100000),
  nextStart: z.number().int().min(1).max(99999).nullable(),
  items: z.array(z.discriminatedUnion("status", [
    z.object({ position: z.number().int().positive(), status: z.literal("available"), recommendation: QueueRecommendationSchema }).strict(),
    z.object({ position: z.number().int().positive(), status: z.literal("withheld"), reason: z.enum(["non-operational", "unverified-geometry", "outside-county"]) }).strict(),
  ])).max(50),
}).strict();
export type QueuePage = z.infer<typeof QueuePageSchema>;

export function validateQueuePage(value: unknown, input: QueuePageQuery): QueuePage {
  const page = QueuePageSchema.parse(value), count = Math.min(page.limit, Math.max(0, page.totalStored - page.start));
  const next = page.start + count < page.totalStored ? page.start + count : null;
  const ids = page.items.flatMap(item => item.status === "available" ? [item.recommendation.id] : []);
  if (page.incidentId !== input.incidentId || page.start !== Number(input.start) || page.limit !== Number(input.limit) ||
    (input.revision && page.revision !== input.revision) || (input.state && page.state !== input.state) ||
    (page.start !== 0 && page.start >= page.totalStored) || page.items.length !== count || page.nextStart !== next ||
    new Set(ids).size !== ids.length || page.items.some((item, i) => item.position !== page.start + i + 1 ||
      (item.status === "available" && (item.recommendation.incidentId !== page.canonicalIncidentId || item.recommendation.inventoryRevision !== page.revision ||
        (page.state === "expired" && item.recommendation.riskLevel !== "Unknown")))) ||
    (page.state === "current" && (!page.expiresAt || Date.parse(page.expiresAt) <= Date.parse(page.evaluatedAt)))) throw new QueuePageError(503);
  return page;
}
