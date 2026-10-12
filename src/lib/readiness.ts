import type {
  Asset,
  AuditEvent,
  Incident,
  Recommendation,
  ResponderAction,
  SourceSnapshot,
} from "./types";
import { buildProductPromiseAudit, type ProductPromiseGate } from "./product-promise";
import { buildSourceCoverageMatrix } from "./source-coverage";
import { evidenceMaxAgeMinutes, hasCurrentSourceEvidence, projectBundleFreshness } from "./source-freshness";
import {
  SERVER_OWNED_WRITE_SECURITY_VERSION,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  SCHEDULED_REFRESH_SECURITY_VERSION,
} from "./operational-write-security";

export type OperationalHealthStatus = "operational" | "needs_attention" | "blocked";

export type ReadinessCategoryId =
  | "timeliness"
  | "coverage"
  | "responsible"
  | "operations"
  | "innovation";

export type DeploymentReadinessChecks = {
  supabaseConfigured: boolean;
  supabaseSchemaReady: boolean;
  serverOwnedWritesVerified: boolean;
  serverOwnedReadsVerified?: boolean;
  atomicResponderActionWriteVerified: boolean;
  atomicBundlePersistenceWriteVerified: boolean;
  operatorAccountIssuanceAuditVerified: boolean;
  scheduledRefreshVerified?: boolean;
  dashboardPersistenceAvailable?: boolean;
  nasaFirmsConfigured: boolean;
  nwsUserAgentConfigured: boolean;
  cronSecretConfigured: boolean;
  errors?: string[];
};

export type ReadinessBundle = {
  incident: Incident;
  assets: Asset[];
  sourceSnapshots: SourceSnapshot[];
  recommendations: Recommendation[];
  actions: ResponderAction[];
  auditEvents: AuditEvent[];
  currentUser?: {
    id: string;
    email: string;
    role: "incident_commander" | "analyst" | "viewer" | null;
  } | null;
};

export type ReadinessCategory = {
  id: ReadinessCategoryId;
  label: string;
  operationalTarget: number;
  score: number;
  status: OperationalHealthStatus;
  evidence: string[];
  blockers: string[];
  actions: string[];
};

export type OperationalHealthReport = {
  generatedAt: string;
  overallScore: number;
  overallStatus: OperationalHealthStatus;
  categories: Record<ReadinessCategoryId, ReadinessCategory>;
  productPromise: ProductPromiseGate[];
  deployment: {
    status: OperationalHealthStatus;
    blockers: string[];
    actions: string[];
    evidence: string[];
  };
  operatorChecklist: string[];
};

const operatorChecklist = [
  "Search and open a real county.",
  "Run Refresh and inspect source freshness warnings.",
  "Open the top recommendation and review source evidence.",
  "Accept or modify one action as an authenticated responder.",
  "Open History & Audit and show the immutable action record.",
];

export function buildOperationalHealth(
  bundle: ReadinessBundle,
  deployment: DeploymentReadinessChecks = deploymentChecksFromEnv(),
  generatedAt = new Date().toISOString(),
): OperationalHealthReport {
  bundle = projectBundleFreshness(bundle, new Date(generatedAt), evidenceMaxAgeMinutes());
  const categories = {
    timeliness: buildTimelinessCategory(bundle),
    coverage: buildCoverageCategory(bundle),
    responsible: buildResponsibleCategory(bundle),
    operations: buildOperationsCategory(bundle),
    innovation: buildInnovationCategory(bundle),
  };
  const deploymentStatus = buildDeploymentStatus(deployment);
  const productPromise = buildProductPromiseAudit(bundle, new Date(generatedAt));
  const linkageBlocked = productPromise.some((gate) => gate.id === "basin_asset_linkage" && gate.status !== "pass");
  const categoryScores = Object.values(categories).map((category) => category.score);
  const overallScore = round(
    categoryScores.reduce((total, score) => total + score, 0) / categoryScores.length,
    1,
  );
  const hasBlockedCategory = Object.values(categories).some(
    (category) => category.status === "blocked",
  );
  const hasNeedsAttentionCategory = Object.values(categories).some(
    (category) => category.status === "needs_attention",
  );
  const overallStatus: OperationalHealthStatus =
    hasBlockedCategory || linkageBlocked || deploymentStatus.blockers.length > 0
      ? "blocked"
      : hasNeedsAttentionCategory || deploymentStatus.actions.length > 0
        ? "needs_attention"
        : "operational";

  return {
    generatedAt,
    overallScore,
    overallStatus,
    categories,
    productPromise,
    deployment: deploymentStatus,
    operatorChecklist,
  };
}

export function deploymentChecksFromEnv(): DeploymentReadinessChecks {
  return {
    supabaseConfigured: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
        (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) &&
        process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
    supabaseSchemaReady: process.env.FIREAFTER_ASSUME_SCHEMA_READY === "true",
    serverOwnedWritesVerified: false,
    serverOwnedReadsVerified: false,
    atomicResponderActionWriteVerified: false,
    atomicBundlePersistenceWriteVerified: false,
    operatorAccountIssuanceAuditVerified: false,
    scheduledRefreshVerified: false,
    nasaFirmsConfigured: Boolean(process.env.NASA_FIRMS_MAP_KEY),
    nwsUserAgentConfigured: Boolean(process.env.FIREAFTER_NWS_USER_AGENT),
    cronSecretConfigured: Boolean(process.env.CRON_SECRET),
  };
}

function buildTimelinessCategory(bundle: ReadinessBundle): ReadinessCategory {
  const blockers: string[] = [];
  const actions: string[] = [];
  const evidence: string[] = [];
  const expiredSources = bundle.sourceSnapshots.filter((source) => source.freshness?.state !== "current");
  if (expiredSources.length > 0) {
    blockers.push(`${expiredSources.length} source check(s) expired or have invalid timestamps.`);
    actions.push("Refresh source evidence; previously explained no-coverage and fallback results also require a current check.");
  }
  const staleSources = bundle.sourceSnapshots.filter(
    (source) =>
      source.stale &&
      !isExplainedNoCoverageSource(source) &&
      !isExplainedFallbackAgeSource(source),
  );
  const delayedSources = bundle.sourceSnapshots.filter(
    (source) => source.status !== "online" && !isExplainedNoCoverageSource(source),
  );
  const explainedNoCoverageSources = bundle.sourceSnapshots.filter(
    isExplainedNoCoverageSource,
  );
  const explainedFallbackAgeSources = bundle.sourceSnapshots.filter(
    isExplainedFallbackAgeSource,
  );
  const currentSources = bundle.sourceSnapshots.filter(hasCurrentSourceEvidence);
  const hasRefresh = bundle.sourceSnapshots.length > 0;

  if (!hasRefresh) {
    blockers.push("No live source refresh has completed.");
    actions.push("Search a county and run Refresh before operational use.");
  }
  if (currentSources.length > 0) {
    evidence.push(`Current, available evidence: ${currentSources.length} of ${bundle.sourceSnapshots.length} source feeds.`);
  }
  if (staleSources.length > 0) {
    actions.push(`${staleSources.length} stale source feed${staleSources.length === 1 ? "" : "s"} ${staleSources.length === 1 ? "needs" : "need"} attention.`);
  }
  if (delayedSources.length > 0) {
    actions.push(`${delayedSources.length} delayed/offline source feed${delayedSources.length === 1 ? "" : "s"} ${delayedSources.length === 1 ? "needs" : "need"} retry or explanation.`);
  }
  if (explainedNoCoverageSources.length > 0) {
    evidence.push(
      `${explainedNoCoverageSources.length} source feed${explainedNoCoverageSources.length === 1 ? "" : "s"} returned explicit no-coverage results.`,
    );
  }
  if (explainedFallbackAgeSources.length > 0) {
    evidence.push(
      `${explainedFallbackAgeSources.length} fallback source feed${explainedFallbackAgeSources.length === 1 ? "" : "s"} refreshed successfully with aged source-dated evidence.`,
    );
  }
  if (!hasAnySource(bundle, ["nws", "nws-forecast"])) {
    actions.push("Verify NWS forecast grid refresh before operational use.");
  }

  return category({
    id: "timeliness",
    label: "Timeliness & Technical Reliability",
    operationalTarget: 4.2,
    blockers,
    actions,
    evidence,
  });
}

function buildCoverageCategory(bundle: ReadinessBundle): ReadinessCategory {
  const blockers: string[] = [];
  const actions: string[] = [];
  const evidence: string[] = [];
  const coverageMatrix = buildSourceCoverageMatrix(bundle);

  if (bundle.assets.length === 0) {
    if (isEmptyIncident(bundle.incident) || bundle.sourceSnapshots.length === 0) {
      blockers.push("No source-backed assets or uploaded local assets are loaded.");
    }
    actions.push("Load source-backed road/hydro candidates, or upload county assets, before ranking recommendations.");
  } else {
    evidence.push(`${bundle.assets.length} asset candidate${bundle.assets.length === 1 ? "" : "s"} loaded.`);
  }
  if (bundle.recommendations.length === 0) {
    actions.push("Refresh live sources until recommendations are created or explain no-source coverage.");
  } else {
    evidence.push(`${bundle.recommendations.length} recommendation${bundle.recommendations.length === 1 ? "" : "s"} ranked.`);
  }
  if (!hasAnySource(bundle, ["wfigs", "firms", "wfigs-current", "firms-area"])) {
    actions.push("Show WFIGS/FIRMS fire-context status, even if no current fire is found.");
  }
  if (!hasAnySource(bundle, ["tiger-roads", "3dhp-flowlines", "tigerweb-roads", "usgs-3dhp-flowlines"])) {
    actions.push("Verify road and hydrography source coverage for the selected county.");
  }
  if (bundle.sourceSnapshots.length > 0) {
    evidence.push(`${coverageMatrix.length} planned data-source items audited.`);
    const unavailable = coverageMatrix.filter(
      (item) =>
        item.status === "Not Available" &&
        item.category !== "Responder Feedback" &&
        !isExplainedNoCoverageItem(item.limitation),
    );
    const explainedNoCoverage = coverageMatrix.filter(
      (item) =>
        item.status === "Not Available" &&
        item.category !== "Responder Feedback" &&
        isExplainedNoCoverageItem(item.limitation),
    );
    const uploadRequired = coverageMatrix.filter(
      (item) => item.status === "Upload Required",
    );
    const delayed = coverageMatrix.filter((item) => item.status === "Delayed");

    if (unavailable.length > 0) {
      actions.push(
        `Resolve or explain unavailable planned data sources: ${unavailable
          .slice(0, 3)
          .map((item) => item.item)
          .join("; ")}.`,
      );
    }
    if (uploadRequired.length > 0) {
      actions.push(
        `Upload local agency data when available: ${uploadRequired
          .map((item) => item.item)
          .join("; ")}.`,
      );
    }
    if (delayed.length > 0) {
      evidence.push(
        `${delayed.length} delayed planned source${delayed.length === 1 ? "" : "s"} shown explicitly.`,
      );
    }
    if (explainedNoCoverage.length > 0) {
      evidence.push(
        `${explainedNoCoverage.length} reachable source${explainedNoCoverage.length === 1 ? "" : "s"} returned no current coverage and remain visible.`,
      );
    }
  }

  return category({
    id: "coverage",
    label: "Data Coverage & Source Discovery",
    operationalTarget: 4.2,
    blockers,
    actions,
    evidence,
  });
}

function buildResponsibleCategory(bundle: ReadinessBundle): ReadinessCategory {
  const blockers: string[] = [];
  const actions: string[] = [];
  const evidence: string[] = [];
  const recommendationsWithEvidence = bundle.recommendations.filter(
    (recommendation) =>
      (recommendation.evidence?.length ?? 0) > 0 ||
      (recommendation.sourceSnapshotIds?.length ?? 0) > 0,
  );

  if (bundle.recommendations.length > 0 && recommendationsWithEvidence.length === 0) {
    blockers.push("Recommendations do not expose source evidence or snapshot ids.");
  }
  if (!bundle.currentUser) {
    if (bundle.actions.length === 0 || bundle.auditEvents.length === 0) {
      actions.push("Sign in as an incident commander before writing audit records.");
    } else {
      evidence.push("Public readiness view is read-only; signed-in write controls remain role-gated.");
    }
  } else {
    evidence.push(`Authenticated as ${bundle.currentUser.email}.`);
  }
  if (bundle.actions.length > 0 && bundle.auditEvents.length === 0) {
    blockers.push("Responder actions exist without matching audit events.");
  }
  if (bundle.auditEvents.length > 0) {
    evidence.push(`${bundle.auditEvents.length} audit event${bundle.auditEvents.length === 1 ? "" : "s"} recorded.`);
  }

  return category({
    id: "responsible",
    label: "Responsible Data Handling",
    operationalTarget: 4.4,
    blockers,
    actions,
    evidence,
  });
}

function buildOperationsCategory(bundle: ReadinessBundle): ReadinessCategory {
  const blockers: string[] = [];
  const actions: string[] = [];
  const evidence: string[] = [];
  const acceptedOrModifiedActions = bundle.actions.filter(
    (action) => action.action === "accept" || action.action === "modify",
  );
  const auditedAcceptedOrModifiedActions = acceptedOrModifiedActions.filter(
    (action) => hasMatchingAuditEvent(action, bundle.auditEvents),
  );

  if (isEmptyIncident(bundle.incident)) {
    blockers.push("No county incident is open.");
    actions.push("Open a real county incident before operational review.");
  }
  if (bundle.recommendations.length === 0) {
    actions.push("Prepare a county with at least one source-backed recommendation or uploaded asset.");
  }
  if (acceptedOrModifiedActions.length > auditedAcceptedOrModifiedActions.length) {
    blockers.push("Accepted/modified responder actions exist without matching audit events.");
  }
  if (auditedAcceptedOrModifiedActions.length === 0) {
    actions.push("Accept or modify one action and confirm it appears in History & Audit.");
  } else {
    evidence.push(
      `${auditedAcceptedOrModifiedActions.length} accepted/modified responder decision${auditedAcceptedOrModifiedActions.length === 1 ? "" : "s"} visible in History & Audit.`,
    );
  }

  return category({
    id: "operations",
    label: "Responder Workflow Readiness",
    operationalTarget: 4.5,
    blockers,
    actions,
    evidence,
  });
}

function buildInnovationCategory(bundle: ReadinessBundle): ReadinessCategory {
  const blockers: string[] = [];
  const actions: string[] = [];
  const evidence = [
    "Decision-support language avoids evacuation or command automation claims.",
  ];

  if (hasAnySource(bundle, ["tiger-roads", "3dhp-flowlines", "tigerweb-roads", "usgs-3dhp-flowlines", "usgs-epqs"])) {
    evidence.push("Road, hydrography, and elevation proxies are wired as real-source discovery.");
  } else {
    actions.push("Run refresh for TIGERweb, 3DHP, and EPQS to validate source intelligence.");
  }
  if (!hasAnySource(bundle, ["usgs-pwfdf", "pwfdf-sciencebase"])) {
    actions.push("Explain PWFDF coverage honestly when no assessment exists.");
  }

  return category({
    id: "innovation",
    label: "Source Intelligence & Explainability",
    operationalTarget: 4.4,
    blockers,
    actions,
    evidence,
  });
}

function buildDeploymentStatus(checks: DeploymentReadinessChecks) {
  const blockers: string[] = [];
  const actions: string[] = [];
  const evidence: string[] = [];

  if (!checks.supabaseConfigured) {
    blockers.push("Supabase URL, anon key, or service role key is missing.");
  } else {
    evidence.push("Supabase environment variables are configured.");
  }
  if (!checks.supabaseSchemaReady) {
    blockers.push("Supabase reality-upgrade migration has not been verified.");
  } else {
    evidence.push("Supabase reality-upgrade schema is reachable.");
  }
  if (!checks.serverOwnedWritesVerified) {
    blockers.push("Server-owned operational-write migration has not been verified.");
  } else {
    evidence.push(`Server-owned operational-write migration version ${SERVER_OWNED_WRITE_SECURITY_VERSION} is verified.`);
  }
  if (checks.serverOwnedReadsVerified !== true) {
    blockers.push("Server-owned operational-read migration has not been verified.");
    actions.push("Rehearse and apply migration 20260913230300 on the intended Supabase project, then run verify:write-boundary; raw operational reads must remain server-only.");
  } else {
    evidence.push("Server-owned operational-read migration version 20260913230300 is verified.");
  }
  if (checks.atomicResponderActionWriteVerified !== true) {
    blockers.push(
      "Atomic responder-action persistence migration has not been verified.",
    );
  } else if (checks.atomicResponderActionWriteVerified === true) {
    evidence.push(
      "Responder command RPC permissions and implementation version 20260914010000 are verified; real transaction, replay and recovery acceptance remain separate requirements.",
    );
  }
  if (!checks.atomicBundlePersistenceWriteVerified) {
    blockers.push("Atomic incident-bundle persistence migration has not been verified.");
  } else {
    evidence.push(
      `Incident-bundle RPC permissions and implementation version ${ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION} are verified; real authority, revision fencing and recovery require separate acceptance.`,
    );
  }
  if (checks.atomicResponderActionWriteVerified !== true || !checks.atomicBundlePersistenceWriteVerified) {
    actions.push("Rehearse and apply responder command migration 20260914010000 after its prerequisites, then rerun verify:write-boundary. The legacy action RPC is intentionally disabled; do not restore its grants.");
    actions.push(`Rehearse bundle/import receipt migration ${ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION} after its prerequisites, obtain approval to apply it on the intended Supabase project, then rerun verify:write-boundary; do not accept historical or unfenced bundle probes.`);
  }
  if (!checks.operatorAccountIssuanceAuditVerified) {
    blockers.push("Operator account issuance audit migration has not been verified.");
    actions.push("Rehearse issuance control attestation 20260914150000, trusted operator identity 20260915120000 and issuance retention 20260915130000 after coordinator 20260914140000; bootstrap the DB-owner allowlist, obtain exact-target approval before applying them, then rerun verify:write-boundary. Do not accept the historical issuance probe as coordinator proof.");
  } else {
    evidence.push(
      "Operator issuance catalog, trusted operator identity, retention and coordinator controls version 20260915130000 are verified; this is not real Auth, recovery or operational acceptance.",
    );
  }
  if (checks.scheduledRefreshVerified !== true) {
    blockers.push("Durable scheduled-refresh lease migration has not been verified.");
    actions.push("Rehearse and apply scheduled-refresh claim correction " + SCHEDULED_REFRESH_SECURITY_VERSION + " on the intended Supabase project, then rerun verify:write-boundary; cron must not run on the legacy discovery path.");
  } else {
    evidence.push(`Durable scheduled-refresh lease claim, worker fencing, and settlement controls version ${SCHEDULED_REFRESH_SECURITY_VERSION} are verified; real concurrent-worker and recovery acceptance remain separate requirements.`);
  }
  if (checks.dashboardPersistenceAvailable === false) {
    blockers.push(
      "Dashboard persistence probe did not complete; verify Supabase connectivity and schema before operational use.",
    );
  }
  if (!checks.nasaFirmsConfigured) {
    actions.push("Set NASA_FIRMS_MAP_KEY in Vercel and local env.");
  }
  if (!checks.nwsUserAgentConfigured) {
    actions.push("Set FIREAFTER_NWS_USER_AGENT with contact info.");
  }
  if (!checks.cronSecretConfigured) {
    actions.push("Set CRON_SECRET before enabling scheduled refresh.");
  }
  // Diagnostic text is not a public contract, even when supplied by another probe.
  if (checks.errors?.length) {
    actions.push("One or more database checks failed. Ask an operator to verify Supabase connectivity, permissions, and required migrations, then retry.");
  }

  return {
    status: statusFor(blockers, actions, 5),
    blockers,
    actions,
    evidence,
  };
}

function category(input: {
  id: ReadinessCategoryId;
  label: string;
  operationalTarget: number;
  blockers: string[];
  actions: string[];
  evidence: string[];
}): ReadinessCategory {
  const score = readinessScore(input.blockers, input.actions, input.evidence);
  return {
    ...input,
    score,
    status: statusFor(input.blockers, input.actions, score),
  };
}

function readinessScore(blockers: string[], actions: string[], evidence: string[]) {
  if (blockers.length > 0) {
    return clamp(round(2.4 - blockers.length * 0.35 + evidence.length * 0.15, 1), 1, 3.2);
  }
  return clamp(round(5 - actions.length * 0.6 + evidence.length * 0.05, 1), 3.4, 5);
}

function statusFor(
  blockers: string[],
  actions: string[],
  score: number,
): OperationalHealthStatus {
  if (blockers.length > 0) return "blocked";
  if (actions.length > 0 || score < 4.2) return "needs_attention";
  return "operational";
}

function hasSource(bundle: ReadinessBundle, sourceKey: string) {
  return bundle.sourceSnapshots.some((source) => source.sourceKey === sourceKey);
}

function isExplainedNoCoverageItem(limitation: string) {
  const normalized = limitation.toLowerCase();
  return (
    normalized.includes("was reached") ||
    normalized.includes("returned no") ||
    normalized.includes("no firms") ||
    normalized.includes("no matching") ||
    normalized.includes("no current")
  );
}

function isExplainedNoCoverageSource(source: SourceSnapshot) {
  if (source.coverageStatus !== "not_available") return false;
  return isExplainedNoCoverageItem(
    [source.detail, ...(source.warnings ?? [])].join(" "),
  );
}

function isExplainedFallbackAgeSource(source: SourceSnapshot) {
  if (!source.stale || source.status !== "online" || source.coverageStatus !== "available") {
    return false;
  }
  const detail = source.detail.toLowerCase();
  const reasonCodes = source.derivedSignals?.reasonCodes;
  return (
    source.sourceKey === "wfigs-ytd" &&
    (detail.includes("year-to-date perimeter fallback loaded") ||
      (Array.isArray(reasonCodes) && reasonCodes.includes("Recent Fire Perimeter Fallback")))
  );
}

function hasAnySource(bundle: ReadinessBundle, sourceKeys: string[]) {
  return sourceKeys.some((sourceKey) => hasSource(bundle, sourceKey));
}

function hasMatchingAuditEvent(
  action: ResponderAction,
  auditEvents: AuditEvent[],
) {
  return auditEvents.some((event) => {
    if (event.incidentId !== action.recommendationSnapshot.incidentId) {
      return false;
    }
    if (
      event.eventType !== "RecommendationAccepted" &&
      event.eventType !== "RecommendationModified"
    ) {
      return false;
    }

    const payloadAction = event.payload.action;
    const payloadSnapshot = event.payload.recommendationSnapshot;
    const payloadRecommendationId =
      typeof payloadSnapshot === "object" &&
      payloadSnapshot !== null &&
      "id" in payloadSnapshot &&
      typeof payloadSnapshot.id === "string"
        ? payloadSnapshot.id
        : undefined;

    return (
      (event.recommendationId === action.recommendationId ||
        payloadRecommendationId === action.recommendationId) &&
      payloadAction === action.action
    );
  });
}

function isEmptyIncident(incident: Incident) {
  return incident.id === "no-incident-selected" || incident.locationId === "unselected";
}

function round(value: number, places = 0) {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

