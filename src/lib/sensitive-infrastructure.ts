import type {
  Asset,
  AuditEvent,
  Incident,
  Recommendation,
  ResponderAction,
} from "./types";
import { UNKNOWN_RISK_ACTION } from "./scoring";

export type SensitiveViewer =
  | {
      organizationId?: string | null;
      role?: "incident_commander" | "analyst" | "viewer" | null;
    }
  | null
  | undefined;

const publicFacilityName = "Critical facility response context";
const publicFacilityEvidence =
  "Sensitive facility details are available to signed-in response users.";
const publicFacilityRecommendationEvidence =
  "Sensitive facility evidence is available to signed-in response users.";
const publicFacilityLimitation =
  "Sensitive infrastructure details are limited to authenticated response users.";
const publicResponderName = "Response user";
const publicResponderNote =
  "Responder note is available to signed-in response users.";

export function canViewSensitiveInfrastructure(
  viewer: SensitiveViewer,
  incidentOrganizationId: string | null | undefined,
) {
  return Boolean(
    viewer?.organizationId &&
      incidentOrganizationId &&
      viewer.organizationId === incidentOrganizationId &&
      (viewer.role === "incident_commander" || viewer.role === "analyst"),
  );
}

export function isSensitiveAssetType(assetType: string) {
  return assetType === "Critical Facility";
}

type PublicIdProjector = (prefix: string, value: string) => string;

type PublicProjectionContext = {
  sensitiveRecommendationIds: ReadonlySet<string>;
  sensitiveAssetIds: ReadonlySet<string>;
};

const PUBLIC_RECOMMENDATION_TYPES = new Set<Exclude<Recommendation["assetType"], "Critical Facility">>([
  "Road Crossing",
  "Culvert",
  "Bridge",
  "Evacuation Route",
  "Inferred Crossing",
]);

export function redactAssetForPublic(asset: Asset, incident: Incident, publicId = createPublicIds()): Asset {
  return projectAssetForPublic(asset, incident, publicId);
}

function projectAssetForPublic(
  asset: Asset,
  incident: Incident,
  publicId: PublicIdProjector,
  context?: PublicProjectionContext,
): Asset {
  if (!isSensitiveAssetType(asset.type) && !context?.sensitiveAssetIds.has(asset.id)) return asset;

  const coordinates = publicCoordinates(incident);
  return {
    // Allowlist public fields: filenames, URLs and future metadata can identify a site.
    id: publicId("asset-redacted", asset.id),
    incidentId: incident.id,
    type: "Critical Facility",
    name: publicFacilityName,
    locationLabel: `${incident.county} response area`,
    coordinates,
    geometry: { type: "Point", coordinates },
    source: "Sensitive infrastructure context",
    sourceKey: "critical-facility",
    confidence: asset.confidence,
    localOrUploaded: asset.localOrUploaded,
    coverageStatus: asset.coverageStatus,
    evidence: [
      {
        sourceKey: "critical-facility",
        sourceName: "Sensitive infrastructure context",
        summary: publicFacilityEvidence,
      },
    ],
  };
}

export function redactRecommendationForPublic(
  recommendation: Recommendation,
  incident: Incident,
  publicId = createPublicIds(),
): Recommendation {
  return projectRecommendationForPublic(recommendation, incident, publicId);
}

function projectRecommendationForPublic(
  recommendation: Recommendation,
  incident: Incident,
  publicId: PublicIdProjector,
  context?: PublicProjectionContext,
): Recommendation {
  if (!shouldRedactRecommendation(recommendation, context)) return recommendation;

  const coordinates = publicCoordinates(incident);
  const score = recommendation.scoreBreakdown;
  return {
    id: publicId("rec-redacted", recommendation.id),
    incidentId: incident.id,
    assetId: publicId("asset-redacted", recommendation.assetId),
    assetName: publicFacilityName,
    assetType: "Critical Facility",
    locationLabel: `${incident.county} response area`,
    coordinates,
    recommendedAction: recommendation.riskLevel === "Unknown"
      ? UNKNOWN_RISK_ACTION : "Review restricted facility evidence with an authorized response user before acting.",
    finalScore: recommendation.finalScore,
    score100: recommendation.score100,
    riskLevel: recommendation.riskLevel,
    confidenceLevel: recommendation.confidenceLevel,
    reasonCodes: ["Critical facility context; detailed rationale restricted"],
    limitations: [publicFacilityLimitation, "Screening context only; review the complete evidence and limitations with an authorized response user."],
    changedSinceLastRefresh: "Detailed change history restricted",
    sourcesUpdatedLabel: "Source details restricted",
    dataFreshnessHours: recommendation.dataFreshnessHours,
    scoreBreakdown: {
      scoringVersion: score.scoringVersion,
      scoreBasis: score.scoreBasis,
      rainfallThreat: score.rainfallThreat,
      burnSeverity: score.burnSeverity,
      slopeTerrain: score.slopeTerrain,
      downstreamExposure: score.downstreamExposure,
      dataFreshness: score.dataFreshness,
      confidenceMultiplier: score.confidenceMultiplier,
      baseScore: score.baseScore,
      finalScore: score.finalScore,
      metricStatus: score.metricStatus ? {
        rainfallThreat: score.metricStatus.rainfallThreat,
        burnSeverity: score.metricStatus.burnSeverity,
        slopeTerrain: score.metricStatus.slopeTerrain,
        downstreamExposure: score.metricStatus.downstreamExposure,
        dataFreshness: score.metricStatus.dataFreshness,
      } : undefined,
    },
    createdAt: recommendation.createdAt,
    evidence: [
      {
        sourceKey: "critical-facility",
        sourceName: "Sensitive infrastructure context",
        summary: publicFacilityRecommendationEvidence,
      },
    ],
  };
}

export function redactResponderActionForPublic(
  action: ResponderAction,
  incident: Incident,
  publicId = createPublicIds(),
  context?: PublicProjectionContext,
): ResponderAction {
  const sensitive = shouldRedactRecommendation(action.recommendationSnapshot, context) ||
    context?.sensitiveRecommendationIds.has(action.recommendationId) === true;
  const recommendationSnapshot = sensitive
    ? projectRecommendationForPublic(action.recommendationSnapshot, incident, publicId, context)
    : action.recommendationSnapshot;

  return {
    id: publicId("action-redacted", action.id),
    recommendationId: sensitive
      ? publicId("rec-redacted", action.recommendationId)
      : action.recommendationId,
    note: publicResponderNote,
    actorName: publicResponderName,
    action: action.action,
    modifiedPriority: action.modifiedPriority,
    createdAt: action.createdAt,
    recommendationSnapshot,
    auditEvent: redactAuditEventForPublic(action.auditEvent, incident, publicId, context),
  };
}

export function redactAuditEventForPublic(
  event: AuditEvent,
  incident: Incident,
  publicId = createPublicIds(),
  context?: PublicProjectionContext,
): AuditEvent {
  const recommendationSnapshot = event.payload.recommendationSnapshot;
  const actorName =
    event.actorName === "FireAfter" ? event.actorName : publicResponderName;
  if (!isRecommendationLike(recommendationSnapshot)) {
    return {
      id: publicId("audit-redacted", event.id),
      incidentId: incident.id,
      recommendationId: event.recommendationId
        ? publicId("rec-redacted", event.recommendationId) : undefined,
      eventType: event.eventType,
      createdAt: event.createdAt,
      actorName,
      summary: "Audit event recorded; details are restricted to authorized response users.",
      payload: publicAuditPayload(event),
    };
  }

  const sensitive = shouldRedactRecommendation(recommendationSnapshot, context) ||
    (event.recommendationId !== undefined && context?.sensitiveRecommendationIds.has(event.recommendationId) === true);
  const publicSnapshot = sensitive
    ? projectRecommendationForPublic(recommendationSnapshot, incident, publicId, context)
    : recommendationSnapshot;

  return {
    id: publicId("audit-redacted", event.id),
    incidentId: incident.id,
    eventType: event.eventType,
    createdAt: event.createdAt,
    recommendationId:
      sensitive && event.recommendationId
        ? publicId("rec-redacted", event.recommendationId)
        : event.recommendationId,
    actorName,
    summary: sensitive
      ? "Audit event recorded for critical facility response context."
      : "Responder action recorded for public action queue item.",
    payload: {
      ...publicAuditPayload(event),
      note: publicResponderNote,
      recommendationSnapshot: publicSnapshot,
    },
  };
}

export function redactSensitiveBundleForPublic<
  T extends {
    incident: Incident;
    assets: Asset[];
    recommendations: Recommendation[];
    actions: ResponderAction[];
    auditEvents: AuditEvent[];
  },
>(bundle: T): T {
  // Every server delivery rekeys even inputs that imitate already-public IDs.
  const context = buildPublicProjectionContext(bundle);
  const snapshots = bundle.auditEvents.map(event => event.payload.recommendationSnapshot).filter(isRecommendationLike);
  const publicRecommendations = new Set([
    ...bundle.recommendations, ...bundle.actions.map(action => action.recommendationSnapshot), ...snapshots,
  ].filter(rec => isPublicRecommendationType(rec.assetType) &&
    !context.sensitiveRecommendationIds.has(rec.id) &&
    !context.sensitiveAssetIds.has(rec.assetId)).map(rec => rec.id));
  const publicId = createPublicIds(false, publicRecommendations);
  return {
    ...bundle,
    assets: bundle.assets.map((asset) => projectAssetForPublic(asset, bundle.incident, publicId, context)),
    recommendations: sortPublicRecommendationPreview(
      bundle.recommendations.map((recommendation) =>
        projectRecommendationForPublic(recommendation, bundle.incident, publicId, context),
      ),
    ),
    actions: bundle.actions.map((action) =>
      redactResponderActionForPublic(action, bundle.incident, publicId, context),
    ),
    auditEvents: bundle.auditEvents.map((event) =>
      redactAuditEventForPublic(event, bundle.incident, publicId, context),
    ),
  };
}

function buildPublicProjectionContext(bundle: {
  assets: Asset[];
  recommendations: Recommendation[];
  actions: ResponderAction[];
  auditEvents: AuditEvent[];
}): PublicProjectionContext {
  const sensitiveRecommendationIds = new Set<string>();
  const sensitiveAssetIds = new Set<string>();
  const markRecommendation = (value: unknown, linkedRecommendationId?: unknown) => {
    if (!isRecommendationLike(value) || isPublicRecommendationType(value.assetType)) return;
    sensitiveRecommendationIds.add(value.id);
    if (typeof linkedRecommendationId === "string") sensitiveRecommendationIds.add(linkedRecommendationId);
    sensitiveAssetIds.add(value.assetId);
  };

  for (const asset of bundle.assets) {
    if (isSensitiveAssetType(asset.type)) sensitiveAssetIds.add(asset.id);
  }
  for (const recommendation of bundle.recommendations) markRecommendation(recommendation);
  for (const action of bundle.actions) markRecommendation(action.recommendationSnapshot, action.recommendationId);
  for (const event of bundle.auditEvents) markRecommendation(event.payload.recommendationSnapshot, event.recommendationId);

  return { sensitiveRecommendationIds, sensitiveAssetIds };
}

function isPublicRecommendationType(assetType: unknown): assetType is Exclude<Recommendation["assetType"], "Critical Facility"> {
  return typeof assetType === "string" && PUBLIC_RECOMMENDATION_TYPES.has(assetType as Exclude<Recommendation["assetType"], "Critical Facility">);
}

function shouldRedactRecommendation(
  recommendation: Pick<Recommendation, "id" | "assetId" | "assetType">,
  context?: PublicProjectionContext,
) {
  return !isPublicRecommendationType(recommendation.assetType) ||
    context?.sensitiveRecommendationIds.has(recommendation.id) === true ||
    context?.sensitiveAssetIds.has(recommendation.assetId) === true;
}

function sortPublicRecommendationPreview(recommendations: Recommendation[]) {
  return [...recommendations].sort((a, b) => {
    const priorityDelta =
      publicRecommendationPriority(a.assetType) -
      publicRecommendationPriority(b.assetType);
    if (priorityDelta !== 0) return priorityDelta;
    return b.score100 - a.score100 || b.createdAt.localeCompare(a.createdAt);
  });
}

function publicRecommendationPriority(assetType: string) {
  switch (assetType) {
    case "Road Crossing":
    case "Inferred Crossing":
    case "Bridge":
    case "Culvert":
    case "Evacuation Route":
      return 0;
    case "Critical Facility":
      return 2;
    default:
      return 1;
  }
}

function publicCoordinates(incident: Incident): [number, number] {
  // Fail closed: never fall back to the facility's real coordinates when the
  // county centroid is unavailable.
  return incident.locationContext?.centroid ?? [0, 0];
}

function createPublicIds(preserveProjected = true, publicRecommendations = new Set<string>()): PublicIdProjector {
  const ids = new Map<string, string>();
  return (prefix, value) => {
    if (prefix === "rec-redacted" && publicRecommendations.has(value)) return value;
    const publicPrefix = `${prefix}-v2-`;
    // Client presentation may repeat redaction after the server boundary.
    if (preserveProjected && value.startsWith(publicPrefix) &&
      /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(value.slice(publicPrefix.length))) return value;
    const key = JSON.stringify([prefix, value]);
    let id = ids.get(key);
    if (!id) {
      id = publicPrefix + crypto.randomUUID().replaceAll("-", "");
      ids.set(key, id);
    }
    return id;
  };
}

function publicAuditPayload(event: AuditEvent): Record<string, unknown> {
  const action = event.payload.action;
  const modifiedPriority = event.payload.modifiedPriority;
  return {
    action: typeof action === "string" && ["accept", "modify", "reject", "annotate"].includes(action) ? action : undefined,
    modifiedPriority: typeof modifiedPriority === "string" && ["Unknown", "Very High", "High", "Medium", "Low", "Very Low"].includes(modifiedPriority) ? modifiedPriority : undefined,
    note: event.payload.note ? publicResponderNote : undefined,
  };
}

function isRecommendationLike(value: unknown): value is Recommendation {
  return (
    typeof value === "object" &&
    value !== null &&
    "assetType" in value &&
    "assetName" in value &&
    "locationLabel" in value &&
    "id" in value && typeof value.id === "string" &&
    "assetId" in value && typeof value.assetId === "string" &&
    "scoreBreakdown" in value && typeof value.scoreBreakdown === "object" &&
    value.scoreBreakdown !== null
  );
}
