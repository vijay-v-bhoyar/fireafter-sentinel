import type {
  AuditEvent,
  Recommendation,
  ResponderAction,
  ResponderActionType,
  RiskLevel,
} from "./types";

type ActionInput = {
  recommendation: Recommendation;
  action: ResponderActionType;
  note: string;
  actorName: string;
  createdAt?: string;
  modifiedPriority?: RiskLevel;
  command?: { id: string; actorId: string; expectedRevision: string };
};

export function createRecommendationSnapshot(
  recommendation: Recommendation,
): Recommendation {
  return JSON.parse(JSON.stringify(recommendation)) as Recommendation;
}

export function createResponderAction(input: ActionInput): ResponderAction {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const snapshot = createRecommendationSnapshot(input.recommendation);
  const actionPastTense = actionToPastTense(input.action);
  const eventType = actionToEventType(input.action);
  const shortAssetName = snapshot.assetName.split(" @ ")[0];

  const auditEvent: AuditEvent = {
    id: input.command ? `audit-command-${input.command.actorId}-${input.command.id}`
      : `audit-${snapshot.id}-${input.action}-${Date.parse(createdAt) || Date.now()}`,
    incidentId: snapshot.incidentId,
    recommendationId: snapshot.id,
    eventType,
    actorName: input.actorName,
    createdAt,
    summary: `${input.actorName} ${actionPastTense} ${shortAssetName} (${snapshot.riskLevel}, score ${snapshot.score100}).`,
    payload: {
      ...(input.command ? { commandId: input.command.id, expectedRevision: input.command.expectedRevision } : {}),
      action: input.action,
      note: input.note,
      modifiedPriority: input.modifiedPriority,
      recommendationSnapshot: snapshot,
    },
  };

  return {
    id: input.command ? `action-command-${input.command.actorId}-${input.command.id}`
      : `action-${snapshot.id}-${input.action}-${Date.parse(createdAt) || Date.now()}`,
    recommendationId: snapshot.id,
    action: input.action,
    note: input.note,
    actorName: input.actorName,
    createdAt,
    modifiedPriority: input.modifiedPriority,
    recommendationSnapshot: snapshot,
    auditEvent,
  };
}

function actionToEventType(action: ResponderActionType): AuditEvent["eventType"] {
  switch (action) {
    case "accept":
      return "RecommendationAccepted";
    case "modify":
      return "RecommendationModified";
    case "reject":
      return "RecommendationRejected";
    case "annotate":
      return "RecommendationAnnotated";
  }
}

function actionToPastTense(action: ResponderActionType) {
  switch (action) {
    case "accept":
      return "accepted";
    case "modify":
      return "modified";
    case "reject":
      return "rejected";
    case "annotate":
      return "annotated";
  }
}
