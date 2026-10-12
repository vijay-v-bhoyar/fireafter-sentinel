import {
  createIncidentFromLocation,
  getIncidentBundle as getMemoryIncidentBundle,
  prepareAssetImport,
  recordAction,
  refreshIncident,
  searchLocations as searchFixtureLocations,
} from "./fireafter-store";
import { getCurrentUser, type CurrentUser } from "./auth";
import type { AssetImportOutcome } from "./asset-import-outcome";
import { bundleWrite, BundleWriteError, type BundlePrincipal, type BundlePersistence } from "./bundle-write";
import { redactFirmsProvenance } from "./source-link";
import { evidenceMaxAgeMinutes, MTBS_INTERPRETATION_VERSION, projectBundleFreshness } from "./source-freshness";
import { PWFDF_ANALYSIS_GEOMETRY_FAILURE } from "./pwfdf-geometry";
import { projectPublishedHazards } from "./published-hazard";
import { prepareCountyScope } from "./county-scope";
import { startReadDiagnostics } from "./read-diagnostics";
import type { Asset } from "./types";
import { RefreshOperationError, withRefreshOperation } from "./refresh-operation";
import {
  resolveWfigsFireCandidate,
  runLiveSourceRefresh,
  searchLocationsLive,
} from "./live-sources";
import {
  getIncidentAuthorizationContext,
  getSupabaseIncidentBundle,
  getSupabaseIncidentBundleByDatabaseId,
  persistBundleToSupabase,
  persistImportedAssetsToSupabase,
  recordSupabaseAction,
} from "./fireafter-supabase";
import {
  canViewSensitiveInfrastructure,
  redactSensitiveBundleForPublic,
} from "./sensitive-infrastructure";
import { lookupImportOperation } from "./import-operation-server";
import { readImportReceipt, type ImportReceipt } from "./import-operation";
import type {
  AuditEvent,
  Incident,
  Recommendation,
  ResponderAction,
  ResponderActionType,
  RiskLevel,
  SourceSnapshot,
} from "./types";

type DashboardDataBundle = ReturnType<typeof getMemoryIncidentBundle> & {
  persistence?: BundlePersistence;
};

type DashboardBundle = DashboardDataBundle & {
  currentUser: CurrentUser | null;
  sensitiveInfrastructureAccess: boolean;
  dataAvailability?: "unavailable";
};

type PersistableDashboardBundle = {
  incident: Incident;
  sourceSnapshots: SourceSnapshot[];
  recommendations: Recommendation[];
  assets: DashboardBundle["assets"];
  actions: ResponderAction[];
  auditEvents: AuditEvent[];
};

export async function getDashboardBundle(incidentId?: string): Promise<DashboardBundle> {
  const timing = startReadDiagnostics("dashboard_read");
  let persisted;
  try {
    persisted = await safeSupabase(() => getSupabaseIncidentBundle(incidentId, { sourceCache: true }));
    timing.mark("database");
    if (persisted) {
      const scoped = filterBundleToIncidentBounds(persisted);
      timing.mark("county_scope");
      return withCurrentUser(scoped).then(result => {
        timing.mark("projection"); timing.finish();
        return result;
      });
    }
  } catch (error) {
    console.warn("[fireafter] public dashboard persistence unavailable", {
      errorName: error instanceof Error ? error.name : "SupabaseReadFailure",
    });
    return unavailableDashboardBundle(incidentId);
  }
  if (shouldUseFixtureFallback()) {
    const fallback = getMemoryIncidentBundle(incidentId);
    return withCurrentUser(filterBundleToIncidentBounds(fallback));
  }

  return unavailableDashboardBundle(incidentId);
}

export async function getClientDashboardBundle(incidentId?: string): Promise<DashboardBundle> {
  return toClientDashboardBundle(await getDashboardBundle(incidentId));
}

export function toClientDashboardBundle<T extends { sourceSnapshots: SourceSnapshot[] }>(
  bundle: T,
): T {
  const timing = startReadDiagnostics("client_projection");
  const dashboard = bundle as T & { incident?: Incident; assets?: Asset[] };
  const clientBundle = {
    ...bundle,
    durableIngestionEnabled: process.env.FIREAFTER_DURABLE_REFRESH_ENABLED === "true",
    ...(dashboard.incident && Array.isArray(dashboard.assets) ? {
      assets: projectPublishedHazards(dashboard.incident, dashboard.assets, bundle.sourceSnapshots),
    } : {}),
    sourceSnapshots: bundle.sourceSnapshots.map((source) => ({
      ...source,
      rawPayload: compactSourceRawPayload(source.rawPayload),
    })),
  } as T & {
    persistence?: BundlePersistence;
    actions?: ResponderAction[];
    auditEvents?: AuditEvent[];
  };
  delete clientBundle.persistence;
  timing.mark("hazard_and_source_projection");

  const maybeActions = (bundle as { actions?: unknown }).actions;
  if (Array.isArray(maybeActions)) {
    clientBundle.actions = maybeActions.map((action) =>
      compactResponderActionForClient(action as ResponderAction),
    );
  }

  const maybeAuditEvents = (bundle as { auditEvents?: unknown }).auditEvents;
  if (Array.isArray(maybeAuditEvents)) {
    clientBundle.auditEvents = maybeAuditEvents.map((event) =>
      compactAuditEventForClient(event as AuditEvent),
    );
  }

  timing.mark("history");
  const result = redactFirmsProvenance(clientBundle);
  timing.mark("credential_redaction"); timing.finish();
  return result;
}

export function compactSourceRawPayload(
  rawPayload: Record<string, unknown> = {},
) {
  const compact: Record<string, unknown> = {};
  const keptKeys = new Set([
    "analysisGeometryVersion",
    "available",
    "basinCount",
    "configured",
    "coverageStatus",
    "featureCount",
    "freshnessLabel",
    "hotspotCount",
    "reason",
    "rowCount",
    "sensor",
    "source",
    "stationCount",
    "status",
    "warning",
  ]);

  if (rawPayload.failureCode === PWFDF_ANALYSIS_GEOMETRY_FAILURE) {
    compact.failureCode = PWFDF_ANALYSIS_GEOMETRY_FAILURE;
  }
  if (rawPayload.interpretationVersion === MTBS_INTERPRETATION_VERSION) {
    compact.interpretationVersion = MTBS_INTERPRETATION_VERSION;
  }

  for (const [key, value] of Object.entries(rawPayload)) {
    if (keptKeys.has(key) && isCompactPayloadValue(value)) {
      compact[key] = value;
    }
  }

  const features = rawPayload.features;
  if (Array.isArray(features) && typeof compact.featureCount !== "number") {
    compact.featureCount = features.length;
  }

  const basins = rawPayload.basins;
  if (Array.isArray(basins) && typeof compact.basinCount !== "number") {
    compact.basinCount = basins.length;
  }

  const hazardCounts = rawPayload.hazardCounts;
  if (isNumericSummary(hazardCounts)) {
    compact.hazardCounts = hazardCounts;
  }

  const assets = rawPayload.assets;
  if (Array.isArray(assets)) {
    compact.assetCount = assets.length;
  }

  const rows = rawPayload.rows;
  if (Array.isArray(rows) && typeof compact.rowCount !== "number") {
    compact.rowCount = rows.length;
  }

  const droppedHeavyPayload = Object.keys(rawPayload).some(
    (key) => !(key in compact),
  );
  if (droppedHeavyPayload) {
    compact.compacted = true;
    compact.compactionNote =
      "Full raw payload is retained server-side; dashboard responses carry status summaries only.";
  }

  return compact;
}

function isNumericSummary(value: unknown): value is Record<string, number> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item)),
  );
}

function compactResponderActionForClient(
  action: ResponderAction,
): ResponderAction {
  return {
    ...action,
    auditEvent: compactAuditEventForClient(action.auditEvent),
  };
}

function compactAuditEventForClient(event: AuditEvent): AuditEvent {
  return {
    ...event,
    payload: compactAuditPayloadForClient(event.payload),
  };
}

function compactAuditPayloadForClient(payload: Record<string, unknown>) {
  const compact: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (isCompactPayloadValue(value)) {
      compact[key] = value;
    }
  }

  const recommendationSnapshot = payload.recommendationSnapshot;
  if (isRecord(recommendationSnapshot)) {
    compact.recommendationSnapshot = recommendationSnapshot;
  }

  const sourceSnapshotIds = payload.sourceSnapshotIds;
  if (isStringArray(sourceSnapshotIds)) {
    compact.sourceSnapshotIds = sourceSnapshotIds;
  }

  const importErrors = payload.importErrors;
  if (isStringArray(importErrors)) {
    compact.importErrors = importErrors;
  }

  const incident = payload.incident;
  if (isRecord(incident)) {
    compact.incident = pickIncidentAuditSummary(incident);
  }

  addArrayCount(compact, payload, "sourceSnapshots");
  addArrayCount(compact, payload, "assets");
  addArrayCount(compact, payload, "recommendations");

  const droppedPayload = Object.keys(payload).some((key) => !(key in compact));
  if (droppedPayload) {
    compact.compacted = true;
  }

  return compact;
}

export async function createIncidentBundle(locationId: string, principal: BundlePrincipal, signal?: AbortSignal) {
  return withRefreshOperation("create", () => createIncidentBundleWithinOperation(locationId, principal), signal);
}

async function createIncidentBundleWithinOperation(locationId: string, principal: BundlePrincipal) {
  if (principal?.kind !== "user") throw new BundleWriteError("FB401");
  const write = bundleWrite(principal, { organizationId: principal.organizationId, expectedRevision: null }, "create");
  const location = await resolveLocationCandidate(locationId);
  if (!location) {
    throw new Error(`No TIGERweb county match found for ${locationId}`);
  }
  const incident = createIncidentFromLocation(location);
  if (shouldUseFixtureFallback() && process.env.NODE_ENV === "test") {
    return withCurrentUser(filterBundleToIncidentBounds(getMemoryIncidentBundle(incident.id)));
  }
  const existing = await safeSupabase(() => getSupabaseIncidentBundle(incident.id));
  if (existing) return refreshIncidentBundle(incident.id, principal);
  // Production creation starts with this request's inventory, never process-local
  // assets or audit history left behind by another attempt for the same county.
  const refreshed = await runLiveSourceRefresh({
    incident, assets: [], previousRecommendations: [], previousSourceSnapshots: [],
  });
  const createdAt = new Date().toISOString();
  const auditEvent: AuditEvent = {
    id: `audit-create-${crypto.randomUUID()}`, incidentId: incident.id, eventType: "IncidentCreated",
    actorName: "Authenticated responder", createdAt, summary: "Created incident from live county evidence.",
    payload: { actorId: principal.actorId },
  };
  const auditEvents = [auditEvent, buildRefreshAuditEvent(refreshed)];
  const bundle = { ...refreshed, locations: [location], actions: [], auditEvents };
  const persisted = await persistBundleBestEffort(bundle, { write, actions: [], auditEvents });
  return withCurrentUser(filterBundleToIncidentBounds(persisted ?? bundle));
}

async function resolveLocationCandidate(locationId: string) {
  if (shouldUseFixtureFallback()) {
    const fixtureCandidates = searchFixtureLocations(locationId);
    const fixture = fixtureCandidates.find((candidate) => candidate.id === locationId);
    if (fixture) return fixture;
  }
  const candidates = await searchLocationsLive(locationId);
  const exact = candidates.find((candidate) => candidate.id === locationId);
  if (exact) return exact;
  // Never silently substitute a different county: only an unambiguous single
  // candidate may stand in for an inexact location id.
  return candidates.length === 1 ? candidates[0] : null;
}

export async function refreshIncidentBundle(incidentId: string, principal: BundlePrincipal, databaseOnly = false, signal?: AbortSignal) {
  return withRefreshOperation("refresh", () => refreshIncidentBundleWithinOperation(incidentId, principal, databaseOnly), signal);
}

async function refreshIncidentBundleWithinOperation(incidentId: string, principal: BundlePrincipal, databaseOnly: boolean) {
  const persistedBeforeRefresh = await safeSupabase(() =>
    databaseOnly ? getSupabaseIncidentBundleByDatabaseId(incidentId) : getSupabaseIncidentBundle(incidentId),
  );

  if (persistedBeforeRefresh) {
    const write = bundleWrite(principal, persistedBeforeRefresh.persistence, "refresh");
    const refreshed = await runLiveSourceRefresh({
      incident: persistedBeforeRefresh.incident,
      assets: persistedBeforeRefresh.assets,
      previousRecommendations: persistedBeforeRefresh.recommendations,
      previousSourceSnapshots: persistedBeforeRefresh.sourceSnapshots,
    });
    const refreshAuditEvent = buildRefreshAuditEvent(refreshed);
    const bundle = {
      ...persistedBeforeRefresh,
      incident: refreshed.incident,
      assets: refreshed.assets,
      sourceSnapshots: refreshed.sourceSnapshots,
      recommendations: refreshed.recommendations,
      auditEvents: [refreshAuditEvent, ...persistedBeforeRefresh.auditEvents],
    };
    const persisted = await persistBundleBestEffort(bundle, {
      actions: [],
      auditEvents: [refreshAuditEvent],
      write,
    });
    return withCurrentUser(filterBundleToIncidentBounds(persisted ?? bundle));
  }

  if (databaseOnly || !shouldUseFixtureFallback()) {
    throw new Error(`Incident not found in Supabase: ${incidentId}`);
  }

  await refreshIncident(incidentId);
  const refreshed = getMemoryIncidentBundle(incidentId);
  return withCurrentUser(filterBundleToIncidentBounds(refreshed));
}

function buildRefreshAuditEvent(refreshed: Awaited<ReturnType<typeof runLiveSourceRefresh>>): AuditEvent {
  return {
    id: `audit-${refreshed.incident.id}-refresh-${crypto.randomUUID()}`,
    incidentId: refreshed.incident.id,
    eventType: "SourcesRefreshed",
    actorName: "FireAfter",
    createdAt: new Date().toISOString(),
    summary: `Refreshed ${refreshed.sourceSnapshots.length} real source feeds and recalculated ${refreshed.recommendations.length} recommendation${refreshed.recommendations.length === 1 ? "" : "s"}.`,
    payload: {
      sourceSnapshotIds: refreshed.sourceSnapshots.map((source) => source.id),
      recommendationCount: refreshed.recommendations.length,
    },
  };
}

export class FireContextSelectionError extends Error {
  status = 409;

  constructor(message: string) {
    super(message);
    this.name = "FireContextSelectionError";
  }
}

export async function selectIncidentFireBundle(input: Parameters<typeof selectIncidentFireBundleWithinOperation>[0], signal?: AbortSignal) {
  return withRefreshOperation("fire_context", () => selectIncidentFireBundleWithinOperation(input), signal);
}

async function selectIncidentFireBundleWithinOperation(input: {
  incidentId: string;
  sourceKey: "wfigs" | "wfigs-ytd";
  sourceFeatureId: string;
  actorName: string;
  actorId?: string;
  principal: BundlePrincipal;
}) {
  const persisted = await safeSupabase(() =>
    getSupabaseIncidentBundle(input.incidentId),
  );
  const base =
    persisted ??
    (shouldUseFixtureFallback()
      ? getMemoryIncidentBundle(input.incidentId)
      : null);
  if (!base) {
    throw new FireContextSelectionError(
      "Incident persistence is unavailable. Verify the Supabase schema and try again.",
    );
  }
  const write = bundleWrite(input.principal, persisted?.persistence, "fire_context");
  const location = base.incident.locationContext;
  if (!location) {
    throw new FireContextSelectionError(
      "This incident has no validated county boundary, so a fire perimeter cannot be selected.",
    );
  }

  let selectedFire: Incident["selectedFire"];
  try {
    selectedFire = await resolveWfigsFireCandidate(
      location,
      base.incident,
      {
        sourceKey: input.sourceKey,
        sourceFeatureId: input.sourceFeatureId,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "WFIGS validation failed.";
    if (message.includes("no longer published")) {
      throw new FireContextSelectionError(message);
    }
    console.warn("[fireafter] WFIGS fire candidate validation failed", {
      incidentId: input.incidentId,
      sourceKey: input.sourceKey,
      sourceFeatureId: input.sourceFeatureId,
      error: message,
    });
    throw new FireContextSelectionError(
      "The official WFIGS fire source could not validate this candidate. Refresh live sources and try again.",
    );
  }

  const refreshed = await runLiveSourceRefresh({
    incident: {
      ...base.incident,
      selectedFire,
    },
    assets: base.assets,
    fireContextSnapshots: base.sourceSnapshots,
    previousRecommendations: base.recommendations,
    previousSourceSnapshots: base.sourceSnapshots,
  });
  const createdAt = new Date().toISOString();
  const auditEvent: AuditEvent = {
    id: `audit-${base.incident.id}-fire-context-${crypto.randomUUID()}`,
    incidentId: base.incident.id,
    eventType: "FireContextSelected",
    actorName: input.actorName,
    createdAt,
    summary: `${input.actorName} selected ${selectedFire.name} as the incident fire context from ${selectedFire.source}.`,
    payload: {
      actorId: input.actorId,
      sourceKey: selectedFire.sourceKey,
      sourceFeatureId: selectedFire.sourceFeatureId,
      sourceUrl: selectedFire.sourceUrl,
      selectedFire,
      previousFire: base.incident.selectedFire,
    },
  };
  const bundle = {
    ...base,
    incident: refreshed.incident,
    assets: refreshed.assets,
    sourceSnapshots: refreshed.sourceSnapshots,
    recommendations: refreshed.recommendations,
    auditEvents: [auditEvent, ...base.auditEvents],
  };
  const persistedBundle = await persistBundleBestEffort(bundle, {
    actions: [],
    auditEvents: [auditEvent],
    write,
  });
  if (!persistedBundle && !shouldUseFixtureFallback()) {
    throw new Error("Selected fire context could not be persisted to Supabase.");
  }
  console.info("[fireafter] fire context selected", {
    incidentId: input.incidentId,
    actorId: input.actorId,
    sourceKey: selectedFire.sourceKey,
    sourceFeatureId: selectedFire.sourceFeatureId,
  });
  return withCurrentUser(
    filterBundleToIncidentBounds(persistedBundle ?? bundle),
  );
}

export async function recordResponderAction(input: {
  commandId?: string;
  expectedRevision?: string;
  recommendationId: string;
  action: ResponderActionType;
  note: string;
  actorName: string;
  actorId?: string;
  actorOrganizationId?: string;
  modifiedPriority?: RiskLevel;
}) {
  const persistedAction = await safeSupabase(() => recordSupabaseAction(input));
  if (persistedAction) return persistedAction;

  if (!shouldUseFixtureFallback()) {
    throw new Error("Unable to record responder action in Supabase.");
  }

  const action = recordAction(input);
  const bundle = getMemoryIncidentBundle(action.recommendationSnapshot.incidentId);
  await persistBundleBestEffort(bundle);
  return action;
}

type RecoveredImport = { recovered: true; receipt: ImportReceipt; operationId: string;
  assets: never[]; auditEvent: null; importErrors: never[]; bundle: null };
type ConfirmedImport = RecoveredImport | (ReturnType<typeof prepareAssetImport> & {
  operationId: string; bundle: null; importOutcome: AssetImportOutcome;
});

export async function importIncidentAssets(input: Parameters<typeof importIncidentAssetsWithinOperation>[0], signal?: AbortSignal) {
  let confirmed: ConfirmedImport | undefined;
  try {
    return await withRefreshOperation("asset_import", () => importIncidentAssetsWithinOperation(input, result => { confirmed = result; }), signal);
  } catch (error) {
    // A validated receipt is a known fact even when subsequent work exhausts its budget.
    if (error instanceof RefreshOperationError && confirmed) return confirmed;
    throw error;
  }
}

async function importIncidentAssetsWithinOperation(input: {
  operationId: string;
  incidentId: string;
  fileName: string;
  content: string;
  actorName?: string;
  actorOrganizationId?: string;
  principal: BundlePrincipal;
}, checkpoint: (result: ConfirmedImport) => void) {
  const operation = await lookupImportOperation(input);
  if (operation.receipt) {
    const recovered: RecoveredImport = { recovered: true, receipt: operation.receipt, operationId: input.operationId,
      assets: [], auditEvent: null, importErrors: [], bundle: null };
    checkpoint(recovered); return recovered;
  }
  const persisted = await safeSupabase(() =>
    getSupabaseIncidentBundleByDatabaseId(operation.context.databaseIncidentId),
  );

  if (!persisted || persisted.persistence.databaseIncidentId !== operation.context.databaseIncidentId ||
    persisted.persistence.organizationId !== operation.context.organizationId) throw new BundleWriteError("FB409");

  const preparation = { ...persisted.persistence };
  const imported = prepareAssetImport({ ...input, incidentId: persisted.incident.id }, persisted.incident, persisted.assets);
  let refreshedBundle: Awaited<ReturnType<typeof refreshIncidentBundle>> | null = null;

  if (!imported.auditEvent) return { ...imported, operationId: input.operationId, bundle: null, importOutcome: { state: "no_changes", refresh: "not_attempted" } satisfies AssetImportOutcome };
  const importAuditEvent = imported.auditEvent;
  let importOutcome: AssetImportOutcome;

  {
    const saved = await safeSupabase(() =>
      persistImportedAssetsToSupabase({
        importOperation: { operationId: input.operationId, requestHash: operation.requestHash! },
        incidentId: operation.context.databaseIncidentId,
        assets: imported.assets,
        auditEvent: importAuditEvent,
        actorOrganizationId: input.actorOrganizationId,
        principal: input.principal,
        persistence: preparation,
      }),
    );
    if (!saved || saved.auditEvent.id !== importAuditEvent.id) throw new BundleWriteError("FB503");
    const receipt = readImportReceipt(saved.receipt, { operationId: input.operationId, incidentId: operation.context.databaseIncidentId, requestHash: operation.requestHash });
    if (saved.replayed) {
      const recovered: RecoveredImport = { recovered: true, receipt, operationId: input.operationId,
        assets: [], auditEvent: null, importErrors: [], bundle: null };
      checkpoint(recovered); return recovered;
    }
    importOutcome = { state: "persisted", refresh: "unconfirmed", auditEventId: importAuditEvent.id };
    checkpoint({ ...imported, operationId: input.operationId, bundle: null, importOutcome: { ...importOutcome } });
    try {
      refreshedBundle = await refreshIncidentBundle(operation.context.databaseIncidentId, input.principal, true);
      importOutcome.refresh = "completed";
    } catch {
      // The import already committed. A refresh error cannot undo it or prove
      // that a later refresh write did not commit before its response was lost.
      console.warn("[fireafter] imported assets await refresh confirmation", {
        operation: "asset_import_refresh", code: "refresh_unconfirmed", auditEventId: importAuditEvent.id,
      });
    }
  }

  return {
    ...imported,
    operationId: input.operationId,
    bundle: refreshedBundle,
    importOutcome,
  };
}

async function persistBundleBestEffort(
  bundle: PersistableDashboardBundle,
  options: Parameters<typeof persistBundleToSupabase>[1] = {},
) {
  return safeSupabase(() =>
    persistBundleToSupabase(bundle, {
      assets: options.assets ?? bundle.assets,
      actions: options.actions ?? bundle.actions,
      auditEvents: options.auditEvents ?? bundle.auditEvents,
      write: options.write,
    }),
  );
}

async function safeSupabase<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (!shouldUseFixtureFallback()) {
      throw error;
    }
    console.info("[fireafter] Supabase persistence unavailable; using explicit fixture fallback.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

async function unavailableDashboardBundle(incidentId?: string) {
  return withCurrentUser({
    ...createEmptyDashboardBundle(incidentId),
    dataAvailability: "unavailable" as const,
  });
}

export function shouldUseFixtureFallback(
  environment = process.env.NODE_ENV,
  fixtureFlag = process.env.FIREAFTER_ENABLE_FIXTURES,
) {
  return (
    environment === "test" ||
    (environment !== "production" && fixtureFlag === "true")
  );
}

function isCompactPayloadValue(value: unknown) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function addArrayCount(
  compact: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: string,
) {
  const value = payload[key];
  if (Array.isArray(value)) {
    compact[`${key}Count`] = value.length;
  }
}

function pickIncidentAuditSummary(incident: Record<string, unknown>) {
  return {
    id: typeof incident.id === "string" ? incident.id : undefined,
    county: typeof incident.county === "string" ? incident.county : undefined,
    state: typeof incident.state === "string" ? incident.state : undefined,
    title: typeof incident.title === "string" ? incident.title : undefined,
    status: typeof incident.status === "string" ? incident.status : undefined,
  };
}

async function withCurrentUser<T extends object>(bundle: T) {
  const timing = startReadDiagnostics("user_projection");
  bundle = redactFirmsProvenance(bundle);
  timing.mark("credential_redaction");
  if (isDashboardLikeBundle(bundle)) {
    bundle = projectBundleFreshness(bundle, new Date(), evidenceMaxAgeMinutes());
  }
  timing.mark("freshness");
  const currentUser = await getCurrentUser();
  timing.mark("user_lookup");
  const sensitiveInfrastructureAccess = isDashboardLikeBundle(bundle)
    ? await resolveSensitiveInfrastructureAccess(bundle, currentUser)
    : false;
  timing.mark("ownership");
  const responseBundle =
    isDashboardLikeBundle(bundle) && !sensitiveInfrastructureAccess
      ? redactSensitiveBundleForPublic(bundle)
      : bundle;

  const publicBundle = {
    ...responseBundle,
    currentUser,
    sensitiveInfrastructureAccess,
  } as T & { currentUser: typeof currentUser; sensitiveInfrastructureAccess: boolean; persistence?: BundlePersistence };
  delete publicBundle.persistence;
  timing.mark("public_redaction"); timing.finish();
  return publicBundle;
}

async function resolveSensitiveInfrastructureAccess(
  bundle: PersistableDashboardBundle,
  currentUser: Awaited<ReturnType<typeof getCurrentUser>>,
) {
  if (!currentUser?.organizationId) return false;

  try {
    const context = await getIncidentAuthorizationContext(bundle.incident.id);
    return canViewSensitiveInfrastructure(
      currentUser,
      context?.organizationId,
    );
  } catch (error) {
    console.warn(
      "[fireafter] Incident ownership lookup failed; sensitive context remains redacted.",
      error,
    );
    return false;
  }
}

function isDashboardLikeBundle(
  bundle: object,
): bundle is PersistableDashboardBundle {
  return (
    "incident" in bundle &&
    "assets" in bundle &&
    "recommendations" in bundle &&
    "actions" in bundle &&
    "auditEvents" in bundle
  );
}

export function createEmptyDashboardBundle(incidentId?: string): DashboardDataBundle {
  return {
    incident: {
      id: incidentId ?? "no-incident-selected",
      locationId: "unselected",
      county: "No county selected",
      state: "US",
      title: "Search a county to start",
      code: "FA-UNSELECTED",
      status: "Monitoring",
      stormWindow: "No active storm window",
      rainfallForecast: "Not available",
      lastRefresh: "Never",
      dataFreshness: "Low",
      activeAlerts: 0,
      selectedFire: {
        name: "No fire context selected",
        acres: 0,
        perimeterUpdated: "Not available",
        source: "No source selected",
        coverageStatus: "not_available",
      },
      coverageStatus: "not_available",
    },
    locations: [],
    assets: [],
    sourceSnapshots: [],
    recommendations: [],
    actions: [],
    auditEvents: [],
  };
}

function filterBundleToIncidentBounds<T extends PersistableDashboardBundle>(
  bundle: T,
): T {
  const scope = prepareCountyScope(bundle.incident);
  const assets = bundle.assets.filter((asset) =>
    scope.contains(asset.coordinates),
  );
  const assetIds = new Set(assets.map((asset) => asset.id));
  const recommendations = bundle.recommendations.filter(
    (recommendation) =>
      assetIds.has(recommendation.assetId) &&
      scope.contains(recommendation.coordinates),
  );
  const recommendationIds = new Set(
    recommendations.map((recommendation) => recommendation.id),
  );
  const actions = bundle.actions.filter(
    (action) =>
      recommendationIds.has(action.recommendationId) &&
      scope.contains(action.recommendationSnapshot.coordinates),
  );
  const actionAuditEventIds = new Set(actions.map((action) => action.auditEvent.id));
  const auditEvents = bundle.auditEvents.filter((event) => {
    if (!event.recommendationId) return true;
    if (recommendationIds.has(event.recommendationId)) return true;
    if (actionAuditEventIds.has(event.id)) return true;
    return recommendationPayloadInIncidentBounds(scope.contains, event.payload);
  });

  return {
    ...bundle,
    incident: scope.boundary && bundle.incident.locationContext ? {
      ...bundle.incident, locationContext: { ...bundle.incident.locationContext, boundary: scope.boundary },
    } : bundle.incident,
    assets,
    recommendations,
    actions,
    auditEvents,
  };
}

function recommendationPayloadInIncidentBounds(
  contains: ReturnType<typeof prepareCountyScope>["contains"],
  payload: Record<string, unknown>,
) {
  const snapshot = payload.recommendationSnapshot;
  if (!snapshot || typeof snapshot !== "object") return false;
  const coordinates = (snapshot as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
  const [lon, lat] = coordinates.map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  return contains([lon, lat]);
}
