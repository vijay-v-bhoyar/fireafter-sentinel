import { createHash, randomUUID } from "node:crypto";
import {bindNativeRow,NativeAcquisitionSchema} from "./sentinel/native-provenance";
import type { SupabaseClient } from "@supabase/supabase-js";
import { IMPORT_COMMIT_RPC, readImportReceipt, type ImportOperation, type ImportReceipt } from "./import-operation";
import { bundleWrite, bundleWriteFailure, BundleWriteError, validateBundleWrite, type BundleWrite, type BundlePrincipal, type BundlePersistence } from "./bundle-write";
import { packSourcePayload, SOURCE_PAYLOAD_STORAGE_KEYS, unpackSourcePayload } from "./source-payload-storage";
import { packValidatedSourceGeometryPayload } from "./source-spatial-projection";
import { isUploadedAsset, projectUploadedAsset, UPLOAD_CONFIDENCE_REASON, type ImportValidationBudget } from "./asset-import-validation";
import { createResponderAction } from "./audit";
import { ResponderCommandSchema, ResponderCommandError, responderCommandFailure, type ResponderCommand } from "./responder-command";
import { InventoryCapacityError } from "./inventory-error";
import { createInventoryManifest, parseInventoryManifest, selectInventoryRows, type InventoryManifest } from "./inventory-manifest";
import { redactFirmsProvenance } from "./source-link";
import { hasCurrentCrossingGeometry, projectSourceLineGeometry } from "./source-line-geometry";
import { normalizeCountyBoundary, prepareCountyScope } from "./county-scope";
import type { CurrentUser } from "./auth";
import { canWriteOperationalRecords } from "./role-capabilities";
import { ASSET_PAGE_BYTES, AssetInventoryError, AssetInventoryPageSchema, AssetInventoryQuerySchema, type AssetInventoryPage, type AssetInventoryQuery } from "./asset-inventory-contract";
import { startReadDiagnostics } from "./read-diagnostics";
import { readRecentIncidentActions } from "./recent-actions";
import { evidenceMaxAgeMinutes, projectRecommendationFreshness, projectSourceFreshness } from "./source-freshness";
import { compareRecommendations } from "./recommendation-order";
import { REFRESH_RECOMMENDATION_SELECT, previousRecommendation, previousSource, previousTerrain, type PreviousRecommendation, type PreviousSource, type PreviousTerrain } from "./refresh-history";
import { COMPACT_REFRESH_TRANSPORT, COMPACT_REFRESH_SECURITY_VERSION, decodeCompactRefreshPage } from "./compact-refresh-page";
import { createQueueReadIndex, queueReadPageIds, queueReadOrderedIds } from "./queue-read-index";
import { QueuePageError, QueuePageQuerySchema, QueueRecommendationSchema, QUEUE_PAGE_BYTES, validateQueuePage, type QueuePage, type QueuePageQuery } from "./queue-page-contract";
import { dashboardBundleToGeoJson, geoJsonFileName, recommendationsToGeoJson } from "./geojson-export";
import type { GeoJsonExportPage, GeoJsonExportSource } from "./geojson-export-stream";
import { createQueueSourceReadModel, queueSourceProjection, QUEUE_SOURCE_VERSION, QUEUE_SOURCE_SELECT, QueueSourceReadError, readQueueSourceModel, type QueueSourceProjection } from "./queue-source-read-model";
import { SOURCE_VIEW_VERSION } from "./source-viewport-contract";
import { SCORING_VERSION, UNKNOWN_RISK_ACTION } from "./scoring";
import { MAP_VIEW_VERSION } from "./map-viewport-contract";
import { getSupabaseAdminClient, getSupabaseServerClient } from "./supabase";
import { getIncidentBundle as getMemoryIncidentBundle } from "./fireafter-store";
import {
  isNonOperationalAssetRecord,
  isNonOperationalAuditEventRecord,
  isNonOperationalIncidentRecord,
  isNonOperationalRecommendationRecord,
  isNonOperationalResponderActionRecord,
  isNonOperationalSourceSnapshotRecord,
} from "./non-operational-records";
import type {
  Asset,
  AuditEvent,
  AuditTrailStatus,
  Incident,
  Recommendation,
  ResponderAction,
  ResponderActionType,
  RiskLevel,
  SourceSnapshot,
} from "./types";
import {
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC,
  OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
  ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC,
  ATOMIC_RESPONDER_ACTION_SECURITY_RPC,
  ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
  SERVER_OWNED_WRITE_SECURITY_RPC,
  SERVER_OWNED_WRITE_SECURITY_VERSION,
  SERVER_OWNED_READ_SECURITY_RPC,
  SERVER_OWNED_READ_SECURITY_VERSION,
  SCHEDULED_REFRESH_CLAIM_RPC,
  SCHEDULED_REFRESH_SECURITY_PROBE_RPC,
  SCHEDULED_REFRESH_SECURITY_VERSION,
  SCHEDULED_REFRESH_SETTLE_RPC,
} from "./operational-write-security";

const defaultOrganizationName = "FireAfter Operations";

type PersistableBundle = {
  incident: Incident;
  sourceSnapshots: SourceSnapshot[];
  recommendations: Recommendation[];
};

export type PublicationProjectionOptions = {
  assetMapEnabled: boolean;
  // Separately pinned so existing asset-map jobs keep their original source encoding.
  sourceSpatialEnabled?: boolean;
  sourceMapEnabled?: boolean;
  // Paged preparation reuses the parent revision rather than publishing each page.
  revision?: string;
};

type SupabasePayloadOptions = {
  write?: BundleWrite;
  databaseIncidentId?: string;
  assets?: Asset[];
  actions?: ResponderAction[];
  auditEvents?: AuditEvent[];
  publication?: PublicationProjectionOptions;
};

type SchemaCheckClient = {
  from(table: string): {
    select(columns: string): {
      limit(count: number): Promise<{
        data: unknown;
        error: { message?: string } | null;
      }>;
    };
  };
  rpc(functionName: string, args?: Record<string, unknown>): Promise<{
    data: unknown;
    error: { message?: string } | null;
  }>;
};

const realitySchemaProbes = [
  { table: "source_runs", columns: "id" },
  { table: "incidents", columns: "location_context,fire_candidates,coverage_status" },
  { table: "source_snapshots", columns: "source_key,source_url,coverage_status,warnings,derived_signals" },
  { table: "assets", columns: "source_key,geometry_geojson,coverage_status,source_feature_ids" },
  { table: "recommendations", columns: "evidence,metric_status,source_snapshot_ids" },
];

type SupabaseIncidentRow = {
  id: string;
  organization_id: string;
  county: string;
  state: string;
  title: string;
  status: string;
  storm_window: string;
  selected_fire: Record<string, unknown>;
  location_context?: Record<string, unknown> | null;
  fire_candidates?: Record<string, unknown>[] | null;
  coverage_status?: Incident["coverageStatus"] | null;
  last_refresh: string | null;
  created_at?: string;
};

type SupabaseSourceSnapshotRow = {
  id: string;
  incident_id: string;
  source_key?: string | null;
  source_url?: string | null;
  source_name: string;
  fetched_at: string;
  source_updated_at: string | null;
  status: SourceSnapshot["status"];
  stale: boolean;
  freshness_label: string;
  coverage_status?: SourceSnapshot["coverageStatus"] | null;
  warnings?: string[] | null;
  derived_signals?: Record<string, unknown> | null;
  raw_payload: Record<string, unknown>;
};

type SupabaseAssetRow = {
  id: string;
  incident_id: string;
  name: string;
  asset_type: Asset["type"];
  location_label: string;
  source: string;
  source_key?: string | null;
  source_url?: string | null;
  source_feature_id?: string | null;
  source_feature_ids?: string[] | null;
  geometry_geojson?: Record<string, unknown> | null;
  origin?: Asset["origin"] | null;
  coverage_status?: Asset["coverageStatus"] | null;
  confidence_reason?: string | null;
  confidence: Asset["confidence"];
  local_or_uploaded: boolean;
  properties: Record<string, unknown>;
  created_at?: string;
};

type SupabaseRecommendationRow = {
  id: string;
  incident_id: string;
  asset_id: string;
  final_score: number;
  score_100: number;
  risk_level: RiskLevel;
  confidence_level: Recommendation["confidenceLevel"];
  recommended_action: string;
  reason_codes: string[];
  limitations: string[];
  changed_since_last_refresh: string;
  score_breakdown: Record<string, unknown>;
  evidence?: Record<string, unknown>[] | null;
  metric_status?: Record<string, unknown> | null;
  source_snapshot_ids?: string[] | null;
  created_at?: string;
};

type SupabaseResponderActionRow = {
  id: string;
  recommendation_id: string;
  action: ResponderActionType;
  note: string;
  actor_id?: string | null;
  actor_name: string;
  modified_priority?: RiskLevel | null;
  recommendation_snapshot: Recommendation & { domainActionId?: string };
  created_at?: string;
};

type SupabaseAuditEventRow = {
  id: string;
  incident_id: string;
  recommendation_id?: string | null;
  event_type: AuditEvent["eventType"];
  actor_id?: string | null;
  actor_name: string;
  summary: string;
  payload: Record<string, unknown>;
  created_at?: string;
};

type AuditEventsReadResult = {
  rows: SupabaseAuditEventRow[];
  status: AuditTrailStatus;
};

const decisionAuditEventTypes: AuditEvent["eventType"][] = [
  "RecommendationAccepted",
  "RecommendationModified",
  "RecommendationRejected",
  "RecommendationAnnotated",
];

export type FireAfterSupabasePayload = {
  organization: {
    id: string;
    name: string;
  };
  incident: SupabaseIncidentRow;
  sourceSnapshots: SupabaseSourceSnapshotRow[];
  assets: SupabaseAssetRow[];
  recommendations: SupabaseRecommendationRow[];
  responderActions: SupabaseResponderActionRow[];
  auditEvents: SupabaseAuditEventRow[];
};

export type SupabaseBundleRows = {
  incident: SupabaseIncidentRow;
  assets: SupabaseAssetRow[];
  sourceSnapshots: SupabaseSourceSnapshotRow[];
  recommendations: SupabaseRecommendationRow[];
  responderActions: SupabaseResponderActionRow[];
  auditEvents: SupabaseAuditEventRow[];
};

export function getDefaultOrganizationId() {
  return stableUuid("organization:fireafter-operations");
}

export function buildSupabasePayload(
  bundle: PersistableBundle,
  options: SupabasePayloadOptions = {},
): FireAfterSupabasePayload {
  bundle = redactFirmsProvenance(bundle);
  options = redactFirmsProvenance(options);
  const organizationId = options.write?.organizationId ?? getDefaultOrganizationId();
  const incidentId = options.write?.databaseIncidentId ?? options.databaseIncidentId ?? stableUuid(`incident:${bundle.incident.id}`);
  if (!isUuid(incidentId)) throw new BundleWriteError("FB400");
  const rowId = (kind: "asset" | "recommendation" | "source", domainId: string) => {
    const ids = options.write?.rowIds?.[kind];
    const id = ids && Object.hasOwn(ids, domainId) ? ids[domainId] : stableUuid(`${kind}:${domainId}`);
    if (!isUuid(id)) throw new BundleWriteError("FB400");
    return id;
  };
  const incidentAssets =
    options.assets ?? assetsFromRecommendations(bundle.recommendations);
  const assetsById = new Map(incidentAssets.map(asset => [asset.id, asset]));
  const queueKeys = bundle.recommendations.map(recommendation => {
    const asset = assetsById.get(recommendation.assetId);
    return { id: recommendation.id, assetId: recommendation.assetId, assetName: recommendation.assetName,
      score100: recommendation.score100,
      // Match the persisted reader's effective risk, not unverified upload or legacy labels.
      riskLevel: recommendation.scoreBreakdown.scoringVersion === SCORING_VERSION && !(asset && isUploadedAsset(asset))
        ? recommendation.riskLevel : "Unknown" as const };
  }).sort(compareRecommendations);
  const queueIndex = createQueueReadIndex(queueKeys);
  const auditEvents =
    options.auditEvents ??
    getMemoryIncidentBundle(bundle.incident.id).auditEvents.filter(
      (event) => event.incidentId === bundle.incident.id,
    );

  if (auditEvents.some((event) => event.incidentId !== bundle.incident.id && event.incidentId.toLowerCase() !== incidentId.toLowerCase())) {
    throw new BundleWriteError("FB400");
  }

  const payload: FireAfterSupabasePayload = {
    organization: {
      id: organizationId,
      name: defaultOrganizationName,
    },
    incident: {
      id: incidentId,
      organization_id: organizationId,
      county: bundle.incident.county,
      state: bundle.incident.state,
      title: bundle.incident.title,
      status: bundle.incident.status,
      storm_window: bundle.incident.stormWindow,
      last_refresh:
        bundle.sourceSnapshots[0]?.fetchedAt ?? new Date().toISOString(),
      location_context: bundle.incident.locationContext as Record<string, unknown> | undefined,
      fire_candidates: (bundle.incident.fireCandidates ?? []) as Record<string, unknown>[],
      coverage_status: bundle.incident.coverageStatus ?? "not_available",
      selected_fire: {
        ...bundle.incident.selectedFire,
        inventoryManifest: createInventoryManifest({
          assetIds: incidentAssets.map((asset) => rowId("asset", asset.id)),
          recommendationIds: queueKeys.map((recommendation) => rowId("recommendation", recommendation.id)),
          sourceSnapshotIds: bundle.sourceSnapshots.map((snapshot) => rowId("source", snapshot.id)),
          queueIndex,
          sourceQueueVersion: QUEUE_SOURCE_VERSION,
        }),
        domainIncidentId: bundle.incident.id,
        locationId: bundle.incident.locationId,
        code: bundle.incident.code,
        rainfallForecast: bundle.incident.rainfallForecast,
        lastRefreshLabel: bundle.incident.lastRefresh,
        dataFreshness: bundle.incident.dataFreshness,
        activeAlerts: bundle.incident.activeAlerts,
        alertCoverageStatus: bundle.incident.alertCoverageStatus ?? "unavailable",
        locationContext: bundle.incident.locationContext,
      },
    },
    sourceSnapshots: bundle.sourceSnapshots.map((snapshot) => {
      const row = {
      id: rowId("source", snapshot.id),
      incident_id: incidentId,
      source_key: snapshot.sourceKey,
      source_url: snapshot.sourceUrl,
      source_name: snapshot.sourceName,
      fetched_at: snapshot.fetchedAt,
      source_updated_at: timestampOrNull(snapshot.sourceUpdatedAt),
      status: snapshot.status,
      stale: snapshot.stale,
      freshness_label: snapshot.freshnessLabel,
      coverage_status: snapshot.coverageStatus ?? "not_available",
      warnings: snapshot.warnings ?? [],
      derived_signals: snapshot.derivedSignals ?? {},
      raw_payload: {
        domainSourceId: snapshot.id,
        domainIncidentId: snapshot.incidentId,
        sourceKey: snapshot.sourceKey,
        detail: snapshot.detail,
        sourceTimeBasis: snapshot.sourceTimeBasis,
        validUntil: snapshot.validUntil,
        warnings: snapshot.warnings ?? [],
      },
      };
      // Derive the read model from the same decoded, redacted provenance and
      // geometry interpretation as full hydration, never from caller metadata.
      const decoded = redactFirmsProvenance({ ...row, raw_payload: { ...row.raw_payload, rawPayload: snapshot.rawPayload ?? {}, derivedSignals: snapshot.derivedSignals ?? {} } });
      for (const key of SOURCE_PAYLOAD_STORAGE_KEYS) delete (decoded.raw_payload as Record<string, unknown>)[key];
      const source = isNonOperationalSourceSnapshotRecord(decoded) ? null : mapSourceSnapshotRow(decoded);
      const spatialEnabled = options.publication ? options.publication.sourceSpatialEnabled === true : process.env.FIREAFTER_VIEWPORT_MAP_ENABLED === "true";
      const stored = { ...row, raw_payload: { ...row.raw_payload,
        ...((spatialEnabled && packValidatedSourceGeometryPayload(source)) || packSourcePayload(snapshot.rawPayload ?? {})),
        derivedSignals: snapshot.derivedSignals ?? {} } };
      return { ...stored, raw_payload: { ...stored.raw_payload, queueReadModel: createQueueSourceReadModel(stored, source) } };
    }),
    assets: incidentAssets.map((asset) => ({
      id: rowId("asset", asset.id),
      incident_id: incidentId,
      name: asset.name,
      asset_type: asset.type,
      location_label: asset.locationLabel,
      source: asset.source,
      source_key: asset.sourceKey,
      source_url: asset.sourceUrl,
      source_feature_id: asset.sourceFeatureId,
      source_feature_ids: asset.sourceFeatureIds ?? [],
      geometry_geojson: asset.geometry as Record<string, unknown> | undefined,
      origin: asset.origin,
      coverage_status: asset.coverageStatus ?? "not_available",
      confidence_reason: asset.confidenceReason,
      confidence: asset.confidence,
      local_or_uploaded: asset.localOrUploaded,
      properties: {
        domainAssetId: asset.id,
        coordinates: asset.coordinates,
        evidence: asset.evidence ?? [],
        metrics: asset.metrics ?? {},
        road: asset.road,
        stream: asset.stream,
      },
    })),
    recommendations: bundle.recommendations.map((recommendation) => ({
      id: rowId("recommendation", recommendation.id),
      incident_id: incidentId,
      asset_id: rowId("asset", recommendation.assetId),
      final_score: recommendation.finalScore,
      score_100: recommendation.score100,
      risk_level: recommendation.riskLevel,
      confidence_level: recommendation.confidenceLevel,
      recommended_action: recommendation.recommendedAction,
      reason_codes: recommendation.reasonCodes,
      limitations: recommendation.limitations,
      changed_since_last_refresh: recommendation.changedSinceLastRefresh,
      evidence: (recommendation.evidence ?? []) as unknown as Record<string, unknown>[],
      metric_status: recommendation.scoreBreakdown.metricStatus ?? {},
      source_snapshot_ids: recommendation.sourceSnapshotIds ?? [],
      score_breakdown: {
        ...recommendation.scoreBreakdown,
        domainIncidentId: recommendation.incidentId,
        domainRecommendationId: recommendation.id,
        domainAssetId: recommendation.assetId,
        assetName: recommendation.assetName,
        assetType: recommendation.assetType,
        locationLabel: recommendation.locationLabel,
        coordinates: recommendation.coordinates,
        sourcesUpdatedLabel: recommendation.sourcesUpdatedLabel,
        dataFreshnessHours: recommendation.dataFreshnessHours,
        createdAt: recommendation.createdAt,
      },
    })),
    responderActions: (options.actions ?? []).map((action) => ({
      id: stableUuid(`action:${action.id}`),
      recommendation_id: stableUuid(`recommendation:${action.recommendationId}`),
      action: action.action,
      note: action.note,
      actor_id: undefined,
      actor_name: action.actorName,
      modified_priority: action.modifiedPriority,
      recommendation_snapshot: {
        ...action.recommendationSnapshot,
        domainActionId: action.id,
      },
      created_at: action.createdAt,
    })),
    auditEvents: auditEvents.map((event, index) => ({
      id: stableUuid(`audit:${event.id}:${event.createdAt}:${index}`),
      incident_id: incidentId,
      recommendation_id: event.recommendationId
        ? stableUuid(`recommendation:${event.recommendationId}`)
        : null,
      event_type: event.eventType,
      actor_id: undefined,
      actor_name: event.actorName,
      summary: event.summary,
      payload: {
        ...event.payload,
        domainAuditEventId: event.id,
        domainIncidentId: event.incidentId,
        domainRecommendationId: event.recommendationId,
      },
      created_at: event.createdAt,
    })),
  };
  if (options.publication?.revision !== undefined) {
    payload.incident.selected_fire.inventoryManifest = parseInventoryManifest({
      ...payload.incident.selected_fire.inventoryManifest as Record<string, unknown>, revision: options.publication.revision,
    });
  }
  delete payload.incident.selected_fire.mapReadContext;
  if (options.publication?.assetMapEnabled ?? process.env.FIREAFTER_VIEWPORT_MAP_ENABLED === "true") attachAssetMapModels(payload);
  if (options.publication ? options.publication.sourceMapEnabled === true : process.env.FIREAFTER_VIEWPORT_MAP_ENABLED === "true") {
    const revision = parseInventoryManifest(payload.incident.selected_fire.inventoryManifest)!.revision;
    for (const row of payload.sourceSnapshots) row.raw_payload.sourceMapReadModel = {
      version: SOURCE_VIEW_VERSION, revision, projection: queueSourceProjection(row),
    };
  }
  payload.sourceSnapshots=payload.sourceSnapshots.map((row,index)=>bindNativeRow(row,bundle.sourceSnapshots[index],bundle.incident.id,organizationId));
  return payload;
}

// The optional index is derived through the same validation as inventory pages,
// never from client-provided map metadata. Publishing and indexing are atomic.
function attachAssetMapModels(payload: FireAfterSupabasePayload) {
  const incident = payload.incident, revision = parseInventoryManifest(incident.selected_fire.inventoryManifest)!.revision;
  if (isNonOperationalIncidentRecord(incident)) return;
  const scope = prepareCountyScope(mapSupabaseIncidentRow(incident)), budget = { vertices: 0, comparisons: 0 };
  incident.selected_fire.mapReadContext = { version: MAP_VIEW_VERSION, locationContext: incident.location_context ?? null };
  for (const row of payload.assets) {
    let asset: Asset | undefined;
    if (!isNonOperationalAssetRecord(row)) {
      try { asset = mapAssetRow(row, incident, budget); }
      catch (error) { if (!(error instanceof InventoryCapacityError) || error.code !== "uploaded_geometry_invalid") throw error; }
    }
    const available = Boolean(asset && row.name.length <= 512 && row.asset_type.length <= 64 && scope.contains(asset.coordinates));
    row.properties.mapReadModel = { version: MAP_VIEW_VERSION, revision, available };
  }
}

export function mapSupabaseRowsToBundle(rows: SupabaseBundleRows) {
  const timing = startReadDiagnostics("bundle_mapping");
  const selectedFire = rows.incident.selected_fire ?? {};
  const inventory = parseInventoryManifest(selectedFire.inventoryManifest);
  const currentSourceIds = new Set(inventory
    ? selectInventoryRows(rows.sourceSnapshots, inventory.sourceSnapshotIds, rows.incident.id).map(row => row.id)
    : []);
  const decodeBudget = { remaining: 64 * 1024 * 1024 };
  rows = { ...rows, sourceSnapshots: rows.sourceSnapshots.map(row => {
    // Retain retired identity metadata, not its expanded geometry. Historical
    // payloads must not exhaust the current inventory's decode budget.
    if (!currentSourceIds.has(row.id)) return row;
    const metadata = { ...row.raw_payload };
    for (const key of SOURCE_PAYLOAD_STORAGE_KEYS) delete metadata[key];
    return { ...row, raw_payload: { ...metadata, rawPayload: unpackSourcePayload(row.raw_payload, decodeBudget) } };
  }) };
  timing.mark("decode");
  rows = redactFirmsProvenance(rows);
  timing.mark("credential_redaction");
  // Reuse classification only within this mapping; never cache evidence trust across reads.
  const operationalSources = new Set(rows.sourceSnapshots.filter(row =>
    row.incident_id === rows.incident.id && !isNonOperationalSourceSnapshotRecord(row as Record<string, unknown>)));
  // Identity survives retirement; these maps never restore current membership.
  const rowIds = {
    asset: databaseRowIds(rows.assets.filter((row) => row.incident_id === rows.incident.id && !isNonOperationalAssetRecord(row as Record<string, unknown>))
      .map((row) => [stringValue(row.properties.domainAssetId, row.id), row.id])),
    recommendation: databaseRowIds(rows.recommendations.filter((row) => row.incident_id === rows.incident.id && !isNonOperationalRecommendationRecord(row as Record<string, unknown>))
      .map((row) => [stringValue(row.score_breakdown.domainRecommendationId, row.id), row.id])),
    source: databaseRowIds([...operationalSources]
      .map((row) => [stringValue(row.raw_payload.domainSourceId, row.id), row.id])),
  };
  rows = {
    ...rows,
    assets: inventory ? selectInventoryRows(rows.assets, inventory.assetIds, rows.incident.id)
      : rows.assets.filter((asset) => asset.local_or_uploaded && asset.incident_id === rows.incident.id),
    recommendations: inventory ? selectInventoryRows(rows.recommendations, inventory.recommendationIds, rows.incident.id) : [],
    sourceSnapshots: inventory ? selectInventoryRows(rows.sourceSnapshots, inventory.sourceSnapshotIds, rows.incident.id) : [],
  };
  const currentAssetIds = new Set(rows.assets.map((asset) => asset.id));
  if (rows.recommendations.some((recommendation) => !currentAssetIds.has(recommendation.asset_id))) {
    throw new InventoryCapacityError("read_invalid");
  }
  const locationContext =
    locationCandidateValue(rows.incident.location_context) ??
    locationCandidateValue(selectedFire.locationContext);
  const assetRows = rows.assets.filter(
    (asset) => !isNonOperationalAssetRecord(asset as Record<string, unknown>),
  );
  const responderActionRows = rows.responderActions.filter(
    (action) =>
      !isNonOperationalResponderActionRecord(
        action as Record<string, unknown>,
      ),
  );
  const auditEventRows = rows.auditEvents.filter(
    (event) =>
      !isNonOperationalAuditEventRecord(event as Record<string, unknown>),
  );

  timing.mark("identity");
  const uploadValidationBudget = { vertices: 0, comparisons: 0 };
  const mappedAssets = assetRows
    .map((asset) => [asset.id, mapAssetRow(asset, rows.incident, uploadValidationBudget)] as const)
    .filter((entry): entry is readonly [string, Asset] => Boolean(entry[1]));
  const assets = mappedAssets.map(([, asset]) => asset);
  const assetByDatabaseId = new Map(
    mappedAssets.map(([databaseId, asset]) => [databaseId, asset]),
  );
  const validAssetIds = new Set(assetByDatabaseId.keys());
  const recommendationRows = rows.recommendations.filter(
    (recommendation) =>
      validAssetIds.has(recommendation.asset_id) &&
      !isNonOperationalRecommendationRecord(
        recommendation as Record<string, unknown>,
      ),
  );
  timing.mark("assets");
  const mappedSourceSnapshots = currentSourceSnapshots(
    rows.sourceSnapshots
      .filter(snapshot => operationalSources.has(snapshot))
      .map(mapSourceSnapshotRow),
  );
  timing.mark("sources");
  const auditEvents = compactAuditEvents(
    auditEventRows
      .map(mapAuditEventRow)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );

  const recommendations = recommendationRows
    .map((recommendation) =>
      mapRecommendationRow(
        recommendation,
        assetByDatabaseId.get(recommendation.asset_id),
        rows.incident,
      ),
    )
    .filter((recommendation): recommendation is Recommendation =>
      Boolean(recommendation),
    )
    .map((recommendation) => ({ ...recommendation, inventoryRevision: inventory?.revision }))
    .sort(compareRecommendations);

  const actions = compactResponderActions(
    responderActionRows
      .map((action) => mapResponderActionRow(action, auditEvents))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );

  timing.mark("recommendations");
  const incident = mapSupabaseIncidentRow(rows.incident);
  timing.mark("incident");
  timing.finish({ assets: assets.length, recommendations: recommendations.length, sources: mappedSourceSnapshots.length });
  return {
    incident,
    persistence: {
      organizationId: rows.incident.organization_id, expectedRevision: inventory?.revision ?? null, databaseIncidentId: rows.incident.id,
      rowIds,
    },
    locations: locationContext ? [locationContext] : [],
    assets,
    sourceSnapshots: mappedSourceSnapshots,
    recommendations,
    actions,
    auditEvents,
  };
}

function mapSupabaseIncidentRow(row: SupabaseIncidentRow) {
  const selectedFire = row.selected_fire ?? {};
  const inventory = parseInventoryManifest(selectedFire.inventoryManifest);
  const locationContext = locationCandidateValue(row.location_context) ?? locationCandidateValue(selectedFire.locationContext);
  return {
      id: stringValue(selectedFire.domainIncidentId, row.id),
      recoveryScopeId: row.id,
      locationId: stringValue(selectedFire.locationId, row.id),
      county: row.county,
      state: row.state,
      title: row.title,
      code: stringValue(
        selectedFire.code,
        `${row.state}-FA-${row.id.slice(0, 8)}-001`,
      ),
      status: inventory ? row.status as Incident["status"] : "Stale Data",
      stormWindow: row.storm_window,
      rainfallForecast: inventory ? stringValue(
        selectedFire.rainfallForecast,
        "Not available",
      ) : "Inventory unverified; rainfall unavailable",
      lastRefresh: inventory ? stringValue(
        selectedFire.lastRefreshLabel,
        formatDisplayTime(row.last_refresh),
      ) : "Inventory unverified; authorized refresh required",
      dataFreshness: inventory ? stringValue(
        selectedFire.dataFreshness,
        "Low",
      ) as Incident["dataFreshness"] : "Low",
      activeAlerts: numberValue(selectedFire.activeAlerts, 0),
      alertCoverageStatus: inventory && (selectedFire.alertCoverageStatus === "available" || selectedFire.alertCoverageStatus === "partial")
        ? selectedFire.alertCoverageStatus : "unavailable",
      selectedFire: {
        name: stringValue(selectedFire.name, "Not available"),
        acres: numberValue(selectedFire.acres, 0),
        perimeterUpdated: stringValue(
          selectedFire.perimeterUpdated,
          formatDisplayTime(row.last_refresh),
        ),
        source: stringValue(selectedFire.source, "Persisted context unavailable"),
        sourceKey: optionalString(selectedFire.sourceKey),
        sourceUrl: optionalString(selectedFire.sourceUrl),
        sourceFeatureId: optionalString(selectedFire.sourceFeatureId),
        coverageStatus: optionalString(
          selectedFire.coverageStatus ?? row.coverage_status,
        ) as Incident["selectedFire"]["coverageStatus"],
      },
      locationContext,
      fireCandidates: Array.isArray(row.fire_candidates)
        ? (row.fire_candidates as Incident["fireCandidates"])
        : undefined,
      coverageStatus:
        (row.coverage_status as Incident["coverageStatus"]) ??
        (optionalString(selectedFire.coverageStatus) as Incident["coverageStatus"]),
    } satisfies Incident;
}

export async function persistBundleToSupabase(
  bundle: PersistableBundle,
  options: SupabasePayloadOptions = {},
) {
  const write = validateBundleWrite(options.write);
  if ((options.actions?.length ?? 0) > 0) throw new BundleWriteError("FB400");
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new BundleWriteError("FB503");

  const uploadValidationBudget = { vertices: 0, comparisons: 0 };
  // Validate the final merged inventory before any RPC, using the same budget as reads.
  const validatedAssets = (options.assets ?? assetsFromRecommendations(bundle.recommendations))
    .map((asset) => projectUploadedAsset(asset, bundle.incident, uploadValidationBudget));
  const payload = buildSupabasePayload(bundle, { ...options, write, assets: validatedAssets, actions: [], auditEvents: options.auditEvents ?? [] });
  console.info("[fireafter] bundle persistence payload", {
    operation: write.operation, assets: payload.assets.length, recommendations: payload.recommendations.length,
    sources: payload.sourceSnapshots.map(source => ({ key: source.source_key, bytes: Buffer.byteLength(JSON.stringify(source)) })),
  });
  const auditEvents = payload.auditEvents.map((event) => ({ ...event, actor_id: write.actorId,
    payload: { ...event.payload, actorId: write.actorId, operation: write.operation, expectedRevision: write.expectedRevision } }));
  // The migration-backed RPC is intentionally absent from generated types until
  // the target database has been upgraded, so keep its runtime contract narrow.
  const rpcClient = supabase as unknown as {
    rpc: (
      functionName: string,
      args: {
        p_actor_id: string | null;
        p_expected_revision: string | null;
        p_operation: string;
        p_organization: object;
        p_incident: object;
        p_source_snapshots: object[];
        p_assets: object[];
        p_recommendations: object[];
        p_responder_actions: object[];
        p_audit_events: object[];
        p_operation_id?: string;
        p_request_hash?: string;
      },
    ) => Promise<{ error: unknown; data?: unknown }>;
  };
  try {
    const { error, data } = await rpcClient.rpc(write.importOperation ? IMPORT_COMMIT_RPC : ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC, {
      ...(write.importOperation ? { p_operation_id: write.importOperation.operationId, p_request_hash: write.importOperation.requestHash } : {}),
      p_actor_id: write.actorId, p_expected_revision: write.expectedRevision, p_operation: write.operation,
      p_organization: payload.organization,
      p_incident: payload.incident,
      p_source_snapshots: payload.sourceSnapshots,
      p_assets: payload.assets,
      p_recommendations: payload.recommendations,
      p_responder_actions: payload.responderActions,
      p_audit_events: auditEvents,
    });
    if (error) throw error;
    const importReceipt: ImportReceipt | undefined = write.importOperation
      ? readImportReceipt(data, { ...write.importOperation, incidentId: payload.incident.id }) : undefined;
    const persisted = await loadSupabaseIncidentBundle(supabase, payload.incident.id, true);
    if (!persisted || persisted.persistence.databaseIncidentId !== payload.incident.id ||
      persisted.persistence.organizationId !== payload.incident.organization_id) throw new BundleWriteError("FB503");
    return { ...persisted, ...(importReceipt ? { importReceipt, importReplayed: importReceipt.auditEventId !== auditEvents[0]?.id } : {}) };
  } catch (error) {
    const failure = bundleWriteFailure(error);
    console.warn("[fireafter] bundle commit rejected or unconfirmed", { operation: write.operation, code: failure.code });
    throw failure;
  }
}

export async function getSupabaseIncidentBundle(incidentId?: string, options: { sourceCache?: boolean } = {}) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return null;

  // A missing or excluded default must not substitute an unrelated county.
  const targetId = incidentId ?? process.env.FIREAFTER_DEFAULT_INCIDENT_ID ?? "incident-utah-county-ut";
  if (!targetId.trim() || targetId.length > 256) throw new InventoryCapacityError("read_invalid");
  return loadSupabaseIncidentBundle(supabase, targetId, false, options.sourceCache);
}

export async function getSupabaseIncidentBundleByDatabaseId(databaseIncidentId: string) {
  if (!isUuid(databaseIncidentId)) throw new BundleWriteError("FB400");
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new BundleWriteError("FB503");
  return loadSupabaseIncidentBundle(supabase, databaseIncidentId, true);
}

export async function getSupabaseAssetInventoryPage(raw: AssetInventoryQuery, user: CurrentUser): Promise<AssetInventoryPage> {
  const parsed = AssetInventoryQuerySchema.safeParse(raw);
  if (!parsed.success) throw new AssetInventoryError(400, "Invalid asset page. Start again from the first page.");
  if (!canWriteOperationalRecords(user) || !isUuid(user.id) || !user.organizationId || !isUuid(user.organizationId)) {
    throw new AssetInventoryError(403, "Commander or analyst organization membership is required to browse stored assets.");
  }
  const input = parsed.data, start = Number(input.start), limit = Number(input.limit);
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new AssetInventoryError(503);
  const signal = AbortSignal.timeout(15_000), deadline = performance.now() + 15_000;
  const checkDeadline = () => { if (signal.aborted || performance.now() > deadline) throw new AssetInventoryError(503); };
  const incident = await findIncidentRow(input.incidentId, signal);
  checkDeadline();
  if (!incident || isNonOperationalIncidentRecord(incident as Record<string, unknown>)) throw new AssetInventoryError(404, "Incident not found.");
  if (incident.organization_id !== user.organizationId) throw new AssetInventoryError(403, "Incident access denied.");
  const generation = JSON.stringify(incident), inventory = parseInventoryManifest(incident.selected_fire?.inventoryManifest);
  if (!inventory) throw new AssetInventoryError(409, "Current asset membership is unverified. An authorized refresh is required before browsing it.");
  if (input.revision && input.revision !== inventory.revision) throw new AssetInventoryError(409, "The county inventory changed. Start again from the first page to review the new revision.");
  if (start >= inventory.assetIds.length && start !== 0) throw new AssetInventoryError(400, "This page is outside the stored inventory.");
  const ids = inventory.assetIds.slice(start, start + limit).map(id => id.toLowerCase());
  const rows = new Map<string, SupabaseAssetRow>();
  let bytes = 0;
  while (rows.size < ids.length) {
    checkDeadline();
    const remaining = ids.filter(id => !rows.has(id));
    const { data, error, count } = await supabase.from("assets").select("*", { count: "exact" })
      .eq("incident_id", incident.id).in("id", remaining).order("id", { ascending: true })
      .limit(remaining.length).abortSignal(signal).retry(false);
    checkDeadline();
    if (error) throw error;
    if (count !== remaining.length || !Array.isArray(data) || data.length === 0 || data.length > remaining.length) throw new InventoryCapacityError("read_invalid");
    bytes += Buffer.byteLength(JSON.stringify(data));
    if (bytes > ASSET_PAGE_BYTES) throw new AssetInventoryError(503);
    for (const value of data as SupabaseAssetRow[]) {
      if (!value || typeof value.id !== "string" || !remaining.includes(value.id) || rows.has(value.id) || value.incident_id !== incident.id) throw new InventoryCapacityError("read_invalid");
      rows.set(value.id, value);
    }
  }
  const mappedIncident = mapSupabaseIncidentRow(incident), scope = prepareCountyScope(mappedIncident);
  const uploadBudget = { vertices: 0, comparisons: 0 };
  const items: AssetInventoryPage["items"] = ids.map((id, index) => {
    const row = rows.get(id)!, position = start + index + 1;
    if (isNonOperationalAssetRecord(row as Record<string, unknown>)) return { position, status: "withheld", reason: "non-operational" };
    let asset: Asset | undefined;
    try { asset = mapAssetRow(row, incident, uploadBudget); }
    catch (error) {
      if (!(error instanceof InventoryCapacityError) || error.code !== "uploaded_geometry_invalid") throw error;
    }
    if (!asset) return { position, status: "withheld", reason: "unverified-geometry" };
    if (!scope.contains(asset.coordinates)) return { position, status: "withheld", reason: "outside-county" };
    return { position, status: "available", asset: {
      id: asset.id, name: asset.name, type: asset.type, locationLabel: asset.locationLabel, coordinates: asset.coordinates,
      source: asset.source, confidence: asset.confidence, localOrUploaded: asset.localOrUploaded,
      sourceKey: asset.sourceKey, sourceUrl: asset.sourceUrl, sourceFeatureId: asset.sourceFeatureId,
      sourceFeatureIds: asset.sourceFeatureIds ?? [], confidenceReason: asset.confidenceReason, evidence: asset.evidence ?? [],
    } };
  });
  checkDeadline();
  const after = await findIncidentRow(input.incidentId, signal);
  checkDeadline();
  if (!after || after.id !== incident.id || after.organization_id !== user.organizationId) throw new AssetInventoryError(403, "Incident authority changed. Reload and verify your access.");
  if (JSON.stringify(after) !== generation) throw new AssetInventoryError(409, "The county inventory changed while this page was loading. Start again from the first page.");
  const result = AssetInventoryPageSchema.parse(redactFirmsProvenance({
    incidentId: input.incidentId, canonicalIncidentId: mappedIncident.id, county: incident.county, state: incident.state, title: incident.title,
    publishedAt: incident.last_refresh, revision: inventory.revision, start, limit, totalStoredAssets: inventory.assetIds.length, items,
    nextStart: start + ids.length < inventory.assetIds.length ? start + ids.length : null,
  }));
  if (Buffer.byteLength(JSON.stringify(result)) > ASSET_PAGE_BYTES) throw new AssetInventoryError(503);
  checkDeadline();
  return result;
}

/** Private prerequisite for queue reads; no raw geometry or derived weather claims. */
export async function getSupabaseQueueSourceState(incidentId: string, user: CurrentUser, revision?: string) {
  const result = await loadQueueState(incidentId, user, revision);
  return { databaseIncidentId: result.databaseIncidentId, revision: result.revision, sourceSnapshots: result.sourceSnapshots,
    withheldSourceIds: result.withheldSourceIds, evaluatedAt: result.evaluatedAt };
}

export async function getSupabaseQueuePage(raw: QueuePageQuery, user: CurrentUser) {
  const parsed = QueuePageQuerySchema.safeParse(raw);
  if (!parsed.success) throw new QueuePageError(400, "Invalid queue page query.");
  const result = await loadQueueState(parsed.data.incidentId, user, parsed.data.revision, parsed.data);
  return { page: result.page!, incident: result.incident, sourceSnapshots: result.sourceSnapshots };
}

// Callers own authentication, organization and before/after generation fences.
async function readPublishedSourceModels(supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  incident: SupabaseIncidentRow, inventory: InventoryManifest, signal: AbortSignal, check: () => void) {
  if (inventory.sourceQueueVersion !== QUEUE_SOURCE_VERSION) throw new InventoryCapacityError("read_unverified");
  if (inventory.sourceSnapshotIds.length > 128) throw new InventoryCapacityError("read_budget");
  const ids = inventory.sourceSnapshotIds.map(id => id.toLowerCase()), rows = new Map<string, QueueSourceProjection>();
  let bytes = 0;
  while (rows.size < ids.length) {
    const remaining = ids.filter(id => !rows.has(id)).slice(0, 50);
    check();
    const { data, error, count } = await supabase.from("source_snapshots").select(QUEUE_SOURCE_SELECT, { count: "exact" })
      .eq("incident_id", incident.id).in("id", remaining).order("id", { ascending: true }).limit(remaining.length).abortSignal(signal).retry(false);
    check(); if (error) throw error;
    if (count !== remaining.length || !Array.isArray(data) || !data.length || data.length > remaining.length) throw new InventoryCapacityError("read_invalid");
    bytes += Buffer.byteLength(JSON.stringify(data));
    if (bytes > 4 * 1024 * 1024) throw new InventoryCapacityError("read_budget");
    for (const value of data as unknown as QueueSourceProjection[]) {
      if (!value || !remaining.includes(value.id) || rows.has(value.id) || value.incident_id !== incident.id) throw new InventoryCapacityError("read_invalid");
      rows.set(value.id, value);
    }
  }
  const sources: SourceSnapshot[] = [], withheldSourceIds: string[] = [], identities: [string, string][] = [];
  for (const id of ids) {
    const source = readQueueSourceModel(rows.get(id)!);
    if (source) {
      if (source.incidentId !== stringValue(incident.selected_fire.domainIncidentId, incident.id)) throw new InventoryCapacityError("read_invalid");
      sources.push(source); identities.push([source.id, id]);
    } else withheldSourceIds.push(id);
  }
  databaseRowIds(identities);
  return { sources, withheldSourceIds, bytes };
}

async function loadQueueState(incidentId: string, user: CurrentUser, revision?: string, query?: QueuePageQuery) {
  if (typeof incidentId !== "string" || !incidentId.trim() || incidentId.length > 256 || (revision !== undefined && !isUuid(revision))) throw new InventoryCapacityError("read_invalid");
  if (!canWriteOperationalRecords(user) || !isUuid(user.id) || !user.organizationId || !isUuid(user.organizationId)) throw new QueueSourceReadError(403, "Source access denied");
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new InventoryCapacityError("read_unverified");
  const signal = AbortSignal.timeout(15_000), deadline = performance.now() + 15_000;
  const check = () => { if (signal.aborted || performance.now() > deadline) throw new InventoryCapacityError("read_budget"); };
  const incident = await findIncidentRow(incidentId, signal); check();
  if (!incident || isNonOperationalIncidentRecord(incident as Record<string, unknown>)) throw new QueueSourceReadError(404, "Incident unavailable");
  if (incident.organization_id !== user.organizationId) throw new QueueSourceReadError(403, "Incident access denied");
  const generation = JSON.stringify(incident), inventory = parseInventoryManifest(incident.selected_fire?.inventoryManifest);
  if (query && (!inventory?.queueIndex || inventory.sourceQueueVersion !== QUEUE_SOURCE_VERSION)) {
    throw new QueuePageError(409, "This saved inventory predates paged queue reads. An authorized refresh is required.", "QP_LEGACY");
  }
  if (!inventory || inventory.sourceQueueVersion !== QUEUE_SOURCE_VERSION) throw new InventoryCapacityError("read_unverified");
  if (revision && revision !== inventory.revision) throw new InventoryCapacityError("read_generation");
  const { sources, withheldSourceIds, bytes: sourceBytes } = await readPublishedSourceModels(supabase, incident, inventory, signal, check);
  let bytes = sourceBytes;
  let sourceSnapshots = currentSourceSnapshots(sources).map(source => projectSourceFreshness(source, new Date(), evidenceMaxAgeMinutes()));
  const state = sourceSnapshots.length === 0 || sourceSnapshots.some(source => source.freshness?.state !== "current") ? "expired" : "current";
  if (query?.state && query.state !== state) throw new QueuePageError(409, "Source evidence changed. Start from the first page.");
  let items: QueuePage["items"] = [];
  const domainIncident = mapSupabaseIncidentRow(incident);
  if (query) {
    const pageIds = queueReadPageIds(inventory, { revision: inventory.revision, state, start: Number(query.start), limit: Number(query.limit) });
    const readPageRows = async <T extends { id: string; incident_id: string }>(table: "assets" | "recommendations", requested: string[]): Promise<Map<string, T>> => {
      const result = new Map<string, T>();
      while (result.size < requested.length) {
        const remaining = requested.filter(id => !result.has(id)); check();
        const { data, error, count } = await supabase.from(table).select("*", { count: "exact" })
          .eq("incident_id", incident.id).in("id", remaining).order("id").limit(remaining.length).abortSignal(signal).retry(false);
        check(); if (error) throw error;
        if (count !== remaining.length || !Array.isArray(data) || !data.length || data.length > remaining.length) throw new InventoryCapacityError("read_invalid");
        bytes += Buffer.byteLength(JSON.stringify(data));
        if (bytes > QUEUE_PAGE_BYTES) throw new InventoryCapacityError("read_budget");
        for (const row of data as T[]) {
          if (!row || !remaining.includes(row.id) || result.has(row.id) || row.incident_id !== incident.id) throw new InventoryCapacityError("read_invalid");
          result.set(row.id, row);
        }
      }
      return result;
    };
    const recRows = await readPageRows<SupabaseRecommendationRow>("recommendations", pageIds);
    const assetIds = [...new Set([...recRows.values()].map(row => row.asset_id))];
    const membership = new Set(inventory.assetIds);
    if (assetIds.some(id => !membership.has(id))) throw new InventoryCapacityError("read_invalid");
    const assetRows = await readPageRows<SupabaseAssetRow>("assets", assetIds), scope = prepareCountyScope(domainIncident);
    const uploadBudget = { vertices: 0, comparisons: 0 };
    const assetIdentities = new Map<string, string>(), recommendationIdentities: [string, string][] = [];
    items = pageIds.map((id, offset): QueuePage["items"][number] => {
      const row = recRows.get(id)!, assetRow = assetRows.get(row.asset_id)!, position = Number(query.start) + offset + 1;
      if (isNonOperationalRecommendationRecord(row) || isNonOperationalAssetRecord(assetRow)) return { position, status: "withheld", reason: "non-operational" };
      let asset: Asset | undefined;
      try { asset = mapAssetRow(assetRow, incident, uploadBudget); }
      catch (error) { if (!(error instanceof InventoryCapacityError) || error.code !== "uploaded_geometry_invalid") throw error; }
      const recommendation = asset && mapRecommendationRow(row, asset, incident);
      if (!asset || !recommendation) return { position, status: "withheld", reason: "unverified-geometry" };
      if (!scope.contains(asset.coordinates) || !scope.contains(recommendation.coordinates)) return { position, status: "withheld", reason: "outside-county" };
      assetIdentities.set(assetRow.id, asset.id); recommendationIdentities.push([recommendation.id, row.id]);
      return { position, status: "available", recommendation: { ...recommendation, inventoryRevision: inventory.revision } };
    });
    databaseRowIds([...assetIdentities].map(([rowId, domainId]) => [domainId, rowId])); databaseRowIds(recommendationIdentities);
  }
  const after = await findIncidentRow(incidentId, signal); check();
  if (!after || after.organization_id !== user.organizationId || after.id !== incident.id) throw new QueueSourceReadError(403, "Incident authority changed");
  if (JSON.stringify(after) !== generation) throw new InventoryCapacityError("read_generation");
  const now = new Date();
  sourceSnapshots = currentSourceSnapshots(sources).map(source => projectSourceFreshness(source, now, evidenceMaxAgeMinutes()));
  const finalState = sourceSnapshots.length === 0 || sourceSnapshots.some(source => source.freshness?.state !== "current") ? "expired" : "current";
  if (query && finalState !== state) throw new QueuePageError(409, "Evidence expired while loading. Start from the first page.");
  let page: QueuePage | undefined;
  if (query) {
    const expires = state === "current" ? Math.min(...sourceSnapshots.map(source => Date.parse(source.freshness!.expiresAt!))) : null;
    page = validateQueuePage(redactFirmsProvenance({ incidentId, canonicalIncidentId: domainIncident.id, revision: inventory.revision,
      state, evaluatedAt: now.toISOString(), expiresAt: expires === null ? null : new Date(expires).toISOString(),
      start: Number(query.start), limit: Number(query.limit), totalStored: inventory.recommendationIds.length,
      nextStart: Number(query.start) + items.length < inventory.recommendationIds.length ? Number(query.start) + items.length : null,
      items: items.map(item => item.status === "available" ? { ...item, recommendation: projectRecommendationFreshness([item.recommendation], sourceSnapshots, now)[0] } : item),
    }), query);
    if (Buffer.byteLength(JSON.stringify(page)) > QUEUE_PAGE_BYTES) throw new InventoryCapacityError("read_budget");
  }
  check();
  return { databaseIncidentId: incident.id, revision: inventory.revision, sourceSnapshots, withheldSourceIds,
    evaluatedAt: now.toISOString(), incident: redactFirmsProvenance(domainIncident), page };
}

/** Same-organization private export. Public/legacy projection remains a separate route path. */
export async function getSupabaseGeoJsonExportSource(incidentId: string, user: CurrentUser,
  revalidate: () => Promise<void>, callerSignal: AbortSignal): Promise<GeoJsonExportSource> {
  if (!canWriteOperationalRecords(user) || !isUuid(user.id) || !user.organizationId || !isUuid(user.organizationId)) throw new QueueSourceReadError(403, "Export access denied");
  if (!incidentId.trim() || incidentId.length > 256) throw new InventoryCapacityError("read_invalid");
  const db = getSupabaseAdminClient();
  if (!db) throw new InventoryCapacityError("read_unverified");
  const totalSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(300_000)]), deadline = performance.now() + 300_000;
  const check = () => { if (totalSignal.aborted || performance.now() >= deadline) throw new InventoryCapacityError("read_budget"); };
  const boundedSignal = (signal = totalSignal) => AbortSignal.any([totalSignal, signal, AbortSignal.timeout(15_000)]);
  const version = "20261008210000";
  const verifySecurity = async (signal: AbortSignal) => {
    check(); const { data, error } = await db.rpc("fireafter_export_read_security_version").abortSignal(signal).retry(false);
    check(); if (error || data !== version) throw new InventoryCapacityError("read_unverified");
  };
  let fingerprint: string | null = null, databaseId: string | undefined;
  const fence = async (includeRow: boolean, signal: AbortSignal): Promise<SupabaseIncidentRow | undefined> => {
    check(); await revalidate(); check();
    await verifySecurity(signal);
    const { data, error } = await (db as unknown as SupabaseClient).rpc("fireafter_export_read_fence", { p_incident_id: databaseId ?? incidentId,
      p_actor_id: user.id, p_organization_id: user.organizationId, p_role: user.role, p_expected: fingerprint, p_include_row: includeRow })
      .abortSignal(signal).retry(false);
    check();
    if (error) {
      if (error.code === "FB403") throw new QueueSourceReadError(403, "Export access denied");
      if (error.code === "FB404") throw new QueueSourceReadError(404, "Incident unavailable");
      if (error.code === "FB409") throw new InventoryCapacityError("read_generation");
      throw error;
    }
    if (!data || data.version !== version || typeof data.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(data.fingerprint) ||
      typeof data.incidentId !== "string" || !isUuid(data.incidentId) || (databaseId && data.incidentId !== databaseId) ||
      (fingerprint && data.fingerprint !== fingerprint) || (!includeRow && data.row !== null)) throw new InventoryCapacityError("read_generation");
    databaseId = data.incidentId; fingerprint = data.fingerprint;
    return includeRow ? data.row as SupabaseIncidentRow : undefined;
  };
  const initialSignal = boundedSignal(), incident = await fence(true, initialSignal);
  if (!incident || incident.id !== databaseId || incident.organization_id !== user.organizationId || isNonOperationalIncidentRecord(incident)) throw new InventoryCapacityError("read_invalid");
  const inventory = parseInventoryManifest(incident.selected_fire?.inventoryManifest);
  if (!inventory?.queueIndex || inventory.sourceQueueVersion !== QUEUE_SOURCE_VERSION) throw new QueuePageError(409, "Legacy saved inventory", "QP_LEGACY");
  const { sources, bytes: sourceBytes } = await readPublishedSourceModels(db, incident, inventory, initialSignal, check);
  const evaluatedAt = new Date(), domainIncident = redactFirmsProvenance(mapSupabaseIncidentRow(incident));
  const snapshotSources = currentSourceSnapshots(sources).map(source => projectSourceFreshness(source, evaluatedAt, evidenceMaxAgeMinutes()));
  const projectedSources = () => currentSourceSnapshots(sources).map(source => projectSourceFreshness(source, new Date(), evidenceMaxAgeMinutes()));
  const evidenceState = () => { const values = projectedSources(); return values.length === 0 || values.some(source => source.freshness?.state !== "current") ? "expired" as const : "current" as const; };
  const state = evidenceState(), orderedIds = queueReadOrderedIds(inventory, state), assetMembership = new Set(inventory.assetIds);
  if (!orderedIds.length) prepareCountyScope(domainIncident);
  const assertState = () => { check(); if (evidenceState() !== state) throw new InventoryCapacityError("read_generation"); };
  await fence(false, initialSignal); assertState();
  const { features: unused, ...metadata } = dashboardBundleToGeoJson({ incident: domainIncident, recommendations: [], sourceSnapshots: redactFirmsProvenance(sources), generatedAt: evaluatedAt.toISOString() });
  void unused;
  let consumed = false, totalBytes = sourceBytes + Buffer.byteLength(JSON.stringify(incident)), identityBytes = 0;
  const sourceGeneration = JSON.stringify(sources);
  const verifyPage = async (signal: AbortSignal) => {
    await fence(false, signal);
    const current = await readPublishedSourceModels(db, incident, inventory, signal, check);
    totalBytes += current.bytes;
    if (totalBytes > 768 * 1024 * 1024) throw new InventoryCapacityError("read_budget");
    if (JSON.stringify(current.sources) !== sourceGeneration) throw new InventoryCapacityError("read_generation");
    assertState();
  };
  const assetIdentities = new Map<string, string>();
  let prior: Recommendation | undefined;
  return { metadata, revision: inventory.revision, state, totalStored: orderedIds.length, fileName: geoJsonFileName(domainIncident),
    pages: async function* (streamSignal) {
      if (consumed) throw new InventoryCapacityError("read_invalid"); consumed = true;
      for (let start = 0; start < orderedIds.length; start += 128) {
        const signal = boundedSignal(streamSignal); assertState();
        const ids = orderedIds.slice(start, start + 128); let pageBytes = 0;
        const read = async <T extends { id: string; incident_id: string }>(table: "assets" | "recommendations", requested: string[]) => {
          const rows = new Map<string, T>();
          while (rows.size < requested.length) {
            check(); const remaining = requested.filter(id => !rows.has(id));
            const { data, error, count } = await db.from(table).select("*", { count: "exact" }).eq("incident_id", incident.id)
              .in("id", remaining).order("id").limit(remaining.length).abortSignal(signal).retry(false);
            check(); if (error) throw error;
            if (count !== remaining.length || !Array.isArray(data) || !data.length || data.length > remaining.length) throw new InventoryCapacityError("read_invalid");
            const size = Buffer.byteLength(JSON.stringify(data)); pageBytes += size; totalBytes += size;
            if (pageBytes > 8 * 1024 * 1024 || totalBytes > 768 * 1024 * 1024) throw new InventoryCapacityError("read_budget");
            for (const row of data as T[]) {
              if (!row || !remaining.includes(row.id) || rows.has(row.id) || row.incident_id !== incident.id) throw new InventoryCapacityError("read_invalid");
              rows.set(row.id, row);
            }
          }
          return rows;
        };
        const recRows = await read<SupabaseRecommendationRow>("recommendations", ids);
        const assetIds = [...new Set([...recRows.values()].map(row => row.asset_id))];
        if (assetIds.some(id => !assetMembership.has(id))) throw new InventoryCapacityError("read_invalid");
        const assetRows = await read<SupabaseAssetRow>("assets", assetIds), uploadBudget = { vertices: 0, comparisons: 0 };
        // Geometry's five-second processing window must not include database or consumer waits.
        const scope = prepareCountyScope(domainIncident);
        const items = ids.map((id, offset): GeoJsonExportPage["items"][number] => {
          const row = recRows.get(id)!, assetRow = assetRows.get(row.asset_id)!, position = start + offset + 1;
          if (isNonOperationalRecommendationRecord(row) || isNonOperationalAssetRecord(assetRow)) return { position, status: "withheld", reason: "non-operational" };
          let asset: Asset | undefined;
          try { asset = mapAssetRow(assetRow, incident, uploadBudget); }
          catch (error) { if (!(error instanceof InventoryCapacityError) || error.code !== "uploaded_geometry_invalid") throw error; }
          const value = asset && mapRecommendationRow(row, asset, incident);
          if (!asset || !value) return { position, status: "withheld", reason: "unverified-geometry" };
          if (!scope.contains(asset.coordinates) || !scope.contains(value.coordinates)) return { position, status: "withheld", reason: "outside-county" };
          const existingAsset = assetIdentities.get(asset.id);
          if (existingAsset && existingAsset !== assetRow.id) throw new InventoryCapacityError("read_invalid");
          if (!existingAsset) {
            databaseRowIds([[asset.id, assetRow.id]]);
            identityBytes += Buffer.byteLength(asset.id) + Buffer.byteLength(assetRow.id);
            if (identityBytes > 16 * 1024 * 1024) throw new InventoryCapacityError("read_budget");
            assetIdentities.set(asset.id, assetRow.id);
          }
          const recommendation = QueueRecommendationSchema.parse(redactFirmsProvenance({
            ...projectRecommendationFreshness([value], snapshotSources, evaluatedAt)[0], inventoryRevision: inventory.revision,
          }));
          if (recommendation.incidentId !== domainIncident.id || (prior && compareRecommendations(prior, recommendation) > 0)) throw new InventoryCapacityError("read_invalid");
          prior = recommendation;
          const feature = recommendationsToGeoJson([recommendation])[0];
          if (!feature) throw new InventoryCapacityError("read_invalid");
          return { position, status: "available", feature };
        });
        await verifyPage(signal);
        yield { revision: inventory.revision, state, start, totalStored: orderedIds.length, items };
      }
    },
    verifyComplete: async signal => { await verifyPage(boundedSignal(signal)); },
  };
}

type CachedSourceRows = { generation: string; expiresAt: number; bytes: number; rows: SupabaseSourceSnapshotRow[] };
const sourceRowCaches = new WeakMap<object, Map<string, CachedSourceRows>>();
const SOURCE_CACHE_TTL_MS = 15_000;
const SOURCE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

function currentSourceRowCache(client: object) {
  let cache = sourceRowCaches.get(client);
  if (!cache) { cache = new Map(); sourceRowCaches.set(client, cache); }
  for (const [key, entry] of cache) if (entry.expiresAt <= performance.now()) cache.delete(key);
  return cache;
}

function rememberSourceRows(cache: Map<string, CachedSourceRows>, key: string, generation: string, rows: SupabaseSourceSnapshotRow[]) {
  cache.delete(key);
  const bytes = Buffer.byteLength(JSON.stringify(rows));
  if (bytes > SOURCE_CACHE_MAX_BYTES / 2) return;
  let retainedBytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [oldKey, entry] of cache) {
    if (cache.size < 4 && retainedBytes + bytes <= SOURCE_CACHE_MAX_BYTES) break;
    cache.delete(oldKey); retainedBytes -= entry.bytes;
  }
  cache.set(key, { generation, bytes, expiresAt: performance.now() + SOURCE_CACHE_TTL_MS, rows: structuredClone(rows) });
}

export type RefreshReadHeader = { row: SupabaseIncidentRow; generation: string; rowTransport?: typeof COMPACT_REFRESH_TRANSPORT };
export type RefreshReadKind = "source" | "asset" | "recommendation";
export type RefreshReadBudget = { vertices: number; comparisons: number; remaining: number };
export type RefreshReadPart = {
  kind: RefreshReadKind; count: number; first?: string; last?: string; identities: [string, string][]; currentIds: string[]; validAssetIds: string[];
  uploads: Asset[]; terrain: PreviousTerrain[]; recommendations: PreviousRecommendation[];
  sources: PreviousSource[]; inventorySources: string[];
};
export type RefreshReadCursor = { after?: string; count: number; total?: number };
export type RefreshReadResult = { incident: Incident; assets: Asset[]; previousTerrain: PreviousTerrain[]; inventorySources: string[];
  recommendations: PreviousRecommendation[]; sourceSnapshots: PreviousSource[]; persistence: BundlePersistence };
const refreshTables = { source: "source_snapshots", asset: "assets", recommendation: "recommendations" } as const;
const rowGeneration = (row: SupabaseIncidentRow) => createHash("sha256").update(JSON.stringify(row)).digest("hex");

async function verifyCompactRefreshSecurity() {
  const db = getSupabaseAdminClient();
  if (!db) throw new BundleWriteError("FB503");
  const { data, error } = await db.rpc("fireafter_refresh_read_security_version").abortSignal(AbortSignal.timeout(5_000)).retry(false);
  if (error || data !== COMPACT_REFRESH_SECURITY_VERSION) throw new BundleWriteError("FB503");
}

export async function getSupabaseRefreshHeader(incidentId: string, organizationId: string, databaseOnly = false): Promise<RefreshReadHeader | null> {
  if (!getSupabaseAdminClient()) throw new BundleWriteError("FB503");
  if (!incidentId.trim() || incidentId.length > 256 || !isUuid(organizationId) || (databaseOnly && !isUuid(incidentId))) {
    throw new BundleWriteError("FB400");
  }
  const signal = AbortSignal.timeout(15_000);
  const row = databaseOnly ? await readIncidentRow(incidentId, signal) : await findIncidentRow(incidentId, signal);
  if (!row || isNonOperationalIncidentRecord(row)) return null;
  if (row.organization_id !== organizationId) throw new BundleWriteError("FB401");
  parseInventoryManifest(row.selected_fire?.inventoryManifest);
  const compact = process.env.FIREAFTER_COMPACT_REFRESH_READS_ENABLED === "true";
  if (compact) await verifyCompactRefreshSecurity();
  return { row, generation: rowGeneration(row), ...(compact ? { rowTransport: COMPACT_REFRESH_TRANSPORT } : {}) };
}

export async function verifySupabaseRefreshHeader(header: RefreshReadHeader) {
  if (!header?.row || header.generation !== rowGeneration(header.row)) throw new InventoryCapacityError("read_invalid");
  if (header.rowTransport !== undefined) {
    if (header.rowTransport !== COMPACT_REFRESH_TRANSPORT) throw new InventoryCapacityError("read_invalid");
    await verifyCompactRefreshSecurity();
  }
  const row = await readIncidentRow(header.row.id, AbortSignal.timeout(15_000));
  if (!row) throw new BundleWriteError("FB404");
  if (row.organization_id !== header.row.organization_id) throw new BundleWriteError("FB401");
  if (rowGeneration(row) !== header.generation || isNonOperationalIncidentRecord(row)) throw new BundleWriteError("FB409");
}

// Called only inside the worker's generation-fenced hydration step. Full rows are
// classified before compaction, including retired identities and nested markers.
export async function readSupabaseRefreshPage(header: RefreshReadHeader, kind: RefreshReadKind, cursor: RefreshReadCursor, budget: RefreshReadBudget, validAssets?: ReadonlySet<string>) {
  const db = getSupabaseAdminClient();
  if (!db) throw new BundleWriteError("FB503");
  const table = refreshTables[kind];
  if (!table || !Number.isSafeInteger(cursor.count) || cursor.count < 0 || cursor.count > 100_000 ||
    (cursor.after !== undefined && !isUuid(cursor.after)) || (kind === "recommendation" && !validAssets)) throw new InventoryCapacityError("read_invalid");
  const limit = kind === "source" ? 1 : 500;
  const signal = AbortSignal.timeout(20_000);
  const deadline = performance.now() + 20_000;
  const checkTime = () => { if (signal.aborted || performance.now() >= deadline) throw new InventoryCapacityError("read_budget"); };
  let data: unknown, count: number | null, bytes: number, expandedBytes: number;
  if (kind === "recommendation" && header.rowTransport === COMPACT_REFRESH_TRANSPORT) {
    const result = await (db as unknown as SupabaseClient).rpc("fireafter_read_refresh_recommendations", {
      p_incident_id: header.row.id, p_organization_id: header.row.organization_id, p_after: cursor.after ?? null, p_limit: limit,
    }).abortSignal(signal).retry(false);
    checkTime();
    if (result.error) throw bundleWriteFailure(result.error);
    ({ data, count, bytes, expandedBytes } = decodeCompactRefreshPage(result.data, header.row.id));
  } else {
    let query = db.from(table).select(kind === "recommendation" ? REFRESH_RECOMMENDATION_SELECT : "*", { count: "exact" })
      .eq("incident_id", header.row.id).order("id", { ascending: true }).limit(limit);
    if (cursor.after) query = query.gt("id", cursor.after);
    const result = await query.abortSignal(signal).retry(false);
    checkTime();
    if (result.error) throw result.error;
    data = result.data; count = result.count;
    bytes = expandedBytes = Buffer.byteLength(JSON.stringify(data));
  }
  checkTime();
  if (!Number.isSafeInteger(count) || count === null || count < 0 || !Array.isArray(data) || data.length > limit ||
    data.length > count || (count > 0 && !data.length)) throw new InventoryCapacityError("read_invalid");
  const total = cursor.total ?? count;
  if (total > 100_000) throw new InventoryCapacityError("read_budget");
  if (count !== total - cursor.count) throw new InventoryCapacityError("read_generation");
  if (expandedBytes > (kind === "source" ? 16 : 8) * 1024 * 1024) throw new InventoryCapacityError("read_budget");
  const inventory = parseInventoryManifest(header.row.selected_fire?.inventoryManifest);
  const expected = new Set((kind === "asset" ? inventory?.assetIds : kind === "source" ? inventory?.sourceSnapshotIds : inventory?.recommendationIds)?.map(id => id.toLowerCase()) ?? []);
  const assetIds = kind === "recommendation" ? new Set(inventory?.assetIds.map(id => id.toLowerCase()) ?? []) : null;
  const part: RefreshReadPart = { kind, count: data.length, identities: [], currentIds: [], validAssetIds: [], uploads: [], terrain: [], recommendations: [], sources: [], inventorySources: [] };
  let after = cursor.after;
  for (const raw of data as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InventoryCapacityError("read_invalid");
    const value = raw as Record<string, unknown>;
    if (typeof value.id !== "string" || !isUuid(value.id) || value.incident_id !== header.row.id ||
      (after !== undefined && value.id <= after)) throw new InventoryCapacityError("read_invalid");
    after = value.id;
    part.first ??= value.id;
    part.last = value.id;
    const current = expected.has(value.id.toLowerCase());
    if (current) part.currentIds.push(value.id);
    if (kind === "asset") {
      const row = redactFirmsProvenance(value) as SupabaseAssetRow;
      if (isNonOperationalAssetRecord(row)) continue;
      part.identities.push([stringValue(row.properties.domainAssetId, row.id), row.id]);
      if (!current && (inventory || !row.local_or_uploaded)) continue;
      const asset = mapAssetRow(row, header.row, budget);
      if (!asset) continue;
      part.validAssetIds.push(row.id);
      if (isUploadedAsset(asset)) part.uploads.push(asset);
      else {
        const terrain = previousTerrain(asset);
        if (terrain) part.terrain.push(terrain);
      }
      if (!asset.localOrUploaded && asset.origin !== "uploaded" &&
        ["fhwa-nbi-bridges", "tnm-structures"].includes(asset.sourceKey ?? "")) part.inventorySources.push(asset.sourceKey!);
    } else if (kind === "recommendation") {
      type JoinedAsset = Pick<SupabaseAssetRow, "id" | "incident_id" | "name" | "asset_type" | "location_label" | "local_or_uploaded" | "origin" | "source_key"> & {
        coordinates: unknown; domainAssetId: unknown; propertySourceKey: unknown;
      };
      const row = redactFirmsProvenance(value) as SupabaseRecommendationRow & { asset: JoinedAsset | null };
      const { asset: related, ...record } = row;
      if (current && (!assetIds!.has(row.asset_id.toLowerCase()) || !related || related.id !== row.asset_id || related.incident_id !== header.row.id)) {
        throw new InventoryCapacityError("read_invalid");
      }
      if (isNonOperationalRecommendationRecord(record)) continue;
      part.identities.push([stringValue(row.score_breakdown.domainRecommendationId, row.id), row.id]);
      if (!current) continue;
      if (!related || !validAssets!.has(row.asset_id.toLowerCase())) continue;
      // Eligibility was established from complete asset rows under this same
      // generation. Read only the fields required for prior rank comparisons.
      const coordinates = coordinateValue(related.coordinates);
      if (!coordinates) throw new InventoryCapacityError("read_invalid");
      const asset = { id: stringValue(related.domainAssetId, related.id), name: related.name, type: related.asset_type,
        locationLabel: related.location_label, coordinates, localOrUploaded: related.local_or_uploaded,
        origin: related.origin ?? (related.local_or_uploaded ? "uploaded" as const : undefined),
        sourceKey: related.source_key ?? optionalString(related.propertySourceKey) };
      const recommendation = mapRecommendationRow(row, asset, header.row);
      if (recommendation) part.recommendations.push(previousRecommendation(recommendation));
    } else {
      let row = value as SupabaseSourceSnapshotRow;
      if (current) {
        const metadata = { ...row.raw_payload };
        for (const key of SOURCE_PAYLOAD_STORAGE_KEYS) delete metadata[key];
        row = { ...row, raw_payload: { ...metadata, rawPayload: unpackSourcePayload(row.raw_payload, budget) } };
      }
      row = redactFirmsProvenance(row);
      if (isNonOperationalSourceSnapshotRecord(row)) continue;
      part.identities.push([stringValue(row.raw_payload.domainSourceId, row.id), row.id]);
      if (current) part.sources.push(previousSource(mapSourceSnapshotRow(row)));
    }
  }
  const next = { after, count: cursor.count + data.length, total };
  if (next.count === total) {
    const final = await db.from(table).select("id", { count: "exact", head: true }).eq("incident_id", header.row.id).abortSignal(signal).retry(false);
    checkTime();
    if (final.error) throw final.error;
    if (final.count !== total) throw new InventoryCapacityError("read_generation");
  }
  checkTime();
  return { part, next, bytes, expandedBytes };
}

export function finishSupabaseRefreshRead(header: RefreshReadHeader, parts: RefreshReadPart[], totals: Record<RefreshReadKind, number>): RefreshReadResult {
  const inventory = parseInventoryManifest(header.row.selected_fire?.inventoryManifest);
  const rowIds = { asset: {} as Record<string, string>, recommendation: {} as Record<string, string>, source: {} as Record<string, string> };
  for (const kind of ["source", "asset", "recommendation"] as const) {
    const selected = parts.filter(part => part.kind === kind);
    let count = 0;
    let last: string | undefined;
    for (const part of selected) {
      if (!Number.isSafeInteger(part.count) || part.count < 0 ||
        (part.count === 0 ? part.first !== undefined || part.last !== undefined :
          !part.first || !part.last || !isUuid(part.first) || !isUuid(part.last) || part.first > part.last || (last !== undefined && part.first <= last))) {
        throw new InventoryCapacityError("read_invalid");
      }
      count += part.count;
      if (part.last) last = part.last;
    }
    if (count !== totals[kind] || count > 100_000) throw new InventoryCapacityError("read_invalid");
    const expected = (kind === "asset" ? inventory?.assetIds : kind === "source" ? inventory?.sourceSnapshotIds : inventory?.recommendationIds) ?? [];
    selectInventoryRows(selected.flatMap(part => part.currentIds).map(id => ({ id, incident_id: header.row.id })), expected, header.row.id);
    rowIds[kind] = databaseRowIds(selected.flatMap(part => part.identities));
  }
  return {
    incident: mapSupabaseIncidentRow(header.row), assets: parts.flatMap(part => part.uploads),
    previousTerrain: parts.flatMap(part => part.terrain), inventorySources: [...new Set(parts.flatMap(part => part.inventorySources))],
    recommendations: parts.flatMap(part => part.recommendations).sort(compareRecommendations),
    sourceSnapshots: parts.flatMap(part => part.sources).sort((a, b) => sourceOrder(a).localeCompare(sourceOrder(b))),
    persistence: { organizationId: header.row.organization_id, expectedRevision: inventory?.revision ?? null,
      databaseIncidentId: header.row.id, rowIds },
  };
}

async function loadSupabaseIncidentBundle(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  incidentId: string,
  databaseOnly = false,
  sourceCache = false,
) {
  const timing = startReadDiagnostics("bundle_read");
  // A per-request timeout is not a total bound when the SDK retries reads.
  const signal = AbortSignal.timeout(30_000), deadline = performance.now() + 30_000;
  const checkDeadline = () => {
    if (signal.aborted || performance.now() >= deadline) throw new InventoryCapacityError("read_budget");
  };
  const incident = databaseOnly ? await readIncidentRow(incidentId, signal) : await findIncidentRow(incidentId, signal);
  checkDeadline();
  if (
    !incident ||
    isNonOperationalIncidentRecord(incident as Record<string, unknown>)
  ) {
    return null;
  }

  timing.mark("incident");
  const generation = JSON.stringify(incident);
  const inventory = parseInventoryManifest(incident.selected_fire?.inventoryManifest);
  // Dashboard-only transfer reuse. Both incident reads still fence the revision;
  // actions, audits, authorization and evidence freshness are never cached here.
  const cache = sourceCache && inventory ? currentSourceRowCache(supabase) : undefined;
  const cacheKey = `${incident.organization_id}:${incident.id}`;
  const cacheGeneration = createHash("sha256").update(generation).digest("hex");
  const cached = cache?.get(cacheKey);
  const cachedRows = cached?.generation === cacheGeneration ? structuredClone(cached.rows) : undefined;

  const [
    sourceSnapshots,
    assets,
    recommendations,
    auditEventsResult,
  ] = await Promise.all([
    cachedRows ?? readRows<SupabaseSourceSnapshotRow>("source_snapshots", incident.id, signal),
    readRows<SupabaseAssetRow>("assets", incident.id, signal),
    readRows<SupabaseRecommendationRow>("recommendations", incident.id, signal),
    readAuditEvents(incident.id, signal),
  ]);
  checkDeadline();

  timing.mark("inventory");
  const responderActions =
    recommendations.length > 0
      ? await readRecentIncidentActions(incident.id, signal)
      : [];
  checkDeadline();

  timing.mark("actions");
  const afterRead = await readIncidentRow(incident.id, signal);
  checkDeadline();
  if (!afterRead || JSON.stringify(afterRead) !== generation) {
    cache?.delete(cacheKey);
    console.warn("[fireafter] inventory generation changed", { operation: "load_bundle" });
    throw new InventoryCapacityError("read_generation");
  }

  timing.mark("revision_fence");
  const bundle = mapSupabaseRowsToBundle({
    incident,
    assets,
    sourceSnapshots,
    recommendations,
    responderActions,
    auditEvents: auditEventsResult.rows,
  });
  checkDeadline();

  timing.mark("mapping");
  if (cache && !cachedRows) rememberSourceRows(cache, cacheKey, cacheGeneration, sourceSnapshots);
  timing.mark("cache_store");
  timing.finish({ sourceCacheHit: Boolean(cachedRows), assets: bundle.assets.length,
    recommendations: bundle.recommendations.length, sources: bundle.sourceSnapshots.length });

  return {
    ...bundle,
    auditEventsStatus: auditEventsResult.status,
  };
}

export async function listSupabaseIncidentIds(limit = 20) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new Error("Scheduled refresh requires configured Supabase service access.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("Scheduled refresh selection limit must be an integer from 1 to 20.");
  }

  // Enumerate immutable keys before ranking: excluded rows and mutable refresh
  // timestamps must not determine which pages are reachable.
  const signal = AbortSignal.timeout(30_000);
  const deadline = performance.now() + 30_000;
  const checkDeadline = () => {
    if (signal.aborted || performance.now() >= deadline) throw new InventoryCapacityError("read_budget");
  };
  const readCount = async () => {
    checkDeadline();
    const { count, error } = await supabase.from("incidents")
      .select("id", { count: "exact", head: true }).abortSignal(signal).retry(false);
    checkDeadline();
    if (error) throw error;
    if (!Number.isSafeInteger(count) || count === null || count < 0) throw new InventoryCapacityError("read_invalid");
    if (count > 10_000) throw new InventoryCapacityError("read_budget");
    return count;
  };
  const expected = await readCount();
  let observed = 0;
  let after = "";
  const selected: { id: string; incidentId: string; refreshedAt: number }[] = [];
  while (observed < expected) {
    checkDeadline();
    let query = supabase.from("incidents").select("id, selected_fire, last_refresh")
      .order("id", { ascending: true }).limit(Math.min(500, expected - observed));
    if (after) query = query.gt("id", after);
    const { data, error } = await query.abortSignal(signal).retry(false);
    checkDeadline();
    if (error) throw error;
    if (!Array.isArray(data) || data.length === 0 || data.length > Math.min(500, expected - observed)) {
      throw new InventoryCapacityError("read_invalid");
    }
    for (const raw of data as unknown[]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InventoryCapacityError("read_invalid");
      const incident = raw as Record<string, unknown>;
      if (typeof incident.id !== "string" || !isUuid(incident.id) || incident.id <= after ||
        (incident.selected_fire !== null && (typeof incident.selected_fire !== "object" || Array.isArray(incident.selected_fire)))) {
        throw new InventoryCapacityError("read_invalid");
      }
      after = incident.id;
      observed++;
      if (isNonOperationalIncidentRecord(incident)) continue;
      const refreshedAt = incident.last_refresh === null ? -Infinity :
        typeof incident.last_refresh === "string" ? Date.parse(incident.last_refresh) : NaN;
      if (Number.isNaN(refreshedAt)) throw new InventoryCapacityError("read_invalid");
      const selectedFire = incident.selected_fire as Record<string, unknown> | null;
      selected.push({ id: incident.id, incidentId: stringValue(selectedFire?.domainIncidentId, incident.id), refreshedAt });
      selected.sort((a, b) => a.refreshedAt - b.refreshedAt || a.id.localeCompare(b.id));
      if (selected.length > limit) selected.pop();
    }
  }
  if (await readCount() !== observed) throw new InventoryCapacityError("read_generation");
  return selected.map(incident => incident.incidentId);
}

export type ScheduledRefreshClaim = {
  databaseIncidentId: string;
  incidentId: string;
  attemptId: string;
  workerId: string;
};

export async function claimSupabaseScheduledRefreshes(
  limit = 20,
  workerId: string = randomUUID(),
  leaseSeconds = 600,
): Promise<ScheduledRefreshClaim[]> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    throw new Error("Scheduled refresh requires configured Supabase service access.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("Scheduled refresh selection limit must be an integer from 1 to 20.");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
    throw new Error("Scheduled refresh worker identity is invalid.");
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 900) {
    throw new Error("Scheduled refresh lease must be an integer from 60 to 900 seconds.");
  }

  const rpcClient = supabase as unknown as {
    rpc: (functionName: string, args: Record<string, unknown>) => Promise<{
      data: unknown;
      error: { message?: string } | null;
    }>;
  };
  const { data, error } = await rpcClient.rpc(SCHEDULED_REFRESH_CLAIM_RPC, {
    p_limit: limit,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  if (!Array.isArray(data)) throw new InventoryCapacityError("read_invalid");

  const seenAttempts = new Set<string>();
  const seenIncidents = new Set<string>();
  return data.map((raw): ScheduledRefreshClaim => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InventoryCapacityError("read_invalid");
    }
    const row = raw as Record<string, unknown>;
    const databaseIncidentId = row.incident_id;
    const incidentId = row.domain_incident_id;
    const attemptId = row.attempt_id;
    if (typeof databaseIncidentId !== "string" || !isUuid(databaseIncidentId) ||
      typeof incidentId !== "string" || incidentId.trim().length === 0 || incidentId.length > 512 ||
      typeof attemptId !== "string" || !isUuid(attemptId) ||
      seenIncidents.has(databaseIncidentId) || seenAttempts.has(attemptId)) {
      throw new InventoryCapacityError("read_invalid");
    }
    seenIncidents.add(databaseIncidentId);
    seenAttempts.add(attemptId);
    return { databaseIncidentId, incidentId, attemptId, workerId };
  });
}

export async function settleSupabaseScheduledRefresh(
  claim: ScheduledRefreshClaim,
  succeeded: boolean,
) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    throw new Error("Scheduled refresh requires configured Supabase service access.");
  }
  if (!isUuid(claim.databaseIncidentId) || !isUuid(claim.attemptId) ||
    typeof claim.incidentId !== "string" || claim.incidentId.trim().length === 0 ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(claim.workerId)) {
    throw new InventoryCapacityError("read_invalid");
  }
  const rpcClient = supabase as unknown as {
    rpc: (functionName: string, args: Record<string, unknown>) => Promise<{
      data: unknown;
      error: { message?: string } | null;
    }>;
  };
  const { error } = await rpcClient.rpc(SCHEDULED_REFRESH_SETTLE_RPC, {
    p_incident_id: claim.databaseIncidentId,
    p_attempt_id: claim.attemptId,
    p_worker_id: claim.workerId,
    p_succeeded: succeeded,
  });
  if (error) throw error;
}

export async function checkSupabaseRealitySchema(
  client: SchemaCheckClient | null = getSupabaseAdminClient() as SchemaCheckClient | null,
) {
  if (!client) {
    return {
      ready: false,
      serverOwnedReadsVersion: null,
      serverOwnedReadsProbeError: "Server-owned operational-read security probe is unavailable.",
      serverOwnedWritesVersion: null,
      serverOwnedWritesProbeError:
        "Server-owned operational-write security probe is unavailable.",
      atomicResponderActionVersion: null,
      atomicResponderActionProbeError:
        "Atomic responder-action persistence security probe is unavailable.",
      atomicBundlePersistenceVersion: null,
      atomicBundlePersistenceProbeError:
        "Atomic bundle persistence security probe is unavailable.",
      operatorAccountIssuanceAuditVersion: null,
      operatorAccountIssuanceAuditProbeError:
        "Operator account issuance audit security probe is unavailable.",
      scheduledRefreshVersion: null,
      scheduledRefreshProbeError:
        "Durable scheduled-refresh lease security probe is unavailable.",
      errors: ["Supabase admin client is not configured."],
    };
  }

  const [
    probeErrors,
    serverOwnedWritesProbe,
    atomicResponderActionProbe,
    atomicBundlePersistenceProbe,
    operatorAccountIssuanceAuditProbe,
    scheduledRefreshProbe,
  ] = await Promise.all([
    Promise.all(
      [...realitySchemaProbes, ...(process.env.FIREAFTER_DURABLE_REFRESH_ENABLED === "true" ? [
        { table: "ingestion_jobs", columns: "id,stage,status,lease_until,dispatch_after" },
        { table: "ingestion_checkpoints", columns: "job_id,key,part" },
        { table: "ingestion_commit_receipts", columns: "job_id,phase,revision" },
      ] : [])].map(async (probe) => {
        try {
          const { error } = await client
            .from(probe.table)
            .select(probe.columns)
            .limit(1);
          return error ? schemaProbeFailureMessage(probe.table) : null;
        } catch {
          return schemaProbeFailureMessage(probe.table);
        }
      }),
    ),
    (async () => {
      try {
        const { data, error } = await client.rpc(SERVER_OWNED_WRITE_SECURITY_RPC);
        return {
          version: error ? null : data === SERVER_OWNED_WRITE_SECURITY_VERSION ? data : null,
          unavailable: Boolean(error),
        };
      } catch {
        return { version: null, unavailable: true };
      }
    })(),
    (async () => {
      try {
        const { data, error } = await client.rpc(
          ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC,
        );
        return {
          version:
            error || data !== ATOMIC_RESPONDER_ACTION_SECURITY_VERSION
              ? null
              : data,
          unavailable: Boolean(error),
        };
      } catch {
        return { version: null, unavailable: true };
      }
    })(),
    (async () => {
      try {
        const { data, error } = await client.rpc(
          ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC,
        );
        return {
          version:
            error || data !== ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION
              ? null
              : data,
          unavailable: Boolean(error),
        };
      } catch {
        return { version: null, unavailable: true };
      }
    })(),
    (async () => {
      try {
        const { data, error } = await client.rpc(
          OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC,
        );
        return {
          version:
            error || data !== OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION
              ? null
              : data,
          unavailable: Boolean(error),
        };
      } catch {
        return { version: null, unavailable: true };
      }
    })(),
    (async () => {
      try {
        const { data, error } = await client.rpc(
          SCHEDULED_REFRESH_SECURITY_PROBE_RPC,
        );
        return {
          version:
            error || data !== SCHEDULED_REFRESH_SECURITY_VERSION
              ? null
              : data,
          unavailable: Boolean(error),
        };
      } catch {
        return { version: null, unavailable: true };
      }
    })(),
  ]);

  const serverOwnedReadsProbe = await (async () => {
    try {
      const { data, error } = await client.rpc(SERVER_OWNED_READ_SECURITY_RPC);
      return { version: error || data !== SERVER_OWNED_READ_SECURITY_VERSION ? null : data,
        unavailable: Boolean(error) };
    } catch {
      return { version: null, unavailable: true };
    }
  })();
  const errors = probeErrors.filter((error): error is string => Boolean(error));
  const serverOwnedWritesVersion = serverOwnedWritesProbe.version;
  const serverOwnedWritesProbeError = serverOwnedWritesProbe.unavailable
    ? "Server-owned operational-write security probe is unavailable."
    : null;
  const atomicResponderActionVersion = atomicResponderActionProbe.version;
  const atomicResponderActionProbeError = atomicResponderActionProbe.unavailable
    ? "Atomic responder-action persistence security probe is unavailable."
    : null;
  const atomicBundlePersistenceVersion = atomicBundlePersistenceProbe.version;
  const atomicBundlePersistenceProbeError = atomicBundlePersistenceProbe.unavailable
    ? "Atomic bundle persistence security probe is unavailable."
    : null;
  const operatorAccountIssuanceAuditVersion =
    operatorAccountIssuanceAuditProbe.version;
  const operatorAccountIssuanceAuditProbeError =
    operatorAccountIssuanceAuditProbe.unavailable
      ? "Operator account issuance audit security probe is unavailable."
      : null;
  const scheduledRefreshVersion = scheduledRefreshProbe.version;
  const scheduledRefreshProbeError = scheduledRefreshProbe.unavailable
    ? "Durable scheduled-refresh lease security probe is unavailable."
    : null;

  return {
    ready: errors.length === 0,
    serverOwnedReadsVersion: serverOwnedReadsProbe.version,
    serverOwnedReadsProbeError: serverOwnedReadsProbe.unavailable
      ? "Server-owned operational-read security probe is unavailable." : null,
    serverOwnedWritesVersion,
    serverOwnedWritesProbeError,
    atomicResponderActionVersion,
    atomicResponderActionProbeError,
    atomicBundlePersistenceVersion,
    atomicBundlePersistenceProbeError,
    operatorAccountIssuanceAuditVersion,
    operatorAccountIssuanceAuditProbeError,
    scheduledRefreshVersion,
    scheduledRefreshProbeError,
    errors,
  };
}

function schemaProbeFailureMessage(table: string) {
  console.warn("[fireafter] schema probe failed", { operation: "schema_probe", table, code: "schema_probe_failed" });
  return `Supabase schema probe for ${table} is unavailable; verify Supabase connectivity and retry.`;
}

export async function ensureDefaultOrganizationMembership(input: {
  userId: string;
  role?: "incident_commander" | "analyst" | "viewer";
}) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return null;

  const organizationId = getDefaultOrganizationId();
  await writeRows("organizations", {
    id: organizationId,
    name: defaultOrganizationName,
  });
  const member = {
    organization_id: organizationId,
    user_id: input.userId,
    role: input.role ?? "incident_commander",
  };
  await writeRows("organization_members", member);
  return member;
}

export async function getDefaultOrganizationMembership(userId: string) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id,user_id,role")
    .eq("organization_id", getDefaultOrganizationId())
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as {
    organization_id: string;
    user_id: string;
    role: "incident_commander" | "analyst" | "viewer";
  } | null;
}

export async function getIncidentAuthorizationContext(incidentId: string) {
  const incident = await findIncidentRow(incidentId);
  if (!incident) return null;
  return {
    databaseIncidentId: incident.id,
    domainIncidentId: stringValue(incident.selected_fire?.domainIncidentId, incident.id),
    organizationId: incident.organization_id,
  };
}

export async function getRecommendationAuthorizationContext(
  recommendationId: string,
) {
  const recommendation = await findRecommendationRow(recommendationId);
  if (!recommendation) return null;
  const incident = await readIncidentRow(recommendation.incident_id);
  if (!incident) return null;
  return {
    databaseIncidentId: incident.id,
    domainIncidentId: stringValue(incident.selected_fire?.domainIncidentId, incident.id),
    organizationId: incident.organization_id,
    databaseRecommendationId: recommendation.id,
    domainRecommendationId: stringValue(
      recommendation.score_breakdown.domainRecommendationId,
      recommendation.id,
    ),
  };
}

export async function recordSupabaseAction(input: {
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
  const supabase = getSupabaseAdminClient();
  if (!supabase) return null;

  const parsed = ResponderCommandSchema.safeParse(input);
  if (!parsed.success) throw new ResponderCommandError("FA422");
  const command = parsed.data;
  if (!input.actorId || !isUuid(input.actorId) || !input.actorOrganizationId || !isUuid(input.actorOrganizationId)) {
    throw new ResponderCommandError("FA401");
  }

  const locatedRecommendation = await findRecommendationRow(input.recommendationId);
  if (!locatedRecommendation) return null;

  const incident = await readIncidentRow(locatedRecommendation.incident_id);
  if (!incident) return null;
  if (incident.organization_id !== input.actorOrganizationId) throw new Error("Incident access denied");

  const rpcClient = supabase as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const commandArgs = {
    p_command_id: command.commandId, p_actor_id: input.actorId,
    p_organization_id: input.actorOrganizationId, p_expected_revision: command.expectedRevision,
    p_request: { recommendationId: locatedRecommendation.id, action: command.action,
      note: command.note, modifiedPriority: command.modifiedPriority ?? null },
  };
  async function invoke(action: object | null, auditEvent: object | null) {
    try {
      const result = await rpcClient.rpc(ATOMIC_RESPONDER_ACTION_SECURITY_RPC, {
        ...commandArgs, p_action: action, p_audit_event: auditEvent,
      });
      if (result.error) throw result.error;
      return result.data;
    } catch (error) { throw responderCommandFailure(error); }
  }
  // Look up the canonical result before reading mutable inventory: replay must
  // still work after a subsequent refresh, subject to current authority.
  const receipt = await invoke(null, null);
  if (receipt !== null) return mapResponderCommandReceipt(receipt, input.actorId, locatedRecommendation.id, command);

  const inventory = parseInventoryManifest(incident.selected_fire?.inventoryManifest);
  if (!inventory || inventory.revision !== command.expectedRevision) throw new ResponderCommandError("FA409");
  const generation = JSON.stringify(incident);
  const signal = AbortSignal.timeout(10_000), deadline = performance.now() + 10_000;
  const check = () => { if (signal.aborted || performance.now() > deadline) throw new InventoryCapacityError("read_budget"); };
  // Resolve context first, then reread the recommendation inside the generation fence.
  const recommendation = await findRecommendationRow(locatedRecommendation.id, true, signal); check();
  if (!recommendation || recommendation.incident_id !== incident.id) throw new InventoryCapacityError("read_generation");
  if (!inventory || !inventory.recommendationIds.includes(recommendation.id) ||
    !inventory.assetIds.includes(recommendation.asset_id)) {
    throw new InventoryCapacityError("read_unverified");
  }

  if (isNonOperationalIncidentRecord(incident) || isNonOperationalRecommendationRecord(recommendation)) throw new InventoryCapacityError("read_unverified");
  const assetResult = await supabase.from("assets").select("*")
    .eq("incident_id", incident.id).eq("id", recommendation.asset_id).abortSignal(signal).retry(false).maybeSingle();
  check(); if (assetResult.error) throw assetResult.error;
  const asset = assetResult.data as SupabaseAssetRow | null;
  if (!asset || asset.id !== recommendation.asset_id || asset.incident_id !== incident.id || isNonOperationalAssetRecord(asset)) throw new InventoryCapacityError("read_unverified");
  if (Buffer.byteLength(JSON.stringify(asset)) + Buffer.byteLength(JSON.stringify(recommendation)) > 8 * 1024 * 1024) throw new InventoryCapacityError("read_budget");
  const domainAsset = mapAssetRow(redactFirmsProvenance(asset), incident);
  if (!domainAsset) return null;
  const mappedRecommendation = redactFirmsProvenance(mapRecommendationRow(
    recommendation,
    domainAsset,
    incident,
  ));
  if (!mappedRecommendation) return null;
  mappedRecommendation.inventoryRevision = inventory.revision;
  const scope = prepareCountyScope(mapSupabaseIncidentRow(incident));
  if (!scope.contains(domainAsset.coordinates) || !scope.contains(mappedRecommendation.coordinates)) throw new InventoryCapacityError("read_unverified");
  let sources: SourceSnapshot[];
  if (inventory.sourceQueueVersion !== undefined) {
    // A missing/corrupt modern projection must never fall back to a full scan.
    sources = (await readPublishedSourceModels(supabase, incident, inventory, signal, check)).sources;
  } else {
    const sourceRows = await readRows<SupabaseSourceSnapshotRow>("source_snapshots", recommendation.incident_id, signal);
    sources = selectInventoryRows(sourceRows, inventory.sourceSnapshotIds, incident.id).map(mapSourceSnapshotRow);
  }
  check();
  const afterRead = await readIncidentRow(incident.id, signal); check();
  if (!afterRead || JSON.stringify(afterRead) !== generation) throw new InventoryCapacityError("read_generation");
  const assessedAt = new Date();
  const currentSources = currentSourceSnapshots(sources)
    .map((source) => projectSourceFreshness(source, assessedAt, evidenceMaxAgeMinutes()));
  const [domainRecommendation] = projectRecommendationFreshness([mappedRecommendation], currentSources, assessedAt);
  const action = createResponderAction({
    command: { id: command.commandId, actorId: input.actorId, expectedRevision: command.expectedRevision },
    recommendation: domainRecommendation,
    action: input.action,
    note: input.note,
    actorName: input.actorName,
    modifiedPriority: input.modifiedPriority,
  });
  const payload = buildSupabasePayload(
    {
      incident: mapSupabaseIncidentRow(incident),
      sourceSnapshots: [],
      recommendations: [domainRecommendation],
    },
    {
      assets: domainAsset ? [domainAsset] : [],
      actions: [action],
      auditEvents: [action.auditEvent],
      databaseIncidentId: incident.id,
    },
  );

  const actionRow = {
    ...payload.responderActions[0],
    recommendation_id: locatedRecommendation.id,
    actor_id: input.actorId,
  };
  const auditEventRow = {
    ...payload.auditEvents[0],
    recommendation_id: locatedRecommendation.id,
    actor_id: input.actorId,
  };
  let committed: ResponderAction;
  try {
    check();
    const receipt = await invoke(actionRow, auditEventRow);
    committed = mapResponderCommandReceipt(receipt, input.actorId, locatedRecommendation.id, command);
  } catch (error) {
    console.error("[fireafter] atomic responder action persistence failed", {
      recommendationId: input.recommendationId,
      action: input.action,
      errorName: error instanceof Error ? error.name : "SupabaseRpcError",
    });
    throw error;
  }
  console.info("[fireafter] responder action persisted atomically", {
    recommendationId: input.recommendationId,
    action: input.action,
  });
  return committed;
}

export function mapResponderCommandReceipt(value: unknown, actorId: string, recommendationId: string, command: ResponderCommand): ResponderAction {
  if (!value || typeof value !== "object" || !("action" in value) || !("auditEvent" in value)) {
    throw new ResponderCommandError("unavailable");
  }
  const action = value.action as SupabaseResponderActionRow;
  const audit = value.auditEvent as SupabaseAuditEventRow;
  if (!action || !audit || !isUuid(action.id) || !isUuid(audit.id) ||
    action.actor_id !== actorId || audit.actor_id !== actorId ||
    action.recommendation_id !== recommendationId || audit.recommendation_id !== recommendationId ||
    !action.recommendation_snapshot?.id || !audit.payload?.domainAuditEventId ||
    audit.payload?.commandId !== command.commandId || audit.payload.expectedRevision !== command.expectedRevision ||
    action.recommendation_snapshot.domainActionId !== `action-command-${actorId}-${command.commandId}` ||
    audit.payload.domainAuditEventId !== `audit-command-${actorId}-${command.commandId}` ||
    action.note !== command.note || action.action !== command.action ||
    (action.modified_priority ?? undefined) !== command.modifiedPriority ||
    action.note !== audit.payload.note || action.action !== audit.payload.action ||
    Date.parse(action.created_at ?? "") !== Date.parse(audit.created_at ?? "")) throw new ResponderCommandError("unavailable");
  return mapResponderActionRow(action, [mapAuditEventRow(audit)]);
}

export async function persistImportedAssetsToSupabase(input: {
  importOperation: ImportOperation;
  incidentId: string;
  assets: Asset[];
  auditEvent: AuditEvent;
  actorOrganizationId?: string;
  principal: BundlePrincipal;
  persistence: BundlePersistence;
}) {
  const write = bundleWrite(input.principal, input.persistence, "import", input.importOperation);
  if (!write.databaseIncidentId) throw new BundleWriteError("FB400");
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new BundleWriteError("FB503");

  const incident = await readIncidentRow(write.databaseIncidentId);
  if (!incident) throw new BundleWriteError("FB409");
  if (
    input.actorOrganizationId &&
    incident.organization_id !== input.actorOrganizationId
  ) {
    throw new Error("Incident access denied");
  }

  const existingBundle = await getSupabaseIncidentBundleByDatabaseId(write.databaseIncidentId);
  if (!existingBundle) throw new BundleWriteError("FB404");
  if (write.organizationId !== existingBundle.persistence.organizationId) throw new BundleWriteError("FB401");
  if (write.expectedRevision !== existingBundle.persistence.expectedRevision ||
    (write.databaseIncidentId !== undefined && write.databaseIncidentId !== existingBundle.persistence.databaseIncidentId)) {
    throw new BundleWriteError("FB409");
  }
  if (input.assets.some((asset) => asset.incidentId !== existingBundle.incident.id)) {
    throw new Error("Imported assets must belong to the selected incident");
  }

  const assetsById = new Map(existingBundle.assets.map((asset) => [asset.id, asset]));
  const uploadValidationBudget = { vertices: 0, comparisons: 0 };
  for (const asset of input.assets) {
    if (!isUploadedAsset(asset)) throw new InventoryCapacityError("uploaded_geometry_invalid");
    assetsById.set(asset.id, projectUploadedAsset(asset, existingBundle.incident, uploadValidationBudget));
  }

  const persisted = await persistBundleToSupabase(
    {
      incident: existingBundle.incident,
      sourceSnapshots: existingBundle.sourceSnapshots,
      // Current rankings predate this inventory change. Retire membership in
      // the import transaction; keep historical rows and decisions untouched.
      recommendations: [],
    },
    {
      assets: [...assetsById.values()],
      actions: [],
      auditEvents: [input.auditEvent],
      write,
    },
  );
  if (!persisted) throw new BundleWriteError("FB503");

  const receipt = persisted.importReceipt;
  if (!receipt) throw new BundleWriteError("FB503");
  const replayed = persisted.importReplayed === true;
  console.info("[fireafter] import operation confirmed", {
    operation: "asset_import", code: replayed ? "replayed" : "committed",
    operationId: receipt.operationId, incidentId: receipt.incidentId,
    assetCount: receipt.assetCount, auditEventId: receipt.auditEventId,
  });
  return { ...input, receipt, replayed };
}

async function writeRows(table: string, rows: object | object[]) {
  const supabase = getSupabaseAdminClient();
  const values = Array.isArray(rows) ? rows : [rows];
  if (!supabase || values.length === 0) return;

  const tableWriter = supabase.from(table as never) as unknown as {
    upsert: (insertRows: object[]) => Promise<{ error: Error | null }>;
  };
  const { error } = await tableWriter.upsert(values);
  if (error) throw error;
}

async function readRows<T>(
  table: string,
  incidentId: string,
  parentSignal?: AbortSignal,
): Promise<T[]> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return [];
  const rows: T[] = [];
  let expected: number | undefined;
  let afterId: string | undefined;
  let bytes = 0;
  const timeout = AbortSignal.timeout(30_000);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const deadline = performance.now() + 30_000;
  const checkDeadline = () => {
    if (signal.aborted || performance.now() > deadline) {
      console.warn("[fireafter] inventory acquisition deadline exceeded", { operation: "read_inventory", table, code: "read_budget" });
      throw new InventoryCapacityError("read_budget");
    }
  };
  // Count every remaining keyset, not page length: a deployment can impose a
  // lower row cap than requested. Never interpret that cap as end of inventory.
  do {
    checkDeadline();
    let query = supabase.from(table).select("*", { count: "exact" })
      .eq("incident_id", incidentId).order("id", { ascending: true }).limit(500);
    if (afterId) query = query.gt("id", afterId);
    const { data, error, count } = await query.abortSignal(signal).retry(false);
    checkDeadline();
    if (error) throw error;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(data)) {
      throw new InventoryCapacityError("read_invalid");
    }
    expected ??= count;
    if (expected > 100_000) {
      throw new InventoryCapacityError("read_budget");
    }
    if (count !== expected - rows.length || data.length > count || (count > 0 && data.length === 0)) {
      throw new InventoryCapacityError("read_invalid");
    }
    bytes += Buffer.byteLength(JSON.stringify(data), "utf8");
    if (bytes > 64 * 1024 * 1024) throw new InventoryCapacityError("read_budget");
    for (const value of data as unknown[]) {
      const row = value as Record<string, unknown> | null;
      if (!row || typeof row.id !== "string" || !isUuid(row.id) || row.incident_id !== incidentId || (afterId !== undefined && row.id <= afterId)) {
        throw new InventoryCapacityError("read_invalid");
      }
      afterId = row.id;
      rows.push(row as T);
    }
  } while (rows.length < expected);
  checkDeadline();
  const final = await supabase.from(table).select("id", { count: "exact", head: true }).eq("incident_id", incidentId)
    .abortSignal(signal).retry(false);
  checkDeadline();
  if (final.error) throw final.error;
  if (final.count !== expected) throw new InventoryCapacityError("read_invalid");
  return rows;
}

async function readAuditEvents(incidentId: string, signal: AbortSignal): Promise<AuditEventsReadResult> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return { rows: [], status: "unavailable" };

  const [decisionResult, systemResult] = await Promise.allSettled([
    supabase
      .from("audit_events")
      .select("*")
      .eq("incident_id", incidentId)
      .in("event_type", decisionAuditEventTypes)
      .order("created_at", { ascending: false })
      .limit(100).abortSignal(signal).retry(false),
    supabase
      .from("audit_events")
      .select(
        "id,incident_id,recommendation_id,event_type,actor_id,actor_name,summary,created_at",
      )
      .eq("incident_id", incidentId)
      .order("created_at", { ascending: false })
      .limit(80).abortSignal(signal).retry(false),
  ]);

  const decisionQuery =
    decisionResult.status === "fulfilled" ? decisionResult.value : null;
  const systemQuery =
    systemResult.status === "fulfilled" ? systemResult.value : null;

  if (
    !decisionQuery ||
    !systemQuery ||
    decisionQuery.error ||
    systemQuery.error
  ) {
    console.warn("[fireafter] Audit trail read unavailable", {
      incidentId,
      decisionError:
        !decisionQuery || decisionQuery.error
          ? "QueryError"
          : undefined,
      systemError:
        !systemQuery || systemQuery.error
          ? "QueryError"
          : undefined,
    });
    return { rows: [], status: "unavailable" };
  }

  const decisionRows = ((decisionQuery.data ?? []) as SupabaseAuditEventRow[])
    .map((row) => ({
      ...row,
      payload: row.payload ?? {},
    }));
  const decisionIds = new Set(decisionRows.map((row) => row.id));
  const systemRows = ((systemQuery.data ?? []) as SupabaseAuditEventRow[])
    .filter(
      (row) =>
        !decisionIds.has(row.id) &&
        !decisionAuditEventTypes.includes(row.event_type),
    )
    .map((row) => ({
      ...row,
      payload: {},
    }));

  return { rows: [...decisionRows, ...systemRows], status: "available" };
}

async function readIncidentRow(id: string, signal?: AbortSignal) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return null;
  let query = supabase
    .from("incidents")
    .select("*")
    .eq("id", id);
  if (signal) query = query.abortSignal(signal).retry(false);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data as SupabaseIncidentRow | null;
}

async function findIncidentRow(incidentId: string, signal?: AbortSignal) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return null;
  const databaseRow = isUuid(incidentId) ? await readIncidentRow(incidentId.toLowerCase(), signal) : null;

  let query = supabase
    .from("incidents")
    .select("*")
    .contains("selected_fire", { domainIncidentId: incidentId });
  if (signal) query = query.abortSignal(signal).retry(false);
  const { data, error } = await query.maybeSingle();
  if (error?.code === "PGRST116") throw new InventoryCapacityError("read_invalid");
  if (error) throw error;
  return resolveIdentifierRows(databaseRow, data as SupabaseIncidentRow | null);
}

async function findRecommendationRow(recommendationId: string, databaseOnly = false, signal?: AbortSignal) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return null;

  let databaseRow: SupabaseRecommendationRow | null = null;
  if (isUuid(recommendationId)) {
    let query = supabase
      .from("recommendations")
      .select("*")
      .eq("id", recommendationId.toLowerCase());
    if (signal) query = query.abortSignal(signal).retry(false);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    databaseRow = data as SupabaseRecommendationRow | null;
  }
  if (databaseOnly) return databaseRow;

  let query = supabase
    .from("recommendations")
    .select("*")
    .contains("score_breakdown", { domainRecommendationId: recommendationId });
  if (signal) query = query.abortSignal(signal).retry(false);
  const { data, error } = await query.maybeSingle();
  if (error?.code === "PGRST116") throw new InventoryCapacityError("read_invalid");
  if (error) throw error;
  return resolveIdentifierRows(databaseRow, data as SupabaseRecommendationRow | null);
}

function resolveIdentifierRows<T extends { id: string }>(databaseRow: T | null, aliasRow: T | null): T | null {
  // External identifiers have no namespace marker: never guess between records.
  if (databaseRow && aliasRow && databaseRow.id !== aliasRow.id) {
    throw new InventoryCapacityError("read_invalid");
  }
  return databaseRow ?? aliasRow;
}

function mapSourceSnapshotRow(row: SupabaseSourceSnapshotRow): SourceSnapshot {
  return projectSourceLineGeometry({
    id: stringValue(row.raw_payload.domainSourceId, row.id),
    ...(NativeAcquisitionSchema.safeParse(row.raw_payload.nativeAcquisition).success?{nativeAcquisition:NativeAcquisitionSchema.parse(row.raw_payload.nativeAcquisition)}:{}),
    incidentId: stringValue(row.raw_payload.domainIncidentId, row.incident_id),
    sourceKey: row.source_key ?? optionalString(row.raw_payload.sourceKey),
    sourceUrl: row.source_url ?? optionalString(row.raw_payload.sourceUrl),
    sourceName: row.source_name,
    fetchedAt: row.fetched_at,
    sourceUpdatedAt: row.source_updated_at ?? "",
    sourceTimeBasis: row.raw_payload.sourceTimeBasis === "provider" ? "provider"
      : row.raw_payload.sourceTimeBasis === "retrieval" ? "retrieval" : "unknown",
    validUntil: optionalString(row.raw_payload.validUntil),
    status: row.status,
    stale: row.stale,
    freshnessLabel: row.freshness_label,
    detail: stringValue(row.raw_payload.detail, ""),
    coverageStatus:
      (row.coverage_status as SourceSnapshot["coverageStatus"]) ??
      (optionalString(row.raw_payload.coverageStatus) as SourceSnapshot["coverageStatus"]),
    warnings: row.warnings ?? arrayOfStrings(row.raw_payload.warnings),
    rawPayload: unpackSourcePayload(row.raw_payload),
    derivedSignals: row.derived_signals ?? recordValue(row.raw_payload.derivedSignals),
  });
}

function currentSourceSnapshots(snapshots: SourceSnapshot[]) {
  // Membership is explicit; preserve ambiguity for semantic assurance gates.
  return [...snapshots].sort((a, b) =>
    sourceOrder(a).localeCompare(sourceOrder(b)),
  );
}

function sourceOrder(snapshot: Pick<SourceSnapshot, "sourceKey" | "sourceName">) {
  const key = snapshot.sourceKey ?? snapshot.sourceName;
  const order: Record<string, string> = {
    nws: "1",
    wfigs: "2",
    firms: "3",
    "usgs-pwfdf": "4",
    "tiger-roads": "5",
    "3dhp-flowlines": "6",
  };
  return `${order[key] ?? "9"}-${key}`;
}


function mapAssetRow(row: SupabaseAssetRow, incident: SupabaseIncidentRow, uploadValidationBudget?: ImportValidationBudget): Asset | undefined {
  if (row.incident_id !== incident.id) return undefined;
  const coordinates = coordinateValue(row.properties.coordinates);
  if (!coordinates && isUploadedAsset({ localOrUploaded: row.local_or_uploaded, origin: row.origin ?? undefined, sourceKey: row.source_key ?? optionalString(row.properties.sourceKey) })) {
    throw new InventoryCapacityError("uploaded_geometry_invalid");
  }
  if (!coordinates) return undefined;
  if (!hasCurrentCrossingGeometry({
    localOrUploaded: row.local_or_uploaded, origin: row.origin ?? undefined,
    type: row.asset_type, sourceKey: row.source_key ?? undefined,
    metrics: recordValue(row.properties.metrics) as Asset["metrics"],
  })) return undefined;

  const asset: Asset = {
    id: stringValue(row.properties.domainAssetId, row.id),
    incidentId: stringValue(incident.selected_fire?.domainIncidentId, incident.id),
    name: row.name,
    type: row.asset_type,
    locationLabel: row.location_label,
    coordinates,
    source: row.source,
    confidence: row.confidence,
    localOrUploaded: row.local_or_uploaded,
    geometry: geometryValue(row.geometry_geojson ?? row.properties.geometry),
    origin: row.origin ?? (row.local_or_uploaded ? "uploaded" : undefined),
    sourceKey: row.source_key ?? optionalString(row.properties.sourceKey),
    sourceUrl: row.source_url ?? optionalString(row.properties.sourceUrl),
    sourceFeatureId:
      row.source_feature_id ?? optionalString(row.properties.sourceFeatureId),
    sourceFeatureIds:
      row.source_feature_ids ?? arrayOfStrings(row.properties.sourceFeatureIds),
    coverageStatus:
      (row.coverage_status as Asset["coverageStatus"]) ??
      (optionalString(row.properties.coverageStatus) as Asset["coverageStatus"]),
    confidenceReason:
      row.confidence_reason ?? optionalString(row.properties.confidenceReason),
    evidence: arrayOfRecords(row.properties.evidence) as Asset["evidence"],
    metrics: recordValue(row.properties.metrics) as Asset["metrics"],
    road: optionalString(row.properties.road),
    stream: optionalString(row.properties.stream),
  };
  if (isUploadedAsset(asset)) {
    // Validate the original JSON, not the permissive provider geometry projection.
    return projectUploadedAsset({ ...asset, coordinates: row.properties.coordinates as Asset["coordinates"], geometry: (row.geometry_geojson ?? row.properties.geometry) as Asset["geometry"] }, mapSupabaseIncidentRow(incident), uploadValidationBudget);
  }
  return asset;
}

function databaseRowIds(entries: [string, string][]): Record<string, string> {
  const ids: Record<string, string> = Object.create(null);
  for (const [domainId, databaseId] of entries) {
    if (!domainId || domainId === "__proto__" || !isUuid(databaseId) || Object.hasOwn(ids, domainId)) {
      throw new InventoryCapacityError("read_invalid");
    }
    ids[domainId] = databaseId;
  }
  return ids;
}

function mapRecommendationRow(
  row: SupabaseRecommendationRow,
  asset: Pick<Asset, "id" | "name" | "type" | "locationLabel" | "coordinates" | "localOrUploaded" | "origin" | "sourceKey" | "evidence"> | undefined,
  incident: SupabaseIncidentRow,
): Recommendation | undefined {
  if (row.incident_id !== incident.id) return undefined;
  const breakdown = row.score_breakdown;
  const unverifiedUpload = Boolean(asset && isUploadedAsset(asset));
  const coordinates = coordinateValue(breakdown.coordinates, asset?.coordinates);
  if (!coordinates) return undefined;

  return {
    id: stringValue(breakdown.domainRecommendationId, row.id),
    incidentId: stringValue(incident.selected_fire?.domainIncidentId, incident.id),
    assetId: asset?.id ?? row.asset_id,
    assetName: stringValue(breakdown.assetName, asset?.name ?? "Risk Asset"),
    assetType: stringValue(
      breakdown.assetType,
      asset?.type ?? "Road Crossing",
    ) as Asset["type"],
    locationLabel: stringValue(
      breakdown.locationLabel,
      asset?.locationLabel ?? "Persisted location",
    ),
    coordinates,
    recommendedAction: !unverifiedUpload && breakdown.scoringVersion === SCORING_VERSION ? row.recommended_action : UNKNOWN_RISK_ACTION,
    finalScore: Number(row.final_score),
    score100: Number(row.score_100),
    riskLevel: !unverifiedUpload && breakdown.scoringVersion === SCORING_VERSION ? row.risk_level : "Unknown",
    confidenceLevel: !unverifiedUpload && breakdown.scoringVersion === SCORING_VERSION ? row.confidence_level : "Low",
    reasonCodes: breakdown.scoringVersion === SCORING_VERSION ? row.reason_codes ?? []
      : ["Legacy evidence interpretation: refresh required"],
    limitations: [
      ...(unverifiedUpload ? [UPLOAD_CONFIDENCE_REASON] : []),
      ...(breakdown.scoringVersion === SCORING_VERSION ? [] : ["Legacy source/scoring interpretation: refresh required. This is not a current hazard assessment."]),
      ...(row.limitations ?? []),
    ],
    changedSinceLastRefresh: breakdown.scoringVersion === SCORING_VERSION ? row.changed_since_last_refresh
      : "Legacy ranking; refresh required before comparing current priority.",
    sourcesUpdatedLabel: stringValue(breakdown.sourcesUpdatedLabel, ""),
    dataFreshnessHours: numberValue(breakdown.dataFreshnessHours, 0),
    scoreBreakdown: {
      scoringVersion: optionalString(breakdown.scoringVersion),
      scoreBasis: breakdown.scoringVersion === SCORING_VERSION
        ? (unverifiedUpload || row.risk_level === "Unknown" ? "review-only" : "hazard-screening")
        : "legacy-unassessed",
      rainfallThreat: numberValue(breakdown.rainfallThreat, 0),
      burnSeverity: numberValue(breakdown.burnSeverity, 0),
      slopeTerrain: numberValue(breakdown.slopeTerrain, 0),
      downstreamExposure: numberValue(breakdown.downstreamExposure, 0),
      dataFreshness: numberValue(breakdown.dataFreshness, 0),
      confidenceMultiplier: unverifiedUpload ? Math.min(0.49, numberValue(breakdown.confidenceMultiplier, 0)) : numberValue(breakdown.confidenceMultiplier, 1),
      baseScore: numberValue(breakdown.baseScore, Number(row.final_score)),
      finalScore: numberValue(breakdown.finalScore, Number(row.final_score)),
      metricStatus: breakdown.scoringVersion === SCORING_VERSION ? recordValue(
        row.metric_status ?? breakdown.metricStatus,
      ) as Recommendation["scoreBreakdown"]["metricStatus"] : {
        rainfallThreat: "not_available", burnSeverity: "not_available",
        slopeTerrain: "not_available", downstreamExposure: "not_available",
        dataFreshness: "not_available",
      },
    },
    evidence:
      (row.evidence as Recommendation["evidence"]) ??
      (arrayOfRecords(breakdown.evidence) as Recommendation["evidence"]) ??
      asset?.evidence,
    sourceSnapshotIds:
      row.source_snapshot_ids ??
      arrayOfStrings(breakdown.sourceSnapshotIds),
    createdAt: stringValue(breakdown.createdAt, row.created_at ?? ""),
  };
}

function mapAuditEventRow(row: SupabaseAuditEventRow): AuditEvent {
  return {
    id: typeof row.payload.commandId === "string" ? stringValue(row.payload.domainAuditEventId, row.id) : row.id,
    incidentId: stringValue(row.payload.domainIncidentId, row.incident_id),
    recommendationId: optionalString(row.payload.domainRecommendationId),
    eventType: row.event_type,
    actorName: row.actor_name,
    createdAt: row.created_at ?? "",
    summary: row.summary,
    payload: row.payload,
  };
}

function mapResponderActionRow(
  row: SupabaseResponderActionRow,
  auditEvents: AuditEvent[],
): ResponderAction {
  const recommendationSnapshot = row.recommendation_snapshot;
  const commandAction = typeof recommendationSnapshot.domainActionId === "string" && recommendationSnapshot.domainActionId.startsWith("action-command-");
  const matchedAudit =
    auditEvents.find(
      (event) =>
        event.recommendationId === recommendationSnapshot.id &&
        (commandAction
          ? event.id === recommendationSnapshot.domainActionId!.replace(/^action-command-/, "audit-command-") : true) &&
        event.payload.action === row.action,
    );
  if (commandAction && !matchedAudit) throw new InventoryCapacityError("read_invalid");
  const auditEvent = matchedAudit ??
    createResponderAction({
      recommendation: recommendationSnapshot,
      action: row.action,
      note: row.note,
      actorName: row.actor_name,
      createdAt: row.created_at,
      modifiedPriority: row.modified_priority ?? undefined,
    }).auditEvent;

  return {
    id: recommendationSnapshot.domainActionId ?? row.id,
    recommendationId: recommendationSnapshot.id,
    action: row.action,
    note: row.note,
    actorName: row.actor_name,
    createdAt: row.created_at ?? "",
    modifiedPriority: row.modified_priority ?? undefined,
    recommendationSnapshot,
    auditEvent,
  };
}

function compactAuditEvents(events: AuditEvent[]) {
  return compactByLogicalKey(events, auditEventLogicalKey);
}

function compactResponderActions(actions: ResponderAction[]) {
  return compactByLogicalKey(actions, responderActionLogicalKey);
}

function compactByLogicalKey<T extends { id: string; createdAt: string }>(
  rows: T[],
  keyFor: (row: T) => string,
) {
  const compacted = new Map<string, T>();
  for (const row of rows) {
    const key = keyFor(row);
    const existing = compacted.get(key);
    if (!existing || compareNewest(row, existing) > 0) {
      compacted.set(key, row);
    }
  }
  return [...compacted.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function auditEventLogicalKey(event: AuditEvent) {
  const domainAuditEventId = stringValue(event.payload.domainAuditEventId, "");
  if (domainAuditEventId) return `domain:${domainAuditEventId}`;

  const snapshot = recommendationSnapshotValue(event.payload.recommendationSnapshot);
  return [
    "signature",
    event.eventType,
    event.recommendationId ?? "",
    event.actorName,
    event.summary,
    event.createdAt,
    stringValue(event.payload.action, ""),
    stringValue(event.payload.note, ""),
    snapshot?.id ?? "",
  ].join("|");
}

function responderActionLogicalKey(action: ResponderAction) {
  if (action.id && !isUuid(action.id)) return `domain:${action.id}`;

  return [
    "signature",
    action.recommendationId,
    action.action,
    action.note,
    action.actorName,
    action.createdAt,
    action.modifiedPriority ?? "",
  ].join("|");
}

function recommendationSnapshotValue(value: unknown) {
  if (!value || typeof value !== "object") return null;
  if (!("id" in value)) return null;
  return value as Recommendation;
}

function compareNewest<T extends { id: string; createdAt: string }>(a: T, b: T) {
  const timestampDelta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (Number.isFinite(timestampDelta) && timestampDelta !== 0) {
    return timestampDelta;
  }
  return a.id.localeCompare(b.id);
}

function assetsFromRecommendations(recommendations: Recommendation[]): Asset[] {
  const seen = new Set<string>();
  return recommendations
    .filter((recommendation) => {
      if (seen.has(recommendation.assetId)) return false;
      seen.add(recommendation.assetId);
      return true;
    })
    .map((recommendation) => ({
      id: recommendation.assetId,
      incidentId: recommendation.incidentId,
      name: recommendation.assetName,
      type: recommendation.assetType,
      locationLabel: recommendation.locationLabel,
      coordinates: recommendation.coordinates,
      source: "Persisted from recommendation context",
      confidence: recommendation.confidenceLevel,
      localOrUploaded: false,
    }));
}

function stableUuid(input: string) {
  const hash = createHash("sha1").update(input).digest("hex");
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampOrNull(value?: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function geometryValue(value: unknown): Asset["geometry"] {
  const record = recordValue(value);
  if (record.type === "Point" && Array.isArray(record.coordinates)) {
    const coordinates = coordinateValue(record.coordinates);
    return coordinates ? { type: "Point", coordinates } : undefined;
  }
  if (record.type === "LineString" && Array.isArray(record.coordinates)) {
    const coordinates = coordinateArrayValue(record.coordinates);
    return coordinates.length > 0 ? { type: "LineString", coordinates } : undefined;
  }
  if (record.type === "Polygon" && Array.isArray(record.coordinates)) {
    const coordinates = record.coordinates
      .map(coordinateArrayValue)
      .filter((ring) => ring.length > 0);
    return coordinates.length > 0 ? { type: "Polygon", coordinates } : undefined;
  }
  return undefined;
}

function locationCandidateValue(value: unknown) {
  const record = recordValue(value);
  if (!record.id || !record.county || !record.state || !Array.isArray(record.centroid)) {
    return undefined;
  }
  const centroid = coordinateValue(record.centroid);
  if (!centroid) return undefined;

  return {
    id: stringValue(record.id, ""),
    county: stringValue(record.county, ""),
    state: stringValue(record.state, ""),
    label: stringValue(record.label, `${record.county}, ${record.state}`),
    centroid,
    bbox: bboxValue(record.bbox),
    fips: stringValue(record.fips, "unknown"),
    fireWeatherZone: stringValue(record.fireWeatherZone, "auto"),
    population: numberValue(record.population, 0),
    wildfireContext: stringValue(
      record.wildfireContext,
      "Persisted county context loaded from Supabase.",
    ),
    boundary: record.boundary == null ? undefined : normalizeCountyBoundary(record.boundary),
    sourceKey: optionalString(record.sourceKey),
    sourceUrl: optionalString(record.sourceUrl),
    coverageStatus: optionalString(record.coverageStatus) as NonNullable<
      Incident["locationContext"]
    >["coverageStatus"],
  };
}

function coordinateValue(
  value: unknown,
  fallback?: [number, number],
): [number, number] | undefined {
  if (Array.isArray(value) && value.length >= 2) {
    const lon = Number(value[0]);
    const lat = Number(value[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      return [lon, lat];
    }
  }
  return fallback;
}

function coordinateArrayValue(value: unknown): [number, number][] {
  return Array.isArray(value)
    ? value
        .map((point) => coordinateValue(point))
        .filter((point): point is [number, number] => Boolean(point))
    : [];
}

function bboxValue(value: unknown) {
  if (Array.isArray(value) && value.length >= 4) {
    const parsed = value.slice(0, 4).map(Number);
    if (parsed.every(Number.isFinite)) {
      return parsed as [number, number, number, number];
    }
  }
  return undefined;
}

function formatDisplayTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
