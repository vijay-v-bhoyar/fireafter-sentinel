"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IngestionProgress, useIngestionProgress, type IngestionReply } from "./ingestion-progress";
import {
  AlertTriangle,
  Bell,
  Check,
  Clock,
  CloudRain,
  Database,
  ExternalLink,
  FileText,
  Flame,
  Gauge,
  History,
  Layers,
  ListChecks,
  LogIn,
  LogOut,
  Map,
  Pencil,
  RefreshCcw,
  Route,
  Search,
  Settings,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MapLineCanvas } from "./map-line-canvas";
import { InventoryViewportMap } from "./inventory-viewport-map";
import type { MapLineCollection, MapLineState } from "@/lib/map-line-renderer";
import { fetchMapFeatures } from "@/lib/map-feature-client";
import type { MapFeatureCollection, MapFeaturesResponse } from "@/lib/map-stream-contract";
import { MAP_CAPACITY_MESSAGE, MapCapacityError } from "@/lib/map-stream-contract";
import { ResponderCommandSchema, type ResponderCommand } from "@/lib/responder-command";
import { useResponderCommands } from "./use-responder-commands";
import { PublishedHazardReview } from "./published-hazard-review";
import type { CSSProperties } from "react";
import type {
  Asset,
  AuditEvent,
  AuditTrailStatus,
  Incident,
  LocationCandidate,
  Recommendation,
  ResponderAction,
  RiskLevel,
  SourceSnapshot,
} from "@/lib/types";
import type { OperationalHealthReport, OperationalHealthStatus } from "@/lib/readiness";
import { parseApiErrorMessage } from "@/lib/api-error";
import { SIGN_OUT_TIMEOUT_MS, SIGN_OUT_UNCONFIRMED_MESSAGE } from "@/lib/logout-contract";
import {
  buildSourceCoverageMatrix,
  type SourceCoverageItem,
  type SourceCoverageStatus,
} from "@/lib/source-coverage";
import {
  buildEvidenceSummaries,
  buildRecommendationClarity,
  buildRecommendationClarityChecklist,
  displayAssetName,
  highPriorityCaption,
} from "@/lib/recommendation-clarity";
import {
  isSensitiveAssetType,
  redactAssetForPublic,
  redactRecommendationForPublic,
} from "@/lib/sensitive-infrastructure";
import { canWriteOperationalRecords } from "@/lib/role-capabilities";
import { sourceLinkHref } from "@/lib/source-link";
import { IMPORT_REFRESH_UNCONFIRMED, validateAssetImportOutcome } from "@/lib/asset-import-outcome";
import { IMPORT_RECOVERY_UNCONFIRMED, readImportReceipt, type ImportReceipt } from "@/lib/import-operation";
import { checkImportOperation, checkpointImport, clearImportCheckpoint, importRecoveryPrefix, pendingImportOperations, withImportOperationLock } from "@/lib/import-operation-client";
import { hasCurrentSourceEvidence, projectBundleFreshness } from "@/lib/source-freshness";
import { geometryBudget, validateBasinGeometry, PwfdfGeometryError, type BasinGeometry } from "@/lib/pwfdf-geometry";
import { fetchQueuePage } from "@/lib/queue-page-client";
import { QUEUE_PAGE_UNAVAILABLE, type QueuePage } from "@/lib/queue-page-contract";
import {
  COUNTY_SEARCH_QUERY_MAX_CHARS,
  COUNTY_SEARCH_QUERY_MIN_CHARS,
  COUNTY_SEARCH_UNAVAILABLE_MESSAGE,
} from "@/lib/search-query";

type View = "queue" | "map" | "assets" | "history" | "settings";

export type Bundle = {
  incident: Incident;
  locations: LocationCandidate[];
  assets: Asset[];
  sourceSnapshots: SourceSnapshot[];
  recommendations: Recommendation[];
  actions: ResponderAction[];
  auditEvents: AuditEvent[];
  auditEventsStatus?: AuditTrailStatus;
  dataAvailability?: "unavailable";
  dataUnavailableReason?: "not-found" | "access-denied";
  durableIngestionEnabled?: boolean;
  viewportMapEnabled?: boolean;
  currentUser?: {
    id: string;
    email: string;
    organizationId: string | null;
    role: "incident_commander" | "analyst" | "viewer" | null;
  } | null;
  sensitiveInfrastructureAccess?: boolean;
  queuePage?: QueuePage;
};

type DashboardProps = {
  bundle: Bundle;
  initialView: View;
};

type CurrentUser = NonNullable<Bundle["currentUser"]>;
type ActionSubmission = {
  action: ResponderCommand["action"];
  modifiedPriority?: RiskLevel;
};
type ActionConfirmation = {
  recommendationId: string;
  message: string;
};
type FireContextSelection = {
  sourceKey: "wfigs" | "wfigs-ytd";
  sourceFeatureId: string;
};
const riskLevels: RiskLevel[] = ["Very High", "High", "Medium", "Low", "Very Low"];
const actionLabels: Record<ResponderAction["action"], string> = {
  accept: "Accepted",
  modify: "Modified",
  reject: "Rejected",
  annotate: "Annotated",
};

function hasMatchingActionAuditEvent(action: ResponderAction, auditEvents: AuditEvent[]) {
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

    const payloadSnapshot = event.payload.recommendationSnapshot;
    const payloadRecommendationId =
      typeof payloadSnapshot === "object" &&
      payloadSnapshot !== null &&
      "id" in payloadSnapshot &&
      typeof payloadSnapshot.id === "string"
        ? payloadSnapshot.id
        : undefined;

    return (
      event.payload.action === action.action &&
      (event.recommendationId === action.recommendationId ||
        payloadRecommendationId === action.recommendationId)
    );
  });
}

function compareCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }) {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function auditEventDisplayRank(event: AuditEvent) {
  switch (event.eventType) {
    case "RecommendationAccepted":
    case "RecommendationModified":
      return 0;
    case "RecommendationRejected":
    case "RecommendationAnnotated":
      return 1;
    case "AssetsImported":
      return 2;
    case "SourcesRefreshed":
    case "RecommendationCreated":
      return 3;
    case "IncidentCreated":
    default:
      return 4;
  }
}

function sortAuditEventsForHistory(a: AuditEvent, b: AuditEvent) {
  const rankDelta = auditEventDisplayRank(a) - auditEventDisplayRank(b);
  return rankDelta || compareCreatedAtDesc(a, b);
}

const navItems = [
  { view: "queue", href: "/", label: "Action Queue", icon: ListChecks },
  { view: "map", href: "/map", label: "Map View", icon: Map },
  { view: "assets", href: "/assets", label: "Assets", icon: Route },
  { view: "history", href: "/history", label: "History & Audit", icon: History },
  { view: "settings", href: "/settings", label: "Settings", icon: Settings },
] as const;

const SYSTEM_HEALTH_UNAVAILABLE_MESSAGE =
  "Operational Health is unavailable. Verify the app connection and retry.";

const INCIDENT_LOAD_MESSAGES = {
  "not-found": {
    title: "Saved incident unavailable",
    detail: "This link does not identify an available saved incident. Search for a county below to open or create its incident. No other county has been loaded in its place.",
  },
  "access-denied": {
    title: "Incident access unavailable",
    detail: "Your session could not access this incident. Check your sign-in and organization access, then retry. No incident data is displayed.",
  },
  unavailable: {
    title: "Live incident data unavailable",
    detail: "No live incident, source, asset, recommendation, action, or audit data is loaded. Check the incident link and your access, then retry. If loading still fails, ask an operator to review Operational Health.",
  },
};

export function FireAfterDashboard({ bundle, initialView }: DashboardProps) {
  const incidentLoadMessage = INCIDENT_LOAD_MESSAGES[bundle.dataUnavailableReason ?? "unavailable"];
  const pathname = usePathname();
  const view = navItems.find((item) => item.href === pathname)?.view ?? initialView;
  const [storedIncident, setIncident] = useState(bundle.incident);
  const [assets, setAssets] = useState(bundle.assets);
  const [storedSources, setSources] = useState(bundle.sourceSnapshots);
  const [storedRecommendations, setRecommendations] = useState(bundle.recommendations);
  const [queuePage, setQueuePage] = useState(bundle.queuePage);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const queueRead = useRef<AbortController | null>(null);
  const [evidenceClock, setEvidenceClock] = useState<Date | null>(null);
  const currentEvidence = evidenceClock ? projectBundleFreshness({
    incident: storedIncident, sourceSnapshots: storedSources, recommendations: storedRecommendations,
  }, evidenceClock, storedSources[0]?.freshness?.maxAgeMinutes) : {
    incident: storedIncident, sourceSnapshots: storedSources, recommendations: storedRecommendations,
  };
  const { incident, sourceSnapshots: sources, recommendations } = currentEvidence;
  const loginHref = `/login?returnTo=${encodeURIComponent(`${pathname || "/"}?incidentId=${encodeURIComponent(incident.id)}`)}`;
  const expiredEvidenceCount = sources.filter((source) => source.freshness?.state !== "current").length;
  useEffect(() => {
    const startedAt = performance.now();
    const serverTime = Date.parse(bundle.sourceSnapshots[0]?.freshness?.evaluatedAt ?? "");
    const updateClock = () => setEvidenceClock(new Date(Math.max(Date.now(),
      Number.isFinite(serverTime) ? serverTime + performance.now() - startedAt : 0)));
    const initial = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 15_000);
    window.addEventListener("focus", updateClock);
    document.addEventListener("visibilitychange", updateClock);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", updateClock);
      document.removeEventListener("visibilitychange", updateClock);
    };
  }, [bundle.sourceSnapshots]);
  const [actions, setActions] = useState(bundle.actions);
  const [auditEvents, setAuditEvents] = useState(bundle.auditEvents);
  const [currentUser, setCurrentUser] = useState(bundle.currentUser ?? null);
  const ingestion = useIngestionProgress(currentUser?.id);
  const [sensitiveInfrastructureAccess, setSensitiveInfrastructureAccess] = useState(
    bundle.sensitiveInfrastructureAccess === true,
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(bundle.recommendations[0]?.id);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [modifiedPriority, setModifiedPriority] = useState<RiskLevel>("High");
  const [assetImport, setAssetImport] = useState("");
  const [assetImportErrors, setAssetImportErrors] = useState<string[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const mutationInFlight = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmation | null>(null);
  const [lastRecordedActionId, setLastRecordedActionId] = useState<string | null>(null);
  const [lastRecordedAuditEventId, setLastRecordedAuditEventId] = useState<string | null>(null);
  const [importRecovery, setImportRecovery] = useState<{ scope: string; operations: string[] }>({ scope: "", operations: [] });
  const [recoveredImport, setRecoveredImport] = useState<ImportReceipt | null>(null);
  const importInFlight = useRef(false);
  const importScope = { actorId: currentUser?.id ?? "", organizationId: currentUser?.organizationId ?? "", incidentId: incident.id };
  const importScopeKey = currentUser?.id && currentUser.organizationId ? importRecoveryPrefix(importScope) : "";
  const pendingImports = importRecovery.scope === importScopeKey ? importRecovery.operations : [];
  useEffect(() => {
    if (!importScopeKey) return;
    const read = () => {
      try {
        setImportRecovery({ scope: importScopeKey, operations: pendingImportOperations({ actorId: currentUser!.id, organizationId: currentUser!.organizationId!, incidentId: incident.id }, window.localStorage) });
      } catch (error) { setErrorMessage(error instanceof Error ? error.message : IMPORT_RECOVERY_UNCONFIRMED); }
    };
    const timer = window.setTimeout(read, 0);
    window.addEventListener("storage", read);
    return () => { window.clearTimeout(timer); window.removeEventListener("storage", read); };
  }, [importScopeKey, currentUser, incident.id]);
  const [locationResults, setLocationResults] = useState(bundle.locations);
  const [locationSearchError, setLocationSearchError] = useState<string | null>(null);
  const [systemHealth, setSystemHealth] = useState<OperationalHealthReport | null>(null);
  const [systemHealthLoading, setSystemHealthLoading] = useState(false);
  const [systemHealthError, setSystemHealthError] = useState<string | null>(null);
  const [systemHealthRequestKey, setSystemHealthRequestKey] = useState(0);
  const authenticated = Boolean(currentUser);
  const canWrite = canWriteOperationalRecords(currentUser);
  const queueExpired = Boolean(queuePage?.state === "current" && queuePage.expiresAt && evidenceClock && evidenceClock.getTime() >= Date.parse(queuePage.expiresAt));
  useEffect(() => () => queueRead.current?.abort(), [incident.id, currentUser?.id, currentUser?.organizationId]);
  async function loadQueuePage(start: number, latest = false, limit = queuePage?.limit ?? 10) {
    if (!queuePage || !currentUser?.organizationId) return;
    queueRead.current?.abort();
    const controller = new AbortController(); queueRead.current = controller;
    setQueueLoading(true); setQueueError(null);
    try {
      const page = await fetchQueuePage({ incidentId: queuePage.incidentId, start: String(start), limit: String(limit) as "1" | "10" | "25" | "50",
        ...(latest ? {} : { revision: queuePage.revision, state: queuePage.state }) },
      { actorId: currentUser.id, organizationId: currentUser.organizationId }, controller.signal);
      if (controller.signal.aborted) return;
      // A new publication also changes source/incident context; reload that context atomically.
      if (page.revision !== queuePage.revision) { window.location.reload(); return; }
      setQueuePage(page); setRecommendations(page.items.flatMap(item => item.status === "available" ? [item.recommendation] : []));
      setSelectedId(page.items.find(item => item.status === "available")?.recommendation.id);
      setNote("");
    } catch (error) {
      if (!controller.signal.aborted) setQueueError(error instanceof Error ? error.message : QUEUE_PAGE_UNAVAILABLE);
    } finally { if (!controller.signal.aborted) setQueueLoading(false); }
  }
  const responderCommands = useResponderCommands({ actorId: currentUser?.id ?? "", organizationId: currentUser?.organizationId ?? "", incidentId: incident.id, databaseIncidentId: incident.recoveryScopeId ?? "" }, canWrite, result => {
    setActions(current => [result, ...current.filter(action => action.id !== result.id)]);
    setAuditEvents(current => [result.auditEvent, ...current.filter(event => event.id !== result.auditEvent.id)]);
    setLastRecordedActionId(result.id);
    setLastRecordedAuditEventId(result.auditEvent.id);
    setActionConfirmation({ recommendationId: result.recommendationId, message: `${actionLabels[result.action]} recorded in History & Audit.` });
    setErrorMessage(null);
  });
  const canViewSensitive = sensitiveInfrastructureAccess;
  const visibleAssets = canViewSensitive
    ? assets
    : assets.map((asset) => redactAssetForPublic(asset, incident));
  const visibleRecommendations = canViewSensitive
    ? recommendations
    : recommendations.map((recommendation) =>
        redactRecommendationForPublic(recommendation, incident),
      );

  const selectedRecommendation =
    visibleRecommendations.find((item) => item.id === selectedId) ?? visibleRecommendations[0];
  const visibleActionConfirmation =
    selectedRecommendation &&
    actionConfirmation?.recommendationId === selectedRecommendation.id
      ? actionConfirmation.message
      : null;
  const highPriorityCount = recommendations.filter((item) =>
    ["Unknown", "Very High", "High"].includes(item.riskLevel),
  ).length;
  const reviewedDecisionCount = actions.filter(
    (action) =>
      (action.action === "accept" || action.action === "modify") &&
      hasMatchingActionAuditEvent(action, auditEvents),
  ).length;
  const queueDecisionReadinessMessage = reviewedDecisionCount > 0
    ? `${reviewedDecisionCount} accepted/modified responder decision${
        reviewedDecisionCount === 1 ? "" : "s"
      } ${reviewedDecisionCount === 1 ? "is" : "are"} recorded in History & Audit.`
    : queuePage ? "This page does not load decision history. Review History & Audit for prior decisions."
    : recommendations.length === 0
      ? "Refresh live sources first, then accept or modify one recommendation to complete decision readiness."
      : canWrite
        ? "Decision readiness pending: accept or modify one recommendation, then confirm the record in History & Audit."
        : authenticated
          ? "This account is read-only. Commander or analyst membership is required to record a decision."
          : "Sign in to record an accepted/modified recommendation and complete decision readiness.";
  const culvertsLoaded = visibleAssets.filter((asset) => asset.type === "Culvert").length;
  const roadCrossings = visibleAssets.filter((asset) =>
    ["Road Crossing", "Inferred Crossing"].includes(asset.type),
  ).length;
  const downstreamContextItems = visibleRecommendations.filter((recommendation) =>
    recommendation.reasonCodes.some((reason) => reason.toLowerCase().includes("downstream")),
  ).length;
  const currentSources = sources.filter(hasCurrentSourceEvidence).length;
  const limitedSources = sources.length - currentSources;
  const coverageMatrix = buildSourceCoverageMatrix({
    incident,
    assets,
    sourceSnapshots: sources,
    recommendations,
    actions,
    auditEvents,
  });

  useEffect(() => {
    const trimmed = query.trim();
    let cancelled = false;

    if (!trimmed) {
      const timeout = window.setTimeout(() => {
        if (!cancelled) {
          setLocationSearchError(null);
          setLocationResults(bundle.locations);
        }
      }, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timeout);
      };
    }

    if (trimmed.length < COUNTY_SEARCH_QUERY_MIN_CHARS) {
      const timeout = window.setTimeout(() => {
        if (!cancelled) {
          setLocationSearchError(null);
          setLocationResults([]);
        }
      }, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timeout);
      };
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetchJson<{ results: LocationCandidate[] }>(
          `/api/search?query=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (!cancelled) {
          setLocationSearchError(null);
          setLocationResults(response.results);
        }
      } catch (error) {
        if (cancelled || (error instanceof Error && error.name === "AbortError")) {
          return;
        }
        console.warn("[fireafter] county search failed", error);
        if (!cancelled) {
          setLocationSearchError(COUNTY_SEARCH_UNAVAILABLE_MESSAGE);
          setLocationResults(filterLocations(bundle.locations, query));
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [bundle.locations, query]);

  useEffect(() => {
    if (view !== "settings") return;
    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (!cancelled) {
          setSystemHealthLoading(true);
          setSystemHealthError(null);
        }
        return fetchJson<OperationalHealthReport>(
          `/api/readiness?incidentId=${encodeURIComponent(incident.id)}`,
        );
      })
      .then((report) => {
        if (!cancelled) setSystemHealth(report);
      })
      .catch((error) => {
        console.warn("[fireafter] system health check failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        if (!cancelled) {
          setSystemHealth(null);
          setSystemHealthError(SYSTEM_HEALTH_UNAVAILABLE_MESSAGE);
        }
      })
      .finally(() => {
        if (!cancelled) setSystemHealthLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    view,
    incident.id,
    sources.length,
    recommendations.length,
    assets.length,
    actions.length,
    auditEvents.length,
    currentUser?.id,
    systemHealthRequestKey,
    expiredEvidenceCount,
  ]);

  function retrySystemHealth() {
    setSystemHealthRequestKey((current) => current + 1);
  }

  async function handleRefresh() {
    if (!canWrite) {
      setErrorMessage(
        authenticated
          ? "Commander or analyst organization membership is required to refresh an incident."
          : "Sign in as an incident commander or analyst before refreshing an incident.",
      );
      return;
    }

    await runDashboardMutation(async () => {
      const operationId = bundle.durableIngestionEnabled ? ingestion.begin({ kind: "refresh", target: incident.id }) : undefined;
      const refreshed = await fetchJson<Bundle | IngestionReply>(`/api/refresh/${incident.id}`, {
        method: "POST",
        headers: operationId ? { "X-Ingestion-Operation-ID": operationId } : undefined,
      });
      if ("ingestion" in refreshed) { ingestion.accept(refreshed); return; }
      ingestion.clear();
      applyBundle(refreshed);
    });
  }

  async function handleFireContextSelection(selection: FireContextSelection) {
    if (!canWrite) {
      setErrorMessage(
        authenticated
          ? "Commander or analyst organization membership is required to select a fire context."
          : "Sign in as an incident commander or analyst before selecting a fire context.",
      );
      return;
    }

    await runDashboardMutation(async () => {
      const nextBundle = await fetchJson<Bundle>(`/api/fire-context/${incident.id}`, {
        method: "POST",
        body: JSON.stringify(selection),
      });
      applyBundle(nextBundle);
    });
  }

  async function openIncident(locationId: string) {
    if (!canWrite) {
      setErrorMessage(
        authenticated
          ? "Commander or analyst organization membership is required to open a county incident."
          : "Sign in as an incident commander or analyst before opening a county incident.",
      );
      return;
    }

    await runDashboardMutation(async () => {
      const operationId = bundle.durableIngestionEnabled ? ingestion.begin({ kind: "create", target: locationId }) : undefined;
      const nextBundle = await fetchJson<Bundle | IngestionReply>("/api/incident", {
        method: "POST",
        headers: operationId ? { "X-Ingestion-Operation-ID": operationId } : undefined,
        body: JSON.stringify({ locationId }),
      });
      if ("ingestion" in nextBundle) {
        ingestion.accept(nextBundle);
        if (nextBundle.workspace) applyBundle(nextBundle.workspace);
        return;
      }
      ingestion.clear();
      applyBundle(nextBundle);
      const url = new URL(window.location.href);
      url.searchParams.set("incidentId", nextBundle.incident.id);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    });
  }

  async function submitAction(submission: ActionSubmission) {
    if (!selectedRecommendation || !canWrite || isWorking || responderCommands.working || responderCommands.pending) return;
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      setErrorMessage("Safe decision identity is unavailable. No decision was sent. Use a supported browser over HTTPS or localhost.");
      return;
    }
    const trimmedNote = note.trim();
    if (submission.action === "modify" && trimmedNote.length === 0) {
      setErrorMessage("Add a modification note before submitting a modified action.");
      return;
    }

    const parsed = ResponderCommandSchema.safeParse({
      commandId: crypto.randomUUID(), expectedRevision: selectedRecommendation.inventoryRevision,
      recommendationId: selectedRecommendation.id, action: submission.action, note: trimmedNote,
      modifiedPriority: submission.action === "modify" ? submission.modifiedPriority : undefined,
    });
    if (!parsed.success) {
      setErrorMessage("Reload and review the current recommendation inventory before recording a decision. Modifications require a note and priority.");
      return;
    }
    setErrorMessage(null);
    await responderCommands.submit(parsed.data);
  }

  async function submitAssetImport(retryOperationId?: string) {
    const trimmedImport = assetImport.trim();
    setAssetImportErrors([]);

    if (!canWrite) {
      setErrorMessage(
        authenticated
          ? "Commander or analyst organization membership is required to import local assets."
          : "Sign in as an incident commander or analyst before importing local assets.",
      );
      return;
    }

    if (!trimmedImport || importInFlight.current || recoveredImport) return;
    importInFlight.current = true;
    try { await runDashboardMutation(() => withImportOperationLock(importScope, async () => {
      const pending = pendingImportOperations(importScope, window.localStorage);
      if ((pending.length > 0 && !retryOperationId) || (retryOperationId && !pending.includes(retryOperationId))) throw new Error(IMPORT_RECOVERY_UNCONFIRMED);
      const operationId = retryOperationId ?? crypto.randomUUID();
      checkpointImport(importScope, operationId, window.localStorage);
      setImportRecovery({ scope: importScopeKey, operations: pendingImportOperations(importScope, window.localStorage) });
      const result = await fetchJson<{
        operationId: string;
        recovered?: boolean;
        receipt?: unknown;
        assets: Asset[];
        auditEvent: AuditEvent | null;
        importErrors?: string[];
        bundle?: Bundle | null;
        importOutcome: unknown;
      }>(
        "/api/assets/import",
        {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            operationId,
            incidentId: incident.id,
            fileName: `${incident.county.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-assets.csv`,
            content: trimmedImport,
          }),
        },
      );
      if (result.operationId !== operationId) throw new Error(IMPORT_RECOVERY_UNCONFIRMED);
      if (result.recovered === true) {
        confirmRecoveredImport(readImportReceipt(result.receipt, { operationId }));
        return;
      }
      const importErrors = result.importErrors ?? [];
      const outcome = validateAssetImportOutcome(result.importOutcome, result.assets.length, result.auditEvent?.id, Boolean(result.bundle));
      if (result.bundle) {
        applyBundle(result.bundle);
      } else {
        setAssets((current) => [...new globalThis.Map([...current, ...result.assets].map(asset => [asset.id, asset])).values()]);
        const importAuditEvent = result.auditEvent;
        if (importAuditEvent) setAuditEvents((current) => [importAuditEvent, ...current]);
      }
      setAssetImportErrors(importErrors);
      if (result.assets.length > 0) {
        setAssetImport("");
      }
      if (outcome.state === "persisted" && outcome.refresh === "unconfirmed") {
        setRecommendations([]);
        setSelectedId(undefined);
        setErrorMessage(`${IMPORT_REFRESH_UNCONFIRMED} Import reference: ${outcome.auditEventId}`);
      }
      clearImportCheckpoint(importScope, operationId, window.localStorage);
      setImportRecovery({ scope: importScopeKey, operations: pendingImportOperations(importScope, window.localStorage) });
    })); } finally { importInFlight.current = false; }
  }

  function confirmRecoveredImport(receipt: ImportReceipt) {
    // Receipt proves the import, not the separate refresh or current inventory.
    setRecoveredImport(receipt);
    setRecommendations([]);
    setSelectedId(undefined);
    setAssetImport("");
    setErrorMessage("Import persistence is confirmed. Reload current evidence before taking another action; refresh completion is not established by this receipt.");
    clearImportCheckpoint(importScope, receipt.operationId, window.localStorage);
    setImportRecovery({ scope: importScopeKey, operations: pendingImportOperations(importScope, window.localStorage) });
  }

  async function recoverImport(operationId: string) {
    if (!canWrite || importInFlight.current) return;
    importInFlight.current = true;
    try { await runDashboardMutation(() => withImportOperationLock(importScope, async () => {
      const receipt = await checkImportOperation(importScope, operationId);
      if (!receipt) throw new Error(IMPORT_RECOVERY_UNCONFIRMED);
      confirmRecoveredImport(receipt);
    })); } finally { importInFlight.current = false; }
  }

  function applyBundle(nextBundle: Bundle) {
    queueRead.current?.abort(); setQueueLoading(false); setQueueError(null); setQueuePage(nextBundle.queuePage);
    setIncident(nextBundle.incident);
    setAssets(nextBundle.assets);
    setSources(nextBundle.sourceSnapshots);
    setRecommendations(nextBundle.recommendations);
    setActions(nextBundle.actions);
    setAuditEvents(nextBundle.auditEvents);
    setCurrentUser(nextBundle.currentUser ?? currentUser);
    setSensitiveInfrastructureAccess(
      nextBundle.sensitiveInfrastructureAccess === true,
    );
    setSelectedId(nextBundle.recommendations[0]?.id);
  }

  async function runDashboardMutation(operation: () => Promise<void>) {
    if (mutationInFlight.current) return;
    if (recoveredImport) {
      setErrorMessage("Reload current evidence before taking another action.");
      return;
    }
    mutationInFlight.current = true;
    setIsWorking(true);
    setErrorMessage(null);
    try {
      await operation();
    } catch (error) {
      console.error("[fireafter] dashboard mutation failed", error);
      setErrorMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      mutationInFlight.current = false;
      setIsWorking(false);
    }
  }

  return (
    <main className="fireafter-workspace min-h-screen text-slate-100">
      <TopBar
        incident={incident}
        currentUser={currentUser}
        loginHref={loginHref}
      />
      <div className="grid min-h-[calc(100vh-88px)] grid-cols-1 lg:grid-cols-[226px_1fr]">
        <aside className="ops-chrome ops-navigation border-b border-slate-700/60 bg-[var(--ops-inset)] p-4 lg:border-b-0 lg:border-r">
          <div className="rounded-md border border-slate-700/70 bg-slate-900/60 p-4">
            <p className="text-xs font-semibold uppercase text-sky-300">Workspace</p>
            <h2 className="mt-3 text-lg font-semibold">{incident.title}</h2>
            <p className="mt-1 font-mono text-xs text-slate-400">{incident.code}</p>
          </div>
          <nav className="mt-4 space-y-2">
            {navItems.map((item) => (
              <Link
                key={item.view}
                prefetch={false}
                href={`${item.href}?incidentId=${encodeURIComponent(incident.id)}`}
                aria-current={view === item.view ? "page" : undefined}
                className={`flex h-11 items-center gap-3 rounded-md px-3 text-sm transition ${
                  view === item.view
                    ? "bg-sky-500/20 text-white ring-1 ring-sky-400/40"
                    : "text-slate-300 hover:bg-slate-800"
                }`}
              >
                <item.icon size={18} />
                {item.label}
              </Link>
            ))}
            <Link href={`/sentinel?incidentId=${encodeURIComponent(incident.id)}&mode=live&view=overview`} prefetch={false}
              className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-slate-300 hover:bg-slate-800 hover:text-white">
              Sentinel review
            </Link>
            <Link
              href={`/features?incidentId=${encodeURIComponent(incident.id)}`}
              prefetch={false}
              className="flex h-11 items-center gap-3 rounded-md px-3 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-white"
            >
              <Layers size={18} />
              Feature Graph
            </Link>
          </nav>
          <div className="mt-8 rounded-md border border-slate-700/70 bg-slate-900/60 p-4">
            <div className="flex items-center gap-2 text-sm">
              <Database size={18} className="text-emerald-400" />
              <span>Data Sources</span>
            </div>
            <p role="status" aria-label="Source evidence health" className="mt-3 text-sm text-slate-300">
              <span className="text-emerald-300">{currentSources}</span> current,
              <span className="text-amber-300"> {limitedSources}</span> limited
            </p>
            <p className="mt-2 text-xs text-slate-400">
              Current means recently checked with available coverage. Stale, partial or missing evidence stays limited.
            </p>
          </div>
          <div className="mt-4 rounded-md border border-slate-700/70 bg-slate-900/60 p-4 text-sm text-slate-300">
            <p className="font-semibold text-slate-100">Human-in-the-loop review</p>
            <p className="mt-2">
              FireAfter ranks what to review first. It does not issue emergency
              orders or predict exact debris-flow events.
            </p>
          </div>
        </aside>

        <section className="ops-scrollbar overflow-x-hidden p-4 lg:p-6">
          {bundle.dataAvailability === "unavailable" && (
            <section
              aria-label={incidentLoadMessage.title}
              className="mb-4 min-w-0 rounded-md border border-amber-400/40 bg-amber-950/40 p-4 text-sm text-amber-100 [overflow-wrap:anywhere]"
              role="alert"
            >
              <p className="font-semibold">{incidentLoadMessage.title}</p>
              <p className="mt-1">{incidentLoadMessage.detail}</p>
              {bundle.dataUnavailableReason === "not-found" ? (
                <a className="mt-2 inline-block underline" href="#county-search">Search for a county</a>
              ) : (
                <button type="button" className="mt-2 underline" onClick={() => window.location.reload()}>Retry loading live data</button>
              )}
              {bundle.dataUnavailableReason === "access-denied" && <Link prefetch={false} className="mt-3 block underline" href={loginHref}>Sign in with an authorized account</Link>}
              {canWrite && !bundle.dataUnavailableReason && <Link prefetch={false} className="mt-3 block underline" href={incident.id === "no-incident-selected" ? "/assets/browse" : `/assets/browse?incidentId=${encodeURIComponent(incident.id)}`}>Browse saved assets one page at a time</Link>}
            </section>
          )}
          <SearchPanel
            query={query}
            results={locationResults}
            searchError={locationSearchError}
            canOpenIncident={canWrite}
            isWorking={isWorking}
            onQueryChange={setQuery}
            onOpenIncident={openIncident}
          />
          <IngestionProgress state={ingestion} />
          {queuePage ? <section aria-label="Paged queue inventory" className="mb-4 rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4 text-sm">
            <p className="font-semibold">{queuePage.totalStored.toLocaleString()} stored queue positions</p>
            <p className="mt-1 text-slate-300">One page is loaded at a time. Stored totals include withheld records and are not a count of high-risk assets or affected communities.</p>
          </section> : <MetricRow
            highPriority={highPriorityCount}
            recommendationCount={recommendations.length}
            crossings={roadCrossings}
              culverts={culvertsLoaded}
              downstream={downstreamContextItems}
          />}
          {(errorMessage || responderCommands.error) && (
            <p role="alert" className="mb-4 min-w-0 rounded-md border border-amber-400/40 bg-amber-950/40 p-3 text-sm text-amber-100 [overflow-wrap:anywhere]">
              {errorMessage || responderCommands.error}
            </p>
          )}
          {actionConfirmation && (view !== "queue" || !visibleActionConfirmation) && (
            <div role="status" className="mb-4 min-w-0 rounded-md border border-emerald-400/40 bg-emerald-950/50 p-3 text-sm text-emerald-100 [overflow-wrap:anywhere]">
              <p>{actionConfirmation.message}</p>
              <p>Recommendation: {actionConfirmation.recommendationId}</p>
              <Link href={`/history?incidentId=${encodeURIComponent(incident.id)}`} className="mt-2 inline-block underline">View Record</Link>
            </div>
          )}
          {canWrite && pendingImports.length > 0 && (
            <section aria-label="Import recovery" className="mb-4 min-w-0 rounded-md border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100 [overflow-wrap:anywhere]">
              <p>An import needs confirmation. Do not create a replacement import. Check its status, or retry the same reference with the exact original input.</p>
              {pendingImports.map(operationId => <div key={operationId} className="mt-3">
                <p>Operation: {operationId}</p>
                <button type="button" disabled={isWorking} onClick={() => void recoverImport(operationId)} className="mr-4 mt-2 underline disabled:opacity-50">Check import status</button>
                <button type="button" disabled={isWorking || !assetImport.trim()} onClick={() => void submitAssetImport(operationId)} className="mt-2 underline disabled:opacity-50">Retry original import</button>
              </div>)}
            </section>
          )}
            {recoveredImport && <div role="status" aria-label="Import confirmation" className="mb-4 min-w-0 rounded-md border border-sky-400/40 p-4 text-sm [overflow-wrap:anywhere]">
            <p>Confirmed import: {recoveredImport.operationId}. Audit: {recoveredImport.auditEventId}. Accepted records: {recoveredImport.assetCount}.</p>
            <button type="button" onClick={() => window.location.reload()} className="mt-2 underline">Reload current evidence</button>
          </div>}
          {responderCommands.pending && (
            <section aria-label="Decision recovery" className="mb-4 min-w-0 rounded-md border border-amber-400/40 bg-amber-950/40 p-3 text-sm text-amber-100 [overflow-wrap:anywhere]">
              <p>Decision outcome not yet confirmed. Its original reference is retained in this browser. Check its status before retrying; do not submit a replacement.</p>
              <p className="mt-1">Command: {responderCommands.pending.commandId}</p>
              <p>Original decision: {responderCommands.pending.action}. Recommendation: {responderCommands.pending.recommendationId}.</p>
              {responderCommands.pending.modifiedPriority && <p>Original modified priority: {responderCommands.pending.modifiedPriority}.</p>}
              <label className="mt-3 block">Original decision note (needed after reopening for an unconfirmed retry)
                <textarea value={responderCommands.note} onChange={event => responderCommands.setNote(event.target.value)} maxLength={2000} className="mt-1 block w-full rounded border border-amber-300/50 bg-slate-950 p-2" />
              </label>
              <p className="mt-1">Private notes are not saved in browser recovery storage. If the exact note is unavailable, keep this reference and ask your operator to reconcile it.</p>
              <button type="button" disabled={isWorking || responderCommands.working || !canWrite} onClick={() => void responderCommands.checkStatus()} className="mr-3 mt-2 rounded border border-amber-300 px-3 py-2 disabled:opacity-50">Check decision status</button>
              <button type="button" disabled={isWorking || responderCommands.working || !canWrite} onClick={() => void responderCommands.retry()} className="mt-2 rounded border border-amber-300 px-3 py-2 disabled:opacity-50">Retry original decision</button>
            </section>
          )}

          {view === "queue" && (
            <QueueView
              key={`${incident.id}:${queuePage?.start ?? "full"}:${queuePage?.revision ?? ""}`}
              assets={visibleAssets}
              incident={incident}
              sources={sources}
              coverageMatrix={coverageMatrix}
              recommendations={visibleRecommendations}
              paging={queuePage ? { page: queuePage, busy: queueLoading, error: queueError, expired: queueExpired, onLoad: loadQueuePage } : undefined}
              queueDecisionReadinessMessage={queueDecisionReadinessMessage}
              selectedRecommendation={selectedRecommendation}
              selectedId={selectedId}
              note={note}
              modifiedPriority={modifiedPriority}
              actionConfirmation={visibleActionConfirmation}
              canWrite={canWrite}
              authenticated={authenticated}
              onSelect={setSelectedId}
              onNoteChange={setNote}
              onModifiedPriorityChange={setModifiedPriority}
              onRefresh={handleRefresh}
              onFireContextSelect={handleFireContextSelection}
              loginHref={loginHref}
              onAction={submitAction}
              isWorking={isWorking || responderCommands.working || Boolean(responderCommands.pending)}
            />
          )}
          {view === "map" && bundle.dataAvailability !== "unavailable" && (
            <MapView
              incident={incident}
              sources={sources}
              recommendations={queuePage && queueExpired ? [] : visibleRecommendations}
              page={queuePage}
              viewportAuthority={bundle.viewportMapEnabled && canWrite && currentUser?.organizationId ? { actorId: currentUser.id, organizationId: currentUser.organizationId } : undefined}
              expired={queueExpired}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {view === "assets" && (
            <AssetsView
              incidentId={incident.id}
              assets={visibleAssets}
              assetImport={assetImport}
              importErrors={assetImportErrors}
              canWrite={canWrite}
              authenticated={authenticated}
              onAssetImportChange={(value) => {
                setAssetImport(value);
                if (assetImportErrors.length > 0) setAssetImportErrors([]);
              }}
              onImport={() => void submitAssetImport()}
              isWorking={isWorking}
            />
          )}
          {view === "history" && (
            <HistoryView
              actions={actions}
              auditEvents={auditEvents}
              auditEventsStatus={bundle.auditEventsStatus ?? "available"}
              incident={incident}
              canViewSensitive={canViewSensitive}
              highlightedActionId={lastRecordedActionId}
              highlightedAuditEventId={lastRecordedAuditEventId}
              onRetryAuditTrail={() => window.location.reload()}
            />
          )}
          {view === "settings" && (
            <SettingsView
              incident={incident}
              canWrite={canWrite}
              currentUser={currentUser}
              systemHealth={expiredEvidenceCount > 0 && systemHealth?.overallStatus === "operational" ? null : systemHealth}
              systemHealthLoading={systemHealthLoading}
              systemHealthError={expiredEvidenceCount > 0 && systemHealth?.overallStatus === "operational"
                ? "Source evidence expired. Refresh the incident and recheck Operational Health." : systemHealthError}
              onRetrySystemHealth={retrySystemHealth}
              coverageMatrix={coverageMatrix}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function TopBar({
  incident,
  currentUser,
  loginHref,
}: {
  incident: Incident;
  currentUser: CurrentUser | null;
  loginHref: string;
}) {
  const logoutPending = useRef(false);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function handleLogout() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setSigningOut(true);
    setLogoutError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SIGN_OUT_TIMEOUT_MS);
    let confirmed = false;
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Sign-out rejected");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
        throw new Error("Sign-out response unconfirmed");
      }
      // Replace the document, not just the route: discard authenticated React/router state.
      globalThis.location.replace("/login");
      confirmed = true;
    } catch {
      setLogoutError(SIGN_OUT_UNCONFIRMED_MESSAGE);
    } finally {
      clearTimeout(timeout);
      if (!confirmed) {
        logoutPending.current = false;
        setSigningOut(false);
      }
    }
  }

  return (
    <header className="ops-chrome flex flex-col gap-4 border-b border-slate-700/70 bg-[var(--ops-header)] px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-4">
        <div className="relative h-14 w-14 overflow-hidden rounded-md bg-white">
          <Image
            src="/brand/fireafter-logo.jpg"
            alt="FireAfter logo"
            fill
            sizes="56px"
            className="object-contain"
            priority
          />
        </div>
        <div>
          <div className="text-2xl font-bold">
            <span className="text-orange-500">FIRE</span>AFTER
          </div>
          <p className="text-sm text-slate-300">Post-Wildfire Storm Risk. Action First.</p>
        </div>
      </div>
      <div className="grid gap-3 text-sm sm:grid-cols-2 md:grid-cols-[repeat(5,minmax(0,1fr))]">
        <StatusTile icon={CloudRain} label="Storm Window" value={incident.stormWindow} />
        <StatusTile icon={Clock} label="Last Refresh" value={incident.lastRefresh} />
        <StatusTile icon={Database} label="Data Freshness" value={incident.dataFreshness} good />
        <StatusTile icon={Bell} label="Active Alerts" value={incident.alertCoverageStatus === "available"
          ? String(incident.activeAlerts) : incident.alertCoverageStatus === "partial"
            ? `${incident.activeAlerts}+ (partial)` : "Unverified"} alert />
        {currentUser ? (
          <button
            suppressHydrationWarning
            onClick={handleLogout}
            disabled={signingOut}
            aria-label={`Sign out ${currentUser.email}`}
            aria-busy={signingOut}
            aria-describedby={logoutError ? "logout-error" : undefined}
            className="flex min-h-14 min-w-0 items-center gap-3 rounded-md border border-slate-700 bg-slate-900 px-4 text-left"
          >
            <LogOut size={20} className="shrink-0 text-slate-300" />
            <span className="min-w-0">
              <span className="block max-w-40 truncate font-semibold">{currentUser.email}</span>
              <span className="block [overflow-wrap:anywhere] text-xs text-slate-400">
                {currentUser.role ?? "Authenticated"}
              </span>
              <span className="block text-xs text-slate-400">{signingOut ? "Signing out..." : "Sign out (all devices)"}</span>
            </span>
          </button>
        ) : (
          <Link
            href={loginHref}
            className="flex min-h-14 items-center gap-3 rounded-md border border-slate-700 bg-slate-900 px-4 text-left"
          >
            <LogIn size={20} className="text-slate-300" />
            <span>
              <span className="block font-semibold">Sign in</span>
              <span className="block text-xs text-slate-400">Required to write actions</span>
            </span>
          </Link>
        )}
      </div>
      {logoutError && (
        <p id="logout-error" role="alert" className="min-w-0 max-w-xl rounded-md border border-amber-500/50 bg-amber-950/30 p-3 text-sm text-amber-100 [overflow-wrap:anywhere]">
          {logoutError}
        </p>
      )}
    </header>
  );
}

function StatusTile({
  icon: Icon,
  label,
  value,
  good,
  alert,
}: {
  icon: typeof CloudRain;
  label: string;
  value: string;
  good?: boolean;
  alert?: boolean;
}) {
  return (
    <div className="flex min-h-14 min-w-0 items-center gap-3 rounded-md border border-slate-700 bg-slate-900 px-4">
      <Icon
        size={22}
        className={alert ? "text-red-400" : good ? "text-emerald-400" : "text-sky-300"}
      />
      <div className="min-w-0">
        <p className="text-xs uppercase text-slate-400">{label}</p>
        <p className={good ? "font-semibold text-emerald-300" : "font-semibold text-white"}>
          {value}
        </p>
      </div>
    </div>
  );
}

function SearchPanel({
  query,
  results,
  searchError,
  canOpenIncident,
  isWorking,
  onQueryChange,
  onOpenIncident,
}: {
  query: string;
  results: LocationCandidate[];
  searchError: string | null;
  canOpenIncident: boolean;
  isWorking: boolean;
  onQueryChange: (query: string) => void;
  onOpenIncident: (locationId: string) => void;
}) {
  return (
    <section className="mb-4 grid min-w-0 gap-3 rounded-md border border-slate-700/70 bg-slate-900/70 p-4 xl:grid-cols-[minmax(260px,420px)_1fr]">
      <label className="relative block min-w-0">
        <Search className="pointer-events-none absolute left-3 top-3 text-slate-400" size={18} />
        <input
          suppressHydrationWarning
          id="county-search"
          aria-label="Search any U.S. county"
          value={query}
          disabled={isWorking}
          onChange={(event) => onQueryChange(event.target.value)}
          maxLength={COUNTY_SEARCH_QUERY_MAX_CHARS}
          placeholder="Search any U.S. county"
          className="h-11 w-full rounded-md border border-slate-700 bg-[var(--ops-inset)] pl-10 pr-3 text-sm outline-none ring-sky-400/40 focus:ring-2"
        />
      </label>
      {isWorking && (
        <p role="status" aria-label="Live data operation" className="rounded-md border border-sky-400/40 bg-sky-950/40 p-3 text-sm text-sky-100 xl:col-span-2">
          Loading live sources and saving validated data. This can take up to two minutes. Please do not resubmit.
        </p>
      )}
      {searchError && (
        <p
          role="alert"
          className="rounded-md border border-amber-400/40 bg-amber-950/40 p-3 text-sm text-amber-100 xl:col-span-2"
        >
          {searchError} Saved county matches remain available below when present.
        </p>
      )}
      <div className="grid min-w-0 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {results.length === 0 && !searchError && (
          <p className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-3 text-sm text-slate-400">
            {!query.trim()
              ? "Type a U.S. county name to search TIGERweb."
              : query.trim().length < COUNTY_SEARCH_QUERY_MIN_CHARS
                ? `Enter at least ${COUNTY_SEARCH_QUERY_MIN_CHARS} characters to search.`
                : "No TIGERweb county match yet."}
          </p>
        )}
        {results.slice(0, 3).map((result) => (
          <button
            suppressHydrationWarning
            key={result.id}
            onClick={() => onOpenIncident(result.id)}
            disabled={!canOpenIncident || isWorking}
            title={
              canOpenIncident
                ? `Open ${result.label}`
                : "Commander or analyst organization membership is required to open an incident."
            }
            className="min-w-0 rounded-md border border-slate-700 bg-[var(--ops-panel)] p-3 text-left hover:border-sky-400/70 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <p className="text-sm font-semibold [overflow-wrap:anywhere]">{result.label}</p>
            <p className="mt-1 line-clamp-2 text-xs text-slate-400 [overflow-wrap:anywhere]">{result.wildfireContext}</p>
          </button>
        ))}
      </div>
    </section>
  );
}

function MetricRow({
  highPriority,
  recommendationCount,
  crossings,
  culverts,
  downstream,
}: {
  highPriority: number;
  recommendationCount: number;
  crossings: number;
  culverts: number;
  downstream: number;
}) {
  const items = [
    {
      label: "Priority Review Items",
      value: highPriority,
      caption: highPriorityCaption(highPriority, recommendationCount),
      icon: AlertTriangle,
    },
    {
      label: "Road Crossings Loaded",
      value: crossings,
      caption: crossings > 0 ? "Inventory count, not assessed risk" : "No crossings loaded",
      icon: Route,
    },
    {
      label: "Culverts Loaded",
      value: culverts,
      caption: culverts > 0 ? "Inventory count, not assessed risk" : "No culverts loaded",
      icon: Gauge,
    },
    {
      label: "Downstream Context Items",
      value: downstream,
      caption: downstream > 0 ? "Queue items, not a community count" : "No downstream context yet",
      icon: ShieldCheck,
    },
  ];

  return (
    <section className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-300">{item.label}</p>
            <item.icon className="text-orange-400" size={34} />
          </div>
          <p className="mt-2 font-mono text-3xl font-bold">{item.value}</p>
          <p className="mt-1 text-sm text-slate-300">{item.caption}</p>
        </div>
      ))}
    </section>
  );
}

function QueueView({
  assets,
  incident,
  sources,
  coverageMatrix,
  recommendations,
  queueDecisionReadinessMessage,
  selectedRecommendation,
  selectedId,
  note,
  modifiedPriority,
  actionConfirmation,
  canWrite,
  authenticated,
  onSelect,
  onNoteChange,
  onModifiedPriorityChange,
  onRefresh,
  onFireContextSelect,
  loginHref,
  onAction,
  isWorking,
  paging,
}: {
  assets: Asset[];
  incident: Incident;
  sources: SourceSnapshot[];
  coverageMatrix: SourceCoverageItem[];
  recommendations: Recommendation[];
  queueDecisionReadinessMessage: string;
  selectedRecommendation?: Recommendation;
  selectedId?: string;
  note: string;
  modifiedPriority: RiskLevel;
  actionConfirmation: string | null;
  canWrite: boolean;
  authenticated: boolean;
  onSelect: (id: string) => void;
  onNoteChange: (note: string) => void;
  onModifiedPriorityChange: (priority: RiskLevel) => void;
  onRefresh: () => void;
  onFireContextSelect: (selection: FireContextSelection) => void;
  loginHref: string;
  onAction: (submission: ActionSubmission) => void;
  isWorking: boolean;
  paging?: { page: QueuePage; busy: boolean; error: string | null; expired: boolean; onLoad: (start: number, latest?: boolean, limit?: number) => void };
}) {
  const [query, setQuery] = useState("");
  const [basinOnly, setBasinOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(10);
  const search = query.trim().toLowerCase();
  const pageBlocked = Boolean(paging && (paging.busy || paging.error || paging.expired));
  const byId = new globalThis.Map(recommendations.map(item => [item.id, item]));
  const ordered = paging ? paging.page.items.flatMap(item => {
    const recommendation = item.status === "available" ? byId.get(item.recommendation.id) : undefined;
    return recommendation ? [recommendation] : [];
  }) : recommendations;
  const matching = (pageBlocked ? [] : ordered).map((recommendation, index) => ({ recommendation,
    rank: paging?.page.items.find(item => item.status === "available" && item.recommendation.id === recommendation.id)?.position ?? index + 1 }))
    .filter(({ recommendation }) => (!basinOnly || recommendation.evidence?.some(item =>
      item.sourceKey === "usgs-pwfdf" && Boolean(item.sourceFeatureId))) &&
      (!search || `${recommendation.assetName} ${recommendation.locationLabel} ${recommendation.assetType}`.toLowerCase().includes(search)));
  const displayed = paging ? matching : matching.slice(0, visibleCount);
  const reviewCount = displayed.filter(({ recommendation }) =>
    ["Unknown", "Very High", "High"].includes(recommendation.riskLevel),
  ).length;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(420px,1fr)_minmax(420px,580px)]">
      <section className="min-w-0 rounded-md border border-slate-700 bg-[var(--ops-panel)]">
        <div className="flex items-center justify-between border-b border-slate-700 p-4">
          <div>
            <h2 className="text-lg font-bold">Action Queue</h2>
            <p className="mt-1 text-xs uppercase text-slate-400">
              Current storm-window status
            </p>
            <p className="text-sm text-slate-200">
              {incident.status} {" | "} {incident.stormWindow}
            </p>
            <p className="mt-2 text-sm text-slate-300">
              {paging ? `Review-required items on this page: ${reviewCount}. ${paging.page.totalStored.toLocaleString()} stored queue positions.`
                : `Review-required items shown: ${reviewCount} / ${recommendations.length} total locations`}
            </p>
            <p className="mt-2 text-sm font-semibold text-slate-100">
              What should we review first, and why?
            </p>
          </div>
          <button
            suppressHydrationWarning
            onClick={onRefresh}
            disabled={isWorking || !canWrite}
            title={
              canWrite
                ? "Refresh live incident sources"
                : "Commander or analyst organization membership is required to refresh."
            }
            className="flex h-10 items-center gap-2 rounded-md border border-sky-400/40 px-3 text-sm text-sky-200 hover:bg-sky-400/10 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <RefreshCcw size={16} />
            Refresh
          </button>
        </div>
        <div className="m-4 rounded-md border border-emerald-300/20 bg-emerald-950/35 p-3 text-xs text-emerald-100">
          {queueDecisionReadinessMessage}
        </div>
        <FireContextSelector
          incident={incident}
          canWrite={canWrite}
          authenticated={authenticated}
          isWorking={isWorking}
          onSelect={onFireContextSelect}
          loginHref={loginHref}
        />
        {paging ? <p className="mx-4 mb-4 text-sm text-slate-300">Full basin geometry is loaded separately in Map View. Evidence links on these cards are not a newly validated basin-to-asset assessment.</p> : <PublishedHazardReview assets={assets} sources={sources} onReview={asset => {
          setQuery(asset.name); setBasinOnly(false); setVisibleCount(10);
          const recommendation = recommendations.find(item => item.assetId === asset.id);
          if (recommendation) onSelect(recommendation.id);
        }} />}
        {paging && <section aria-label="Queue pages" className="m-4 space-y-3 rounded-md border border-slate-600 p-3 text-sm">
          <p role="status">{paging.page.totalStored ? `Positions ${paging.page.start + 1}-${paging.page.start + paging.page.items.length} of ${paging.page.totalStored.toLocaleString()}` : "No stored queue positions"}.
            {" "}Order: {paging.page.state === "expired" ? "evidence review required" : "published screening priority"}.</p>
          <p className="text-xs text-slate-400">Page filters apply only to these positions. They do not search the full county.</p>
          {paging.busy && <p role="status">Loading queue page...</p>}
          {(paging.error || paging.expired) && <p role="alert" className="text-amber-200">{paging.error ?? "Evidence expired while this page was open. Start from the first page to review the current order."}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={isWorking || paging.busy || paging.expired || Boolean(paging.error) || paging.page.start === 0}
              onClick={() => paging.onLoad(Math.max(0, paging.page.start - paging.page.limit))} className="rounded border border-slate-500 px-3 py-2 disabled:opacity-45">Previous queue page</button>
            <button type="button" disabled={isWorking || paging.busy || paging.expired || Boolean(paging.error) || paging.page.nextStart === null}
              onClick={() => paging.page.nextStart !== null && paging.onLoad(paging.page.nextStart)} className="rounded border border-sky-400/40 px-3 py-2 disabled:opacity-45">Next queue page</button>
            <button type="button" disabled={isWorking || paging.busy} onClick={() => paging.onLoad(0, true)} className="underline disabled:opacity-45">Start from first page</button>
            <label>Items per page <select aria-label="Queue page size" value={paging.page.limit} disabled={isWorking || paging.busy}
              onChange={event => paging.onLoad(0, true, Number(event.target.value))} className="ml-2 rounded border border-slate-500 bg-slate-950 p-2">
              {[1, 10, 25, 50].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
          </div>
        </section>}
        <div className="mx-4 mb-4 space-y-3 rounded-md border border-slate-700 p-3">
          <label className="block text-sm text-slate-200">
            {paging ? "Filter this queue page" : "Search queue assets"}
            <input type="search" value={query} disabled={isWorking || pageBlocked} maxLength={200}
              onChange={event => { setQuery(event.target.value); setVisibleCount(10); }}
              placeholder="Asset name, location or type"
              className="mt-1 h-10 w-full min-w-0 rounded border border-slate-600 bg-slate-950 px-3 text-sm outline-none focus:ring-2 focus:ring-sky-400 disabled:opacity-50" />
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-200">
            <input type="checkbox" checked={basinOnly} disabled={isWorking} className="mt-1"
              onChange={event => { setBasinOnly(event.target.checked); setVisibleCount(10); }} />
            Only items with USGS basin evidence
          </label>
          <p role="status" className="text-xs text-slate-400">
            Showing {displayed.length} of {matching.length} matching {paging ? "items on this page" : "items"}. Original queue ranks are preserved.
            {basinOnly && " Evidence links are not a field-validated hazard assessment; check freshness and limitations."}
          </p>
        </div>
        <div className="max-h-[760px] space-y-3 overflow-y-auto p-4">
          {!paging && recommendations.length === 0 && (
            <p className="rounded-md border border-slate-700 bg-slate-900/80 p-4 text-sm text-slate-300">
              No source-backed recommendations yet. Refresh live sources or upload
              county assets to create auditable action candidates.
            </p>
          )}
          {!pageBlocked && recommendations.length > 0 && matching.length === 0 && (
            <p className="rounded-md border border-slate-700 p-4 text-sm text-slate-300">
              No queue items match these filters. Clear the search or USGS evidence filter to see other assets.
            </p>
          )}
          {!pageBlocked && paging?.page.items.filter(item => item.status === "withheld").map(item => <p key={item.position} className="rounded border border-amber-400/30 p-3 text-sm text-amber-100">
            Position {item.position} withheld: {item.status === "withheld" ? item.reason.replaceAll("-", " ") : ""}. No replacement record or rank was invented.
          </p>)}
          {displayed.map(({ recommendation, rank }) => (
            <RecommendationCard
              key={recommendation.id}
              recommendation={recommendation}
              rank={rank}
              selected={recommendation.id === selectedId}
              onSelect={() => onSelect(recommendation.id)}
            />
          ))}
          {displayed.length < matching.length && (
            <button type="button" disabled={isWorking} onClick={() => setVisibleCount(count => count + 10)}
              className="w-full rounded-md border border-sky-400/40 p-3 text-sm text-sky-200 disabled:opacity-50">
              Show more queue items
            </button>
          )}
          {selectedRecommendation && matching.some(item => item.recommendation.id === selectedRecommendation.id) && (
            <ActionPanel
              recommendation={selectedRecommendation}
              note={note}
              modifiedPriority={modifiedPriority}
              actionConfirmation={actionConfirmation}
              canWrite={canWrite}
              authenticated={authenticated}
              onNoteChange={onNoteChange}
              onModifiedPriorityChange={onModifiedPriorityChange}
              onAction={onAction}
              isWorking={isWorking}
            />
          )}
        </div>
      </section>
      <div className="min-w-0 space-y-4">
        {paging ? <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-5 text-sm">
          <h2 className="text-lg font-bold">Geospatial context</h2>
          <p className="my-3 text-slate-300">The queue loads bounded record pages. Open the map separately for spatial context; check its layer and coverage labels.</p>
          <Link prefetch={false} href={`/map?incidentId=${encodeURIComponent(incident.id)}`} className="text-sky-200 underline">Open Map View</Link>
          <Link prefetch={false} href={`/assets/browse?incidentId=${encodeURIComponent(incident.id)}`} className="ml-4 text-sky-200 underline">Browse stored assets</Link>
        </section> : <OperationalMap
          incident={incident}
          sources={sources}
          recommendations={recommendations}
          selectedId={selectedId}
          onSelect={onSelect}
        />}
        <SourcePanel sources={sources} coverageMatrix={paging ? [] : coverageMatrix} />
      </div>
    </div>
  );
}

function FireContextSelector({
  incident,
  canWrite,
  authenticated,
  isWorking,
  onSelect,
  loginHref,
}: {
  incident: Incident;
  canWrite: boolean;
  authenticated: boolean;
  isWorking: boolean;
  onSelect: (selection: FireContextSelection) => void;
  loginHref: string;
}) {
  const candidates = (incident.fireCandidates ?? []).filter(
    (candidate): candidate is Incident["selectedFire"] & { sourceFeatureId: string } =>
      Boolean(candidate.sourceFeatureId && candidate.sourceKey),
  );
  const selectedIndex = candidates.findIndex(
    (candidate) =>
      candidate.sourceKey === incident.selectedFire.sourceKey &&
      candidate.sourceFeatureId === incident.selectedFire.sourceFeatureId,
  );
  const savedContextNeedsReplacement = candidates.length > 0 && selectedIndex < 0;

  return (
    <section className="mx-4 mb-4 min-w-0 rounded-md border border-orange-300/25 bg-orange-950/20 p-3">
      <div className="flex min-w-0 items-start gap-3">
        <Flame className="mt-0.5 shrink-0 text-orange-300" size={18} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-orange-100">Fire context</p>
          <p className="mt-1 text-xs text-orange-100/75">
            Choose a published WFIGS perimeter before matching USGS PWFDF hazard basins. FireAfter never fabricates a replacement.
          </p>
          {savedContextNeedsReplacement && (
            <p className="mt-3 rounded-md border border-amber-300/30 bg-amber-950/30 p-2 text-xs text-amber-100 [overflow-wrap:anywhere]">
              The saved fire context is no longer published. Select a current candidate before running Refresh so FireAfter can match the correct PWFDF basin layer; it will not switch fires automatically.
            </p>
          )}
          {candidates.length > 0 ? (
            <select
              aria-label="Published WFIGS fire perimeter"
              value={selectedIndex >= 0 ? String(selectedIndex) : ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (!value) return;
                const candidate = candidates[Number(value)];
                if (!candidate || candidate.sourceFeatureId === incident.selectedFire.sourceFeatureId) return;
                onSelect({
                  sourceKey: candidate.sourceKey as FireContextSelection["sourceKey"],
                  sourceFeatureId: candidate.sourceFeatureId,
                });
              }}
              disabled={!canWrite || isWorking}
              className="mt-3 h-10 w-full min-w-0 rounded-md border border-orange-200/30 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-orange-300/50 disabled:cursor-not-allowed disabled:opacity-55"
            >
              <option value="">
                {canWrite
                  ? savedContextNeedsReplacement
                    ? "Select a current published perimeter"
                    : "Select a published perimeter"
                  : "Sign in with responder write access to select"}
              </option>
              {candidates.map((candidate, index) => (
                <option key={`${candidate.sourceKey}-${candidate.sourceFeatureId}`} value={index}>
                  {candidate.name} | {candidate.sourceKey === "wfigs-ytd" ? "year-to-date" : "current"} | {Math.round(candidate.acres).toLocaleString()} acres
                </option>
              ))}
            </select>
          ) : (
            <p className="mt-3 rounded-md border border-slate-700 bg-slate-950/60 p-2 text-xs text-slate-300">
              No published current or year-to-date WFIGS candidates are available for this county. Refresh the official sources and try again.
            </p>
          )}
          <p className="mt-2 min-w-0 text-xs text-slate-300">
            Current context: <span className="font-semibold text-slate-100 [overflow-wrap:anywhere]">{incident.selectedFire.name}</span>
            {incident.selectedFire.sourceKey && (
              <span className="text-slate-400"> ({incident.selectedFire.sourceKey})</span>
            )}
          </p>
          {!canWrite && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-amber-200">
              <p>
                {authenticated
                  ? "This account is read-only. Commander or analyst membership is required."
                  : "Sign in as an incident commander or analyst to change fire context."}
              </p>
              {!authenticated && (
                <Link
                  href={loginHref}
                  className="font-semibold text-sky-200 underline decoration-sky-300/60 underline-offset-2 hover:text-sky-100"
                >
                  Sign in to select a fire
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function RecommendationCard({
  recommendation,
  rank,
  selected,
  onSelect,
}: {
  recommendation: Recommendation;
  rank: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const clarity = buildRecommendationClarity(recommendation);
  const checklist = buildRecommendationClarityChecklist(recommendation);
  const hasMissingSignals = checklist.some((item) => item.status === "warning");
  const asset = clarity.find((item) => item.key === "asset");
  const why = clarity.find((item) => item.key === "why");
  const action = clarity.find((item) => item.key === "action");
  const statusItems = clarity.filter((item) =>
    ["change", "freshness", "confidence"].includes(item.key),
  );
  const evidenceSummaries = buildEvidenceSummaries(recommendation, 2);

  return (
    <button
      suppressHydrationWarning
      onClick={onSelect}
      className={`w-full rounded-md border p-4 text-left transition ${
        selected
          ? "border-sky-400 bg-sky-950/60"
          : "border-slate-700 bg-slate-900/80 hover:border-slate-500"
      }`}
    >
      {hasMissingSignals && (
        <p className="mb-2 rounded-md border border-amber-400/40 bg-amber-950/30 p-2 text-xs text-amber-100">
          Some checklist fields are degraded this refresh; values should be treated as
          advisory until a fuller source refresh.
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
        {checklist.map((item) => (
          <span
            key={item.key}
            title={item.message}
            className={`rounded-full px-2 py-1 ${item.status === "pass"
              ? "bg-emerald-500/15 text-emerald-200 border border-emerald-500/30"
              : "bg-amber-500/15 text-amber-200 border border-amber-500/30"}`
            }
          >
            {item.status === "pass" ? "PASS" : "GAP"} {item.label}
          </span>
        ))}
      </div>
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div className="flex min-w-0 gap-3">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-mono font-bold ${riskBadgeClass(recommendation.riskLevel)}`}>
            {rank}
          </span>
          <div className="min-w-0">
            <h3 className="break-words text-lg font-semibold">{displayAssetName(recommendation.assetName)}</h3>
            <p className="text-sm text-slate-400">
              {asset?.detail ?? recommendation.assetType}
            </p>
          </div>
        </div>
        <div className="text-left sm:shrink-0 sm:text-right">
          <p className={`font-bold ${riskTextClass(recommendation.riskLevel)}`}>
            {recommendation.riskLevel.toUpperCase()}
          </p>
          <p className="font-mono text-sm">{recommendation.riskLevel === "Unknown" ? "Evidence review required" : `Screening score ${recommendation.score100}`}</p>
        </div>
      </div>
      <div className="mt-3">
        <p className="text-xs uppercase text-slate-500">{action?.label}</p>
        <p className="mt-1 text-sm text-slate-200">{action?.value}</p>
      </div>
      <div className="mt-3">
        <p className="text-xs uppercase text-slate-500">{why?.label}</p>
        <p className="mt-1 text-xs text-slate-400">{why?.value}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {recommendation.reasonCodes.slice(0, 5).map((reason) => (
          <span key={reason} className="rounded-md bg-slate-700/80 px-2 py-1 text-xs text-slate-100">
            {reason}
          </span>
        ))}
      </div>
      {recommendation.limitations.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-400/30 bg-amber-950/20 p-2 text-xs text-amber-100">
          <span className="font-semibold">Known limits: </span>
          {recommendation.limitations.slice(0, 2).join(" ")}
        </div>
      )}
      <div className="mt-4 grid gap-3 border-t border-slate-700 pt-3 text-xs text-slate-300 md:grid-cols-3">
        {statusItems.map((item) => (
          <span key={item.key}>
            <span className="block uppercase text-slate-500">{item.label}</span>
            <span className="block text-slate-200">{item.value}</span>
            {item.detail && <span className="block text-slate-500">{item.detail}</span>}
          </span>
        ))}
      </div>
      {evidenceSummaries.length > 0 && (
        <div className="mt-3 text-xs text-slate-400">
          <span className="font-semibold text-slate-300">Source evidence: </span>
          {evidenceSummaries.join(" ")}
        </div>
      )}
    </button>
  );
}

function ActionPanel({
  recommendation,
  note,
  modifiedPriority,
  actionConfirmation,
  canWrite,
  authenticated,
  onNoteChange,
  onModifiedPriorityChange,
  onAction,
  isWorking,
}: {
  recommendation: Recommendation;
  note: string;
  modifiedPriority: RiskLevel;
  actionConfirmation: string | null;
  canWrite: boolean;
  authenticated: boolean;
  onNoteChange: (note: string) => void;
  onModifiedPriorityChange: (priority: RiskLevel) => void;
  onAction: (submission: ActionSubmission) => void;
  isWorking: boolean;
}) {
  const noteRequiredForModify = note.trim().length === 0;

  return (
    <section className="mt-4 rounded-md border border-slate-700 bg-[var(--ops-header)] p-4">
      <p className="text-sm font-semibold text-slate-300">Responder Action</p>
      <h3 className="mt-1 font-semibold">{displayAssetName(recommendation.assetName)}</h3>
      {actionConfirmation && (
        <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-400/40 bg-emerald-950/50 p-3 text-sm text-emerald-100">
          <span className="flex items-center gap-2">
            <Check size={16} />
            {actionConfirmation}
          </span>
          <Link
            href={`/history?incidentId=${encodeURIComponent(recommendation.incidentId)}`}
            className="rounded-md border border-emerald-300/50 px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-400/10"
          >
            View Record
          </Link>
        </div>
      )}
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        <ActionButton
          disabled={!canWrite}
          isWorking={isWorking}
          icon={Check}
          label="Accept"
          tone="green"
          onClick={() => onAction({ action: "accept" })}
        />
        <ActionButton
          disabled={!canWrite || noteRequiredForModify}
          isWorking={isWorking}
          icon={Pencil}
          label="Modify"
          tone="blue"
          onClick={() =>
            onAction({ action: "modify", modifiedPriority })
          }
        />
        <ActionButton
          disabled={!canWrite}
          isWorking={isWorking}
          icon={X}
          label="Reject"
          tone="red"
          onClick={() => onAction({ action: "reject" })}
        />
        <ActionButton disabled={!canWrite} isWorking={isWorking} icon={FileText} label="Annotate" tone="blue" onClick={() => onAction({ action: "annotate" })} />
      </div>
      <label className="mt-4 block">
        <span className="text-sm text-slate-300">Modified priority</span>
        <select
          suppressHydrationWarning
          value={modifiedPriority}
          onChange={(event) =>
            onModifiedPriorityChange(event.target.value as RiskLevel)
          }
          className="mt-2 h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none ring-sky-400/40 focus:ring-2"
        >
          {riskLevels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-4 block">
        <span className="text-sm text-slate-300">Action note</span>
        <textarea
          suppressHydrationWarning
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          rows={3}
          className="mt-2 w-full resize-none rounded-md border border-slate-700 bg-slate-950 p-3 text-sm outline-none ring-sky-400/40 focus:ring-2"
        />
      </label>
      {noteRequiredForModify && (
        <p className="mt-2 text-xs text-amber-300">
          Modification requires a note before it can be recorded.
        </p>
      )}
      {!canWrite && (
        <p className="mt-3 text-sm text-amber-300">
          {authenticated
            ? "This account is read-only. Commander or analyst organization membership is required to write audit records."
            : "Sign in as an incident commander or analyst before writing audit records."}
        </p>
      )}
    </section>
  );
}

function ActionButton({
  icon: Icon,
  label,
  tone,
  disabled,
  isWorking,
  onClick,
}: {
  icon: typeof Check;
  label: string;
  tone: "green" | "blue" | "red";
  disabled: boolean;
  isWorking: boolean;
  onClick: () => void;
}) {
  const classes = {
    green: "bg-emerald-600 hover:bg-emerald-500",
    blue: "bg-blue-600 hover:bg-blue-500",
    red: "bg-red-700 hover:bg-red-600",
  };

  return (
    <button
      suppressHydrationWarning
      disabled={disabled || isWorking}
      onClick={onClick}
      className={`flex h-12 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45 ${classes[tone]}`}
    >
      <Icon size={17} />
      {label}
    </button>
  );
}

export function OperationalMap({
  incident,
  sources,
  recommendations,
  selectedId,
  onSelect,
  positions,
}: {
  incident: Incident;
  sources: SourceSnapshot[];
  recommendations: Recommendation[];
  selectedId?: string;
  onSelect: (id: string) => void;
  positions?: ReadonlyMap<string, number>;
}) {
  const sourceRevision = JSON.stringify(sources.map((source) => [source.id, source.fetchedAt]).sort());
  const revision = `${incident.id}:${sourceRevision}`;
  const [mapFeatures, setMapFeatures] = useState<(MapFeaturesResponse & { loadedRevision: string }) | null>(null);
  const [failedRevision, setFailedRevision] = useState<string | null>(null);
  const [capacityRevision, setCapacityRevision] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [lineStates, setLineStates] = useState<Record<string, { collection: MapLineCollection; state: MapLineState }>>({});
  const mapFeaturesCurrent = mapFeatures?.incidentId === incident.id && mapFeatures.loadedRevision === revision;
  const hasFireContext =
    incident.selectedFire.coverageStatus !== "not_available" &&
    incident.selectedFire.acres > 0;
  const roads = mapFeaturesCurrent ? mapFeatures.roads : undefined;
  const hydrography = mapFeaturesCurrent ? mapFeatures.hydrography : undefined;
  const roadPartCount = lineStates.road?.collection === roads && lineStates.road?.state.status === "ready" ? lineStates.road.state.parts : 0;
  const hydroPartCount = lineStates.hydro?.collection === hydrography && lineStates.hydro?.state.status === "ready" ? lineStates.hydro.state.parts : 0;
  const basinLayer = extractMapPolygons(mapFeaturesCurrent ? mapFeatures?.pwfdfBasins : undefined);
  const canDrawVectors = Boolean(incident.locationContext?.bbox);
  const mapLayers = [
    { label: "County Boundary", loaded: Boolean(mapFeaturesCurrent && mapFeatures?.county.features.length) },
    { label: "Road Network", loaded: canDrawVectors && roadPartCount > 0,
      pending: canDrawVectors && Boolean(roads) && (lineStates.road?.collection !== roads || lineStates.road.state.status === "drawing") },
    { label: "Hydrography", loaded: canDrawVectors && hydroPartCount > 0,
      pending: canDrawVectors && Boolean(hydrography) && (lineStates.hydro?.collection !== hydrography || lineStates.hydro.state.status === "drawing") },
    { label: "USGS Debris-Flow Basins", loaded: canDrawVectors && basinLayer.basins.length > 0 },
    { label: "Response Assets", loaded: Boolean(mapFeaturesCurrent && mapFeatures?.assets.features.length) },
    { label: "Ranked Priorities", loaded: Boolean(mapFeaturesCurrent && mapFeatures?.recommendations.features.length) },
  ];
  const loadedLayerCount = mapLayers.filter((layer) => layer.loaded).length;
  const markerRecommendations = recommendations.flatMap((recommendation, index) => {
    const rank = positions ? positions.get(recommendation.id) : index + 1;
    return rank === undefined ? [] : [{ recommendation, rank }];
  })
    .filter(({ recommendation, rank }) => rank <= 6 || recommendation.id === selectedId);
  const keyAlertLabel =
    incident.alertCoverageStatus !== "available" ? "Alert coverage unverified" : incident.activeAlerts > 0
      ? `${incident.activeAlerts} active alert${incident.activeAlerts === 1 ? "" : "s"}`
      : "None active";

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    fetchMapFeatures(incident.id, controller.signal)
      .then((result) => {
        if (!cancelled) {
          if (result.incidentId !== incident.id) throw new Error("Map incident mismatch");
          setMapFeatures({ ...result, loadedRevision: revision });
          setFailedRevision(null);
          setCapacityRevision(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[fireafter] map feature load failed", error);
        setMapFeatures(null);
        setFailedRevision(revision);
        setCapacityRevision(error instanceof MapCapacityError ? revision : null);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [incident.id, revision, retryCount]);

  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-slate-700 bg-slate-950">
      <div className="grid gap-3 border-b border-slate-700 bg-[var(--ops-inset)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Map Layers</p>
          {!mapFeaturesCurrent && (
            <p role="status" className="mt-2 text-xs text-amber-300">
              {failedRevision === revision ? capacityRevision === revision ? MAP_CAPACITY_MESSAGE : "Source geometry unavailable. Retry loading the map." : "Loading current source geometry."}
              {failedRevision === revision && capacityRevision === revision && (
                <Link prefetch={false} className="ml-2 underline" href={`/?incidentId=${encodeURIComponent(incident.id)}`}>Open Action Queue</Link>
              )}
              {failedRevision === revision && (
                <button type="button" className="ml-2 underline" onClick={() => { setFailedRevision(null); setRetryCount((count) => count + 1); }}>Retry map</button>
              )}
            </p>
          )}
          {mapFeaturesCurrent && (mapFeatures?.roads.warning || mapFeatures?.hydrography.warning) && (
            <p role="status" className="mt-2 text-xs text-amber-300 [overflow-wrap:anywhere]">
              {mapFeatures?.roads.warning || mapFeatures?.hydrography.warning}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {mapLayers.map((layer) => (
              <div
                key={layer.label}
                className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1.5 text-xs"
              >
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-sm ${
                    layer.loaded ? "bg-sky-400" : "border border-slate-500 bg-slate-800"
                  }`}
                />
                <span>{layer.label}</span>
                <span className="sr-only">
                  {layer.loaded ? "loaded" : !mapFeaturesCurrent || layer.pending ? "loading" : "not available"}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] uppercase tracking-wide text-slate-400">
            Source-backed vectors on schematic terrain
          </p>
        </div>
        <div className="min-w-0 rounded-md border border-slate-700 bg-slate-900/80 p-3 text-sm sm:max-w-64">
          <p className="font-semibold [overflow-wrap:anywhere]">{incident.selectedFire.name}</p>
          <p className="mt-1 text-slate-300">
            {incident.selectedFire.acres.toLocaleString()} acres burned
          </p>
        </div>
      </div>
      <div className="relative min-h-[420px] overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_28%_34%,rgba(99,110,77,0.8),transparent_34%),radial-gradient(ellipse_at_72%_64%,rgba(87,78,55,0.8),transparent_38%),linear-gradient(145deg,#34483b,#202e27_62%,#4b5036)]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(148,163,184,0.2)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.2)_1px,transparent_1px)] [background-size:32px_32px]"
        />
        {hasFireContext && (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_38%_42%,rgba(249,115,22,0.65),transparent_27%),radial-gradient(circle_at_52%_55%,rgba(239,68,68,0.38),transparent_24%),linear-gradient(135deg,rgba(14,165,233,0.18),transparent_45%)]" />
        )}
        <SourceLayerOverlay
          roadPartCount={roadPartCount}
          hydroPartCount={hydroPartCount}
          basinLayer={basinLayer}
          bbox={incident.locationContext?.bbox}
        />
        {incident.locationContext?.bbox && hydrography && <MapLineCanvas collection={hydrography} bounds={incident.locationContext.bbox}
          label="hydrography" color="rgba(56,189,248,0.62)" width={0.34}
          onState={(collection, state) => setLineStates(previous => ({ ...previous, hydro: { collection, state } }))} />}
        {incident.locationContext?.bbox && roads && <MapLineCanvas collection={roads} bounds={incident.locationContext.bbox}
          label="road" color="rgba(226,232,240,0.52)" width={0.3}
          onState={(collection, state) => setLineStates(previous => ({ ...previous, road: { collection, state } }))} />}
        <CountyBoundaryOverlay incident={incident} />
        {markerRecommendations.map(({ recommendation, rank }) => (
          <button
            suppressHydrationWarning
            key={recommendation.id}
            onClick={() => onSelect(recommendation.id)}
            className={`absolute flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 font-mono font-bold text-white shadow-lg ${
              recommendation.id === selectedId ? "scale-125 border-white" : "border-slate-950"
            } ${riskBadgeClass(recommendation.riskLevel)}`}
            style={projectMapPoint(recommendation.coordinates, incident.locationContext?.bbox)}
            aria-label={`Select ${displayAssetName(recommendation.assetName)}`}
          >
            {rank}
          </button>
        ))}
      </div>
      <div className="grid gap-2 border-t border-slate-700 bg-[var(--ops-inset)] p-3 sm:grid-cols-3 md:gap-3">
        <SmallMapCard icon={CloudRain} label="Weather Outlook" value={incident.rainfallForecast} />
        <SmallMapCard icon={Database} label="Layers Loaded" value={`${loadedLayerCount} / 6`} />
        <SmallMapCard icon={AlertTriangle} label="Key Alerts" value={keyAlertLabel} />
      </div>
    </section>
  );
}

function SourceLayerOverlay({
  roadPartCount,
  hydroPartCount,
  basinLayer,
  bbox,
}: {
  roadPartCount: number;
  hydroPartCount: number;
  basinLayer: ReturnType<typeof extractMapPolygons>;
  bbox?: [number, number, number, number];
}) {
  if (!bbox) return null;

  const basinPolygons = basinLayer.basins;

  return (
    <>
    {basinLayer.warning ? <div role="alert" className="absolute inset-x-3 top-3 z-20 rounded bg-slate-950 p-3 text-sm text-amber-200">{basinLayer.warning}</div> : null}
    <svg
      aria-label={`${roadPartCount} road parts, ${hydroPartCount} hydrography parts, and ${basinPolygons.length} USGS debris-flow basin source features`}
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
    >
      {basinPolygons.map((basin) => (
        <path
          key={basin.id}
          d={(basin.geometry.type === "Polygon" ? [basin.geometry.coordinates] : basin.geometry.coordinates)
            .flatMap(polygon => polygon.map(ring => `M${ring.map(coordinate => mapPointString(coordinate, bbox)).join(" L")} Z`)).join(" ")}
          fillRule="evenodd"
          fill={pwfdfHazardColor(basin.combinedHazard, 0.28)}
          stroke={pwfdfHazardColor(basin.combinedHazard, 0.82)}
          strokeWidth="0.28"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
    </>
  );
}

function extractMapPolygons(collection?: MapFeatureCollection): {
  basins: Array<{ id: string; geometry: BasinGeometry; combinedHazard: "Low" | "Moderate" | "High" }>;
  warning?: string;
} {
  if (!collection) return { basins: [] };
  const warning = "PWFDF layer unavailable: invalid or over-budget basin geometry. Ask an authorized GIS reviewer to inspect the source and refresh.";
  const budget = geometryBudget();
  try {
    if ("warning" in collection && collection.warning) return { basins: [], warning };
    if (collection.features.length > 500) throw new PwfdfGeometryError("pwfdf_geometry_budget");
    const ids = new Set<string>();
    const basins = collection.features.map(feature => {
      const id = feature.properties?.id, combinedHazard = feature.properties?.combinedHazard;
      if (typeof id !== "string" || !id || ids.has(id) ||
          (combinedHazard !== "Low" && combinedHazard !== "Moderate" && combinedHazard !== "High")) throw new PwfdfGeometryError();
      ids.add(id);
      return { id, combinedHazard, geometry: validateBasinGeometry(feature.geometry, budget) } as const;
    });
    return { basins };
  } catch { return { basins: [], warning }; }
}

function pwfdfHazardColor(hazard: "Low" | "Moderate" | "High", alpha: number) {
  const color = hazard === "High" ? "239,68,68" : hazard === "Moderate" ? "249,115,22" : "250,204,21";
  return `rgba(${color},${alpha})`;
}

function mapPointString(
  coordinate: [number, number],
  bbox: [number, number, number, number],
) {
  const [west, south, east, north] = bbox;
  // Clip vectors at the SVG viewport instead of bending them onto the marker inset.
  return `${((coordinate[0] - west) / (east - west)) * 100},${(1 - (coordinate[1] - south) / (north - south)) * 100}`;
}

function SmallMapCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CloudRain;
  label: string;
  value: string;
}) {
  return (
    <div className="ops-chrome min-w-0 rounded-md border border-slate-700 bg-[var(--ops-inset)] p-2 text-slate-100 md:p-3">
      <div className="flex items-center gap-2 text-xs font-semibold md:text-sm">
        <Icon size={18} className="hidden shrink-0 text-sky-300 md:block" />
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-1 text-xs text-slate-300 md:mt-2 md:text-sm">{value}</p>
    </div>
  );
}

function CountyBoundaryOverlay({ incident }: { incident: Incident }) {
  const boundary = incident.locationContext?.boundary;
  const bbox = incident.locationContext?.bbox;
  if (!boundary || (boundary.type !== "Polygon" && boundary.type !== "MultiPolygon") || !bbox) return null;

  const rings = (boundary.type === "Polygon" ? boundary.coordinates : boundary.coordinates.flat())
    .map((ring) =>
      ring
        .map((coordinate) => {
          const point = projectCoordinate(coordinate, bbox);
          return `${point.x},${point.y}`;
        })
        .join(" "),
    )
    .filter(Boolean);

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path
          d={rings.map(points => `M ${points.replaceAll(" ", " L ")} Z`).join(" ")}
          fillRule="evenodd"
          fill="rgba(14,165,233,0.08)"
          stroke="rgba(125,211,252,0.75)"
          strokeWidth="0.35"
        />
    </svg>
  );
}

function SourcePanel({
  sources,
  coverageMatrix,
}: {
  sources: SourceSnapshot[];
  coverageMatrix: SourceCoverageItem[];
}) {
  const groupedCoverage = groupCoverageByCategory(coverageMatrix);

  return (
    <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">Source Freshness</h2>
        <span className="text-xs text-slate-400">Live, delayed, and upload-required states</span>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {groupedCoverage.map(([category, items]) => (
          <div key={category} className="min-w-0 rounded-md border border-slate-700 bg-slate-950/70 p-3">
            <p className="text-xs font-semibold uppercase text-slate-400">{category}</p>
            <div className="mt-2 space-y-2">
              {items.map((item) => (
                <div key={`${category}-${item.item}`} className="grid min-w-0 gap-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 text-sm text-slate-200 [overflow-wrap:anywhere]">{item.item}</p>
                    <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${coverageBadgeClass(item.status)}`}>
                      {item.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 [overflow-wrap:anywhere]">{item.evidence}</p>
                  {(item.status === "Delayed" ||
                    item.status === "Not Available" ||
                    item.status === "Upload Required" ||
                    item.status === "Partial / Proxy") && (
                    <p className="text-xs text-amber-200 [overflow-wrap:anywhere]">{item.limitation}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs font-semibold uppercase text-slate-500">Feed details</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {sources.map((source) => (
          <div data-source-row key={source.id} className="min-w-0 rounded-md border border-slate-700 bg-slate-900/80 p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{source.sourceName}</p>
              <span className={hasCurrentSourceEvidence(source) ? "text-xs text-emerald-300" : "text-xs text-amber-300"}
                title={hasCurrentSourceEvidence(source) ? "Current, available evidence" : "Limited evidence: review age, coverage and retrieval status"}>
                {source.freshnessLabel}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-400 [overflow-wrap:anywhere]">{source.detail}</p>
            {(source.warnings?.length ?? 0) > 0 && (
              <p className="mt-2 text-xs text-amber-300 [overflow-wrap:anywhere]">
                {source.warnings?.slice(0, 2).join(" ")}
              </p>
            )}
            {sourceLinkHref(source.sourceUrl) && (
              <a
                data-source-link
                href={sourceLinkHref(source.sourceUrl) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${source.sourceName} official source`}
                title={sourceLinkHref(source.sourceUrl) ?? undefined}
                className="mt-2 inline-flex min-w-0 max-w-full items-center gap-1 rounded text-xs font-semibold text-sky-300 underline decoration-sky-400/50 underline-offset-2 hover:text-sky-100 focus:outline-none focus:ring-2 focus:ring-sky-300/60"
              >
                <ExternalLink size={12} aria-hidden="true" />
                <span className="min-w-0 max-w-full truncate">Open official source</span>
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function MapView({
  incident,
  sources,
  recommendations,
  selectedId,
  onSelect,
  page,
  expired,
  viewportAuthority,
}: {
  incident: Incident;
  sources: SourceSnapshot[];
  recommendations: Recommendation[];
  selectedId?: string;
  onSelect: (id: string) => void;
  page?: QueuePage;
  expired?: boolean;
  viewportAuthority?: { actorId: string; organizationId: string };
}) {
  const positions = page ? new globalThis.Map(page.items.flatMap(item => item.status === "available" ? [[item.recommendation.id, item.position] as const] : [])) : undefined;
  const priorities = positions ? recommendations.filter(item => positions.has(item.id))
    .sort((left, right) => positions.get(left.id)! - positions.get(right.id)!) : recommendations;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      {viewportAuthority && page ? <InventoryViewportMap incident={incident} revision={page.revision} authority={viewportAuthority} /> : <OperationalMap
        incident={incident}
        sources={sources}
        recommendations={priorities}
        selectedId={selectedId}
        onSelect={onSelect}
        positions={positions}
      />}
      <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
        <h2 className="font-bold">Selected Map Priorities</h2>
        {page && <div className="mt-3 text-sm text-slate-300">
          {expired ? <p role="alert">Priority evidence expired. Open the Action Queue to reload verified positions; old priority markers are hidden.</p>
            : <p>Initial priority page: {page.items.length} stored positions, {page.items.filter(item => item.status === "available").length} available and {page.items.filter(item => item.status === "withheld").length} withheld. Labels retain published positions. This is not the complete asset inventory.</p>}
          <p className="mt-2">{viewportAuthority ? "The map shows saved asset locations, not hazard ranks. Source overlays are not loaded in this view." : "Map layers load separately. An unavailable layer does not mean the county has no assets or hazard evidence."}</p>
          <Link prefetch={false} className="mt-2 inline-block underline" href={`/?incidentId=${encodeURIComponent(incident.id)}`}>Browse the complete Action Queue</Link>
        </div>}
        <div className="mt-4 space-y-3">
          {priorities.slice(0, 5).map((recommendation, index) => (
            <button
              suppressHydrationWarning
              key={recommendation.id}
              onClick={() => onSelect(recommendation.id)}
              className="w-full rounded-md border border-slate-700 bg-slate-900 p-3 text-left hover:border-sky-400"
            >
              <p className="text-sm font-semibold">
                {positions?.get(recommendation.id) ?? index + 1}. {displayAssetName(recommendation.assetName)}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {recommendation.riskLevel} | {recommendation.riskLevel === "Unknown" ? "Evidence review required" : `Screening score ${recommendation.score100}`}
              </p>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function AssetsView({
  incidentId,
  assets,
  assetImport,
  importErrors,
  canWrite,
  authenticated,
  onAssetImportChange,
  onImport,
  isWorking,
}: {
  incidentId: string;
  assets: Asset[];
  assetImport: string;
  importErrors: string[];
  canWrite: boolean;
  authenticated: boolean;
  onAssetImportChange: (value: string) => void;
  onImport: () => void;
  isWorking: boolean;
}) {
  const groups = [
    {
      label: "Inferred Crossings",
      description: "Public TIGERweb road geometry intersected with USGS 3DHP flowline candidates.",
      assets: assets.filter((asset) =>
        ["Inferred Crossing", "Road Crossing"].includes(asset.type) && !asset.localOrUploaded,
      ),
    },
    {
      label: "Bridges",
      description: "FHWA/BTS National Bridge Inventory or uploaded bridge records.",
      assets: assets.filter((asset) => asset.type === "Bridge"),
    },
    {
      label: "Critical Facilities",
      description: "USGS TNM hospitals/fire/EMS stations or uploaded facility records.",
      assets: assets.filter((asset) => asset.type === "Critical Facility"),
    },
    {
      label: "Uploaded Local Assets",
      description: "County GIS or public works CSV/GeoJSON records for culverts and evacuation routes. Uploads remain unverified with Low confidence; format checks do not establish field accuracy or condition.",
      assets: assets.filter((asset) => asset.localOrUploaded),
    },
  ];

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
      <section className="min-w-0 rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
        <h2 className="font-bold">County Assets</h2>
        {canWrite && <Link prefetch={false} className="mt-2 inline-block text-sm text-sky-300 underline" href={`/assets/browse?incidentId=${encodeURIComponent(incidentId)}`}>Browse stored inventory by page</Link>}
        <p className="mt-2 text-sm text-slate-400">
          Source-backed candidates come from public roads, hydrography, bridge,
          and critical-facility layers. Culverts and evacuation routes require
          local upload unless a county publishes them in a compatible file.
          Sensitive facility names and exact coordinates are limited to signed-in
          response users.
        </p>
        <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
          {groups.map((group) => (
            <div key={group.label} className="min-w-0 rounded-md border border-slate-700 bg-slate-950/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-100">{group.label}</p>
                <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-200">
                  {group.assets.length}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-400">{group.description}</p>
              {group.assets.length === 0 && (
                <p className="mt-2 text-xs text-amber-200">
                  {group.label === "Uploaded Local Assets"
                    ? "Upload required for local culvert, evacuation-route, and public works coverage."
                    : "No candidates loaded from this source yet."}
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 max-w-full overflow-x-auto rounded-md border border-slate-700">
          <table className="min-w-[620px] w-full text-left text-sm">
            <thead className="bg-slate-900 text-xs uppercase text-slate-400">
              <tr>
                <th className="p-3">Asset</th>
                <th className="p-3">Type</th>
                <th className="p-3">Source</th>
                <th className="p-3">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 && (
                <tr>
                  <td className="p-3 text-slate-400" colSpan={4}>
                    No source-backed or uploaded county assets loaded yet.
                  </td>
                </tr>
              )}
              {assets.map((asset) => (
                <tr key={asset.id} className="border-t border-slate-700">
                  <td className="p-3 font-semibold">{asset.name}</td>
                  <td className="p-3 text-slate-300">{asset.type}</td>
                  <td className="p-3 text-slate-300">{asset.source}</td>
                  <td className="p-3">{asset.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
        <div className="flex items-center gap-2">
          <Upload size={18} className="text-sky-300" />
          <h2 className="font-bold">Local Asset Upload</h2>
        </div>
        <p className="mt-2 text-sm text-slate-400">
          Import local culverts, crossings, evacuation routes, or facilities from
          CSV or a GeoJSON FeatureCollection. Uploads remain unverified with Low
          confidence; format checks do not establish field accuracy or condition.
          Use 2D WGS84 Point, LineString, or Polygon geometry within the incident envelope.
        </p>
        {!canWrite && (
          <p className="mt-3 rounded-md border border-amber-400/40 bg-amber-950/40 p-3 text-sm text-amber-100">
            {authenticated
              ? "This account is read-only. Commander or analyst organization membership is required to import local assets."
              : "Sign in as an incident commander or analyst before importing local assets."}
          </p>
        )}
        <textarea
          suppressHydrationWarning
          aria-label="Local asset CSV or GeoJSON"
          value={assetImport}
          onChange={(event) => onAssetImportChange(event.target.value)}
          placeholder="Paste CSV with name,type,lat,lon or a GeoJSON FeatureCollection."
          rows={8}
          className="mt-4 w-full resize-none rounded-md border border-slate-700 bg-slate-950 p-3 font-mono text-xs outline-none ring-sky-400/40 focus:ring-2"
        />
        <button
          suppressHydrationWarning
          onClick={onImport}
          disabled={isWorking || !canWrite || assetImport.trim().length === 0}
          className="mt-3 flex h-10 items-center gap-2 rounded-md bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Upload size={16} />
          Import Assets
        </button>
        {importErrors.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-400/40 bg-amber-950/30 p-3 text-sm text-amber-100">
            <p className="font-semibold">Import validation</p>
            <ul className="mt-2 space-y-1">
              {importErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryView({
  actions,
  auditEvents,
  auditEventsStatus,
  incident,
  canViewSensitive,
  highlightedActionId,
  highlightedAuditEventId,
  onRetryAuditTrail,
}: {
  actions: ResponderAction[];
  auditEvents: AuditEvent[];
  auditEventsStatus: AuditTrailStatus;
  incident: Incident;
  canViewSensitive: boolean;
  highlightedActionId: string | null;
  highlightedAuditEventId: string | null;
  onRetryAuditTrail: () => void;
}) {
  const orderedActions = [...actions].sort(compareCreatedAtDesc);
  const orderedAuditEvents = [...auditEvents].sort(sortAuditEventsForHistory);
  const decisionAuditEvents = orderedAuditEvents.filter(isDecisionAuditEvent);
  const systemAuditEvents = orderedAuditEvents.filter(
    (event) => !isDecisionAuditEvent(event),
  );
  const visibleSystemAuditEvents = systemAuditEvents.slice(0, 8);
  const hiddenSystemAuditEventCount =
    systemAuditEvents.length - visibleSystemAuditEvents.length;
  const visibleAuditEvents = [
    ...decisionAuditEvents,
    ...visibleSystemAuditEvents,
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
      <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
        <h2 className="font-bold">History & Audit</h2>
        <p className="mt-2 text-xs font-semibold uppercase text-slate-500">
          Responder Actions
        </p>
        <div className="mt-4 space-y-3">
          {actions.length === 0 && (
            <p className="text-sm text-slate-400">No responder action recorded yet.</p>
          )}
          {orderedActions.map((action, index) => {
            const rawSnapshot = action.recommendationSnapshot;
            const snapshot = canViewSensitive
              ? rawSnapshot
              : redactRecommendationForPublic(rawSnapshot, incident);
            const redacted = isSensitiveAssetType(rawSnapshot.assetType) && !canViewSensitive;
            const highlighted = action.id === highlightedActionId;
            return (
              <div
                key={`${action.id}-${action.createdAt}-${index}`}
                className={`rounded-md border bg-slate-900 p-3 ${
                  highlighted ? "border-emerald-300 shadow-[0_0_0_1px_rgba(110,231,183,0.35)]" : "border-slate-700"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{actionLabels[action.action]}</p>
                    <p className="mt-1 text-sm text-slate-200">{snapshot.assetName}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-xs font-bold ${riskTextClass(snapshot.riskLevel)}`}>
                      {snapshot.riskLevel}
                    </p>
                    <p className="font-mono text-xs text-slate-300">Score {snapshot.score100}</p>
                  </div>
                </div>
                {action.modifiedPriority && (
                  <p className="mt-2 text-xs text-sky-200">
                    Modified priority: {action.modifiedPriority}
                  </p>
                )}
                <p className="mt-2 text-sm text-slate-300">
                  {redacted
                    ? "Responder note is available to signed-in response users."
                    : action.note || "No note recorded."}
                </p>
                <p className="mt-3 text-xs font-semibold uppercase text-slate-500">
                  Recommendation snapshot
                </p>
                <RecommendationSnapshotClarity recommendation={snapshot} />
                <div className="mt-3 grid gap-1 border-t border-slate-700 pt-3 text-xs text-slate-400">
                  <span>Actor: {action.actorName}</span>
                  <span>Recommendation: {action.recommendationId}</span>
                  <span>{formatAuditTimestamp(action.createdAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
        <h2 className="font-bold">Audit Trail</h2>
        {auditEventsStatus === "unavailable" && (
          <div
            className="mt-3 rounded-md border border-amber-400/40 bg-amber-950/40 p-3 text-sm text-amber-100"
            role="alert"
          >
            <p>
              Audit Trail is temporarily unavailable. Persisted records could not be read.
            </p>
            <button
              type="button"
              className="mt-3 rounded-md border border-amber-300/60 px-3 py-1.5 text-xs font-semibold text-amber-50 hover:bg-amber-400/10"
              onClick={onRetryAuditTrail}
            >
              Retry audit trail
            </button>
          </div>
        )}
        {auditEvents.length > 0 && (
          <p className="mt-2 text-xs text-slate-400">
            Recent history preview, not the complete audit ledger. Same-organization commanders and analysts can sign in to browse complete retained history.{" "}
            {hiddenSystemAuditEventCount > 0 &&
              `${hiddenSystemAuditEventCount} older system event${
                hiddenSystemAuditEventCount === 1 ? "" : "s"
              } remain in append-only audit storage.`}
          </p>
        )}
        <div className="mt-4 space-y-3">
          {auditEvents.length === 0 && auditEventsStatus !== "unavailable" && (
            <p className="text-sm text-slate-400">No audit event recorded yet.</p>
          )}
          {visibleAuditEvents.map((event, index) => {
            const rawSnapshot = recommendationSnapshotFromPayload(event.payload);
            const snapshot =
              rawSnapshot && !canViewSensitive
                ? redactRecommendationForPublic(rawSnapshot, incident)
                : rawSnapshot;
            const redacted = Boolean(
              rawSnapshot &&
                isSensitiveAssetType(rawSnapshot.assetType) &&
                !canViewSensitive,
            );
            const highlighted = event.id === highlightedAuditEventId;
            return (
              <div
                key={`${event.id}-${event.createdAt}-${index}`}
                className={`rounded-md border bg-slate-900 p-3 ${
                  highlighted ? "border-emerald-300 shadow-[0_0_0_1px_rgba(110,231,183,0.35)]" : "border-slate-700"
                }`}
              >
                <div className="flex items-center gap-2">
                  <FileText size={16} className="text-sky-300" />
                  <p className="text-sm font-semibold">{eventTypeLabel(event.eventType)}</p>
                </div>
                <p className="mt-2 text-sm text-slate-300">
                  {redacted
                    ? "Audit event recorded for critical facility response context."
                    : event.summary}
                </p>
                {snapshot && (
                  <>
                    <p className="mt-3 text-xs font-semibold uppercase text-slate-500">
                      Recommendation snapshot
                    </p>
                    <RecommendationSnapshotClarity recommendation={snapshot} />
                  </>
                )}
                <div className="mt-3 grid gap-1 border-t border-slate-700 pt-3 text-xs text-slate-400">
                  <span>Actor: {event.actorName}</span>
                  <span>Recommendation: {event.recommendationId ?? snapshot?.id ?? "Not linked"}</span>
                  <span>{formatAuditTimestamp(event.createdAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function isDecisionAuditEvent(event: AuditEvent) {
  return [
    "RecommendationAccepted",
    "RecommendationModified",
    "RecommendationRejected",
    "RecommendationAnnotated",
  ].includes(event.eventType);
}

function RecommendationSnapshotClarity({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  const clarity = buildRecommendationClarity(recommendation);
  const asset = clarity.find((item) => item.key === "asset");
  const why = clarity.find((item) => item.key === "why");
  const action = clarity.find((item) => item.key === "action");
  const statusItems = clarity.filter((item) =>
    ["change", "freshness", "confidence"].includes(item.key),
  );
  const evidenceSummaries = buildEvidenceSummaries(recommendation, 3);

  return (
    <div className="mt-3 rounded-md border border-slate-700 bg-slate-950/80 p-3 text-xs text-slate-300">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="uppercase text-slate-500">{asset?.label}</p>
          <p className="mt-1 font-semibold text-slate-100">{asset?.value}</p>
          <p className="mt-1 text-slate-400">{asset?.detail}</p>
        </div>
        <div className="text-right">
          <p className={riskTextClass(recommendation.riskLevel)}>
            {recommendation.riskLevel} / {recommendation.riskLevel === "Unknown" ? "Evidence review required" : `Screening score ${recommendation.score100}`}
          </p>
        </div>
      </div>
      <div className="mt-3">
        <p className="uppercase text-slate-500">{action?.label}</p>
        <p className="mt-1 text-slate-200">{action?.value}</p>
      </div>
      <div className="mt-3">
        <p className="uppercase text-slate-500">{why?.label}</p>
        <p className="mt-1 text-slate-300">{why?.value}</p>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {statusItems.map((item) => (
          <div key={item.key}>
            <p className="uppercase text-slate-500">{item.label}</p>
            <p className="mt-1 text-slate-200">{item.value}</p>
            {item.detail && <p className="mt-1 text-slate-500">{item.detail}</p>}
          </div>
        ))}
      </div>
      {recommendation.limitations.length > 0 && (
        <p className="mt-3 text-amber-100">
          <span className="font-semibold">Known limits: </span>
          {recommendation.limitations.slice(0, 2).join(" ")}
        </p>
      )}
      <div className="mt-3">
        <p className="uppercase text-slate-500">Source evidence</p>
        <p className="mt-1 text-slate-300">
          {evidenceSummaries.join(" ") || "No source evidence captured."}
        </p>
      </div>
    </div>
  );
}

function formatAuditTimestamp(value: string) {
  if (!value) return "Timestamp not available";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function eventTypeLabel(eventType: AuditEvent["eventType"]) {
  return eventType.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function recommendationSnapshotFromPayload(
  payload: AuditEvent["payload"],
): Recommendation | null {
  const snapshot = payload.recommendationSnapshot;
  if (!isRecord(snapshot)) return null;
  if (
    typeof snapshot.id !== "string" ||
    typeof snapshot.assetName !== "string" ||
    typeof snapshot.riskLevel !== "string" ||
    typeof snapshot.score100 !== "number"
  ) {
    return null;
  }
  return snapshot as Recommendation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function SettingsView({
  incident,
  canWrite,
  currentUser,
  systemHealth,
  systemHealthLoading,
  systemHealthError,
  onRetrySystemHealth,
  coverageMatrix,
}: {
  incident: Incident;
  canWrite: boolean;
  currentUser: CurrentUser | null;
  systemHealth: OperationalHealthReport | null;
  systemHealthLoading: boolean;
  systemHealthError: string | null;
  onRetrySystemHealth: () => void;
  coverageMatrix: SourceCoverageItem[];
}) {
  const groupedCoverage = groupCoverageByCategory(coverageMatrix);

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <SystemHealthPanel
        health={systemHealth}
        loading={systemHealthLoading}
        error={systemHealthError}
        onRetry={onRetrySystemHealth}
      />
      <ProductPromisePanel health={systemHealth} loading={systemHealthLoading} />
      <section className="min-w-0 rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4 xl:col-span-2">
        <div className="flex items-center gap-2">
          <Database size={18} className="text-sky-300" />
          <h2 className="font-bold">Data Source Coverage</h2>
        </div>
        <p className="mt-3 text-sm text-slate-300">
          Planned inputs are tracked as live, partial/proxy, delayed, not
          available, or upload-required. Missing feeds remain visible and lower
          confidence instead of being replaced with invented values.
        </p>
        <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
          {groupedCoverage.map(([category, items]) => (
            <div key={category} className="min-w-0 rounded-md border border-slate-700 bg-slate-950/70 p-3">
              <p className="text-xs font-semibold uppercase text-slate-400">{category}</p>
              <div className="mt-3 space-y-3">
                {items.map((item) => (
                  <div key={`${category}-${item.item}`} className="min-w-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 text-sm font-semibold text-slate-100 [overflow-wrap:anywhere]">{item.item}</p>
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold ${coverageBadgeClass(item.status)}`}>
                        {item.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400 [overflow-wrap:anywhere]">{item.evidence}</p>
                    <p className="mt-1 text-xs text-slate-500 [overflow-wrap:anywhere]">{item.nextAction}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-emerald-300" />
          <h2 className="font-bold">Supabase Auth & RLS</h2>
        </div>
        <p className="mt-3 text-sm text-slate-300">
          Responder actions, asset imports, incident creation, and manual refreshes require
          a Supabase session plus organization membership. Audit rows preserve the
          authenticated actor id.
        </p>
        <p className="mt-4 rounded-md border border-slate-700 bg-slate-900 p-3 text-sm text-slate-300">
          {canWrite
            ? `${currentUser?.email} (${currentUser?.role}) - operational write access`
            : currentUser
              ? `${currentUser.email} (${currentUser.role ?? "no organization role"}) - read-only; commander or analyst membership required`
              : "Read-only session. Sign in with commander or analyst organization membership to write operational records."}
        </p>
      </section>
      <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers size={18} className="text-sky-300" />
            <h2 className="font-bold">Live Integration Posture</h2>
          </div>
          <a
            href={`/api/export/geojson?incidentId=${encodeURIComponent(incident.id)}`}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-sky-400/40 px-3 text-sm font-semibold text-sky-100 hover:bg-sky-400/10"
          >
            <FileText size={16} />
            Export GeoJSON
          </a>
        </div>
        <ul className="mt-3 space-y-2 text-sm text-slate-300">
          <li>NWS forecast, alerts, and latest observations use live API calls with a User-Agent header.</li>
          <li>WFIGS current/YTD and FIRMS provide real fire context; no-fire is shown when true.</li>
          <li>MTBS currently supplies county boundary context only, not measured burn severity. Selected-fire-linked severity integration remains unavailable.</li>
          <li>TIGERweb, USGS 3DHP, EPQS, NBI, and TNM Structures provide source-backed screening candidates.</li>
          <li>County culverts, evacuation routes, and public works inventories are upload-required where public coverage is unavailable.</li>
        </ul>
      </section>
    </div>
  );
}

function ProductPromisePanel({
  health,
  loading,
}: {
  health: OperationalHealthReport | null;
  loading: boolean;
}) {
  const gates = health?.productPromise ?? [];

  return (
    <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4 xl:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-emerald-300" />
          <h2 className="font-bold">Product Promise Check</h2>
        </div>
        <span className="rounded-md bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300">
          {loading ? "Checking" : `${gates.filter((gate) => gate.status === "pass").length} / ${gates.length || 6} passing`}
        </span>
      </div>
      <p className="mt-3 text-sm text-slate-300">
        Verifies that FireAfter is showing a responder workflow, not just raw
        layers: integrated sources, geospatial context, basin-to-asset linkage,
        explainable ranked actions, responsible language, and audit evidence.
      </p>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {gates.length === 0 && (
          <p className="rounded-md border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-400 lg:col-span-3">
            Product promise checks will appear after readiness is loaded.
          </p>
        )}
        {gates.map((gate) => (
          <div key={gate.id} className="rounded-md border border-slate-700 bg-slate-950/70 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-sm font-semibold text-slate-100">{gate.label}</p>
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${promiseStatusClass(gate.status)}`}>
                {gate.status === "pass" ? "Pass" : "Gap"}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-300">
              {gate.gaps[0] ?? gate.evidence[0] ?? "No evidence recorded yet."}
            </p>
            <p className="mt-2 text-xs text-slate-500">{gate.nextAction}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SystemHealthPanel({
  health,
  loading,
  error,
  onRetry,
}: {
  health: OperationalHealthReport | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const categories = health ? Object.values(health.categories) : [];
  const deploymentIssues = health
    ? [...health.deployment.blockers, ...health.deployment.actions]
    : [];

  return (
    <section className="rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4 xl:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gauge size={18} className="text-amber-300" />
          <h2 className="font-bold">Operational Health</h2>
        </div>
        <span
          className={`rounded-md px-3 py-1 text-sm font-semibold ${healthStatusClass(
            health?.overallStatus ?? "needs_attention",
          )}`}
        >
          {loading
            ? "Checking"
            : health
              ? `${health.overallScore.toFixed(1)} / 5 ${formatHealthStatus(health.overallStatus)}`
              : error
                ? "Unavailable"
                : "Not checked"}
        </span>
      </div>

      {error && (
        <div
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-100"
          role="alert"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={onRetry}
            className="h-9 rounded-md border border-red-200/50 px-3 text-sm font-semibold text-red-50 hover:bg-red-200/10"
          >
            Retry health check
          </button>
        </div>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-5">
        {categories.map((category) => (
          <div key={category.id} className="rounded-md border border-slate-700 bg-slate-900 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase text-slate-400">
                {category.label.split(",")[0]}
              </p>
              <span className={`rounded px-2 py-0.5 text-xs ${healthStatusClass(category.status)}`}>
                {category.score.toFixed(1)}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-300">
              Target health: {category.operationalTarget.toFixed(1)}
            </p>
            <p className="mt-2 text-xs text-slate-400">
              {category.blockers[0] ?? category.actions[0] ?? category.evidence[0] ?? "Ready."}
            </p>
          </div>
        ))}
      </div>

      {health && (
        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-md border border-slate-700 bg-slate-950 p-3">
            <p className="text-sm font-semibold text-slate-200">Health Notices</p>
            <ul className="mt-2 space-y-1 text-sm text-slate-300">
              {[...deploymentIssues, ...Object.values(health.categories).flatMap((category) => [
                ...category.blockers,
                ...category.actions,
              ])].slice(0, 8).map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
              {Object.values(health.categories).every(
                (category) => category.blockers.length === 0 && category.actions.length === 0,
              ) &&
                deploymentIssues.length === 0 && <li>No blockers detected.</li>}
            </ul>
          </div>
          <div className="rounded-md border border-slate-700 bg-slate-950 p-3">
            <p className="text-sm font-semibold text-slate-200">Operator Checklist</p>
            <ol className="mt-2 space-y-1 text-sm text-slate-300">
              {health.operatorChecklist.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}

function healthStatusClass(status: OperationalHealthStatus) {
  if (status === "operational") return "bg-emerald-500/15 text-emerald-200";
  if (status === "blocked") return "bg-red-500/15 text-red-200";
  return "bg-amber-500/15 text-amber-200";
}

function promiseStatusClass(status: "pass" | "gap") {
  return status === "pass"
    ? "bg-emerald-500/15 text-emerald-200"
    : "bg-amber-500/15 text-amber-200";
}

function groupCoverageByCategory(matrix: SourceCoverageItem[]): [string, SourceCoverageItem[]][] {
  const grouped = new globalThis.Map<string, SourceCoverageItem[]>();
  for (const item of matrix) {
    grouped.set(item.category, [...(grouped.get(item.category) ?? []), item]);
  }
  return [...grouped.entries()];
}

function coverageBadgeClass(status: SourceCoverageStatus) {
  switch (status) {
    case "Live":
      return "bg-emerald-500/15 text-emerald-200";
    case "Partial / Proxy":
      return "bg-sky-500/15 text-sky-200";
    case "Upload Required":
      return "bg-violet-500/15 text-violet-200";
    case "Delayed":
      return "bg-amber-500/15 text-amber-200";
    case "Not Available":
      return "bg-red-500/15 text-red-200";
  }
}

function formatHealthStatus(status: OperationalHealthStatus) {
  return status.replace("_", " ").toUpperCase();
}

function riskBadgeClass(riskLevel: Recommendation["riskLevel"]) {
  switch (riskLevel) {
    case "Unknown":
      return "bg-amber-950 text-amber-200 border border-amber-400";
    case "Very High":
      return "bg-red-600 text-white";
    case "High":
      return "bg-orange-500 text-white";
    case "Medium":
      return "bg-amber-400 text-slate-950";
    case "Low":
      return "bg-emerald-600 text-white";
    case "Very Low":
      return "bg-sky-600 text-white";
  }
}

function riskTextClass(riskLevel: Recommendation["riskLevel"]) {
  switch (riskLevel) {
    case "Unknown":
      return "text-amber-200";
    case "Very High":
      return "text-red-400";
    case "High":
      return "text-orange-300";
    case "Medium":
      return "text-amber-300";
    case "Low":
      return "text-emerald-300";
    case "Very Low":
      return "text-sky-300";
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(parseApiErrorMessage(response.status, message));
  }
  return response.json() as Promise<T>;
}

function filterLocations(
  locations: LocationCandidate[],
  query: string,
): LocationCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return locations;

  const directMatches = locations.filter((location) =>
    `${location.county} ${location.state} ${location.label}`
      .toLowerCase()
      .includes(normalized),
  );
  return directMatches;
}

function projectMapPoint(
  coordinate: [number, number],
  bbox?: [number, number, number, number],
): CSSProperties {
  const point = projectCoordinate(coordinate, bbox);
  return {
    left: `${point.x}%`,
    top: `${point.y}%`,
  };
}

function projectCoordinate(
  [lon, lat]: [number, number],
  bbox?: [number, number, number, number],
) {
  if (!bbox) {
    return { x: 50, y: 50 };
  }
  const [west, south, east, north] = bbox;
  const width = Math.max(0.0001, east - west);
  const height = Math.max(0.0001, north - south);
  return {
    x: clampPercent(((lon - west) / width) * 100),
    y: clampPercent((1 - (lat - south) / height) * 100),
  };
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 50;
  return Math.min(94, Math.max(6, value));
}
