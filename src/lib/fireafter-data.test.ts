import { describe, expect, it } from "vitest";
import {
  compactSourceRawPayload,
  createIncidentBundle,
  getDashboardBundle,
  shouldUseFixtureFallback,
  toClientDashboardBundle,
} from "./fireafter-data";
import type { AuditEvent, ResponderAction, SourceSnapshot } from "./types";
import { MTBS_INTERPRETATION_VERSION, projectSourceFreshness } from "./source-freshness";

describe("FireAfter data service", () => {
  it("preserves current MTBS semantics through compaction, JSON and freshness projection without inventing severity", () => {
    const source = { ...sourceSnapshot({ interpretationVersion: MTBS_INTERPRETATION_VERSION,
      sample: [{ geometry: "server-only boundary" }], measurementStatus: "unavailable" }),
      sourceKey: "mtbs-burn-severity", status: "delayed" as const, coverageStatus: "not_available" as const,
      stale: true, detail: "Boundary-only context; incident burn severity remains unavailable.",
      derivedSignals: { burnSeverity: 0.9 },
    };
    const original = structuredClone(source);
    const compact = JSON.parse(JSON.stringify(toClientDashboardBundle({ sourceSnapshots: [source] })));
    expect(compact.sourceSnapshots[0].rawPayload).toMatchObject({ interpretationVersion: MTBS_INTERPRETATION_VERSION });
    expect(compact.sourceSnapshots[0].rawPayload).not.toHaveProperty("sample");
    const projected = projectSourceFreshness(compact.sourceSnapshots[0], new Date("2026-06-28T00:01:00Z"));
    expect(projected).toMatchObject({ detail: source.detail, coverageStatus: "not_available", stale: true, status: "delayed" });
    expect(projected.derivedSignals?.burnSeverity).toBeUndefined();
    expect(source).toEqual(original);
  });
  it.each([undefined, "legacy", "PRIVATE_PROVIDER_DIAGNOSTIC", { nested: "private" }])("does not serialize an arbitrary interpretation marker: %j", interpretationVersion => {
    const compact = compactSourceRawPayload({ interpretationVersion });
    expect(compact).not.toHaveProperty("interpretationVersion");
    const projected = projectSourceFreshness({ ...sourceSnapshot(compact), sourceKey: "mtbs-burn-severity" }, new Date("2026-06-28T00:01:00Z"));
    expect(projected.detail).toContain("Legacy MTBS interpretation requires refresh");
  });
  it("preserves the safe PWFDF acquisition contract in compact payloads without geometry or arbitrary diagnostics", () => {
    const compact = compactSourceRawPayload({ analysisGeometryVersion: "2026-09-14-provider-resolution-v1",
      basins: [{ geometry: "test-only-heavy-geometry" }], failureCode: "pwfdf_analysis_geometry_unverified" });
    expect(compact).toMatchObject({ analysisGeometryVersion: "2026-09-14-provider-resolution-v1",
      failureCode: "pwfdf_analysis_geometry_unverified", basinCount: 1 });
    expect(compact).not.toHaveProperty("basins");
    expect(compactSourceRawPayload({ failureCode: "PRIVATE_PROVIDER_DIAGNOSTIC" })).not.toHaveProperty("failureCode");
  });
  it("FA10-I2 strips original database persistence context from client bundles without changing server context", () => {
    const persistence = { organizationId: "10000000-0000-4000-8000-000000000001", databaseIncidentId: "20000000-0000-4000-8000-000000000002", expectedRevision: "30000000-0000-4000-8000-000000000003" };
    const original = { sourceSnapshots: [], persistence: { ...persistence, rowIds: { asset: { legacy: persistence.databaseIncidentId }, recommendation: {}, source: {} } } };
    const serverContext = original.persistence;
    const result = toClientDashboardBundle(original);
    expect(result).not.toHaveProperty("persistence");
    expect(JSON.stringify(result)).not.toContain(persistence.databaseIncidentId);
    expect(original.persistence).toBe(serverContext);
  });

  it("redacts legacy FIRMS URLs throughout client source and audit projections", () => {
    const url = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/synthetic-legacy-key/VIIRS/1,2,3,4/3";
    const source = { ...sourceSnapshot({ warning: `Upstream URL: ${url}` }), sourceUrl: url };
    const auditEvent = auditEventWithBulkPayload();
    auditEvent.payload.legacyEvidence = { sourceUrl: url };
    const original = { sourceSnapshots: [source], actions: [responderAction(auditEvent)], auditEvents: [auditEvent] };
    const result = toClientDashboardBundle(original);
    expect(JSON.stringify(result)).not.toContain("synthetic-legacy-key");
    expect(result.sourceSnapshots[0].sourceUrl).toBe("https://firms.modaps.eosdis.nasa.gov/api/area/");
    expect(original.sourceSnapshots[0].sourceUrl).toBe(url);
  });
  it("falls back to an honest local dashboard shell when Supabase is not configured in tests", async () => {
    const bundle = await getDashboardBundle();

    expect(bundle.incident.id).toBe("incident-los-angeles-ca");
    expect(bundle.sourceSnapshots).toEqual([]);
    expect(bundle.recommendations).toEqual([]);
  });

  it("creates a searchable county incident bundle without seeded recommendations", async () => {
    const bundle = await createIncidentBundle("ventura-ca", { kind: "user", actorId: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000002" });

    expect(bundle.incident.county).toBe("Ventura County");
    expect(bundle.recommendations).toEqual([]);
  });

  it("never enables fixture fallback in production", () => {
    expect(shouldUseFixtureFallback("production", "true")).toBe(false);
    expect(shouldUseFixtureFallback("development", "true")).toBe(true);
    expect(shouldUseFixtureFallback("test", "false")).toBe(true);
  });

  it("strips heavy raw source payloads from client dashboard bundles", () => {
    const source = sourceSnapshot({
      featureCount: 1,
      features: [{ type: "Feature", geometry: { type: "LineString" } }],
      assets: [{ id: "asset-1" }],
      hotspotCount: 2,
      basins: [{ id: "pwfdf-1", geometry: { type: "Polygon" } }],
      hazardCounts: { High: 1 },
      nested: { shouldNotSerialize: true },
    });
    const bundle = toClientDashboardBundle({
      sourceSnapshots: [source],
    });

    expect(bundle.sourceSnapshots[0].rawPayload).toMatchObject({
      featureCount: 1,
      assetCount: 1,
      hotspotCount: 2,
      basinCount: 1,
      hazardCounts: { High: 1 },
      compacted: true,
    });
    expect(bundle.sourceSnapshots[0].rawPayload?.features).toBeUndefined();
    expect(bundle.sourceSnapshots[0].rawPayload?.assets).toBeUndefined();
    expect(bundle.sourceSnapshots[0].rawPayload?.basins).toBeUndefined();
    expect(source.rawPayload?.features).toEqual([
      { type: "Feature", geometry: { type: "LineString" } },
    ]);
  });

  it("does not expose provider error text in compact source payloads", () => {
    const compact = compactSourceRawPayload({
      error: "secret provider diagnostic",
      reason: "upstream_unavailable",
      status: "error",
    });

    expect(compact).toMatchObject({
      reason: "upstream_unavailable",
      status: "error",
      compacted: true,
    });
    expect(compact.error).toBeUndefined();
    expect(JSON.stringify(compact)).not.toContain("secret provider diagnostic");
  });

  it("compacts audit payload arrays without removing recommendation snapshots", () => {
    const auditEvent = auditEventWithBulkPayload();
    const action = responderAction(auditEvent);
    const bundle = toClientDashboardBundle({
      sourceSnapshots: [],
      actions: [action],
      auditEvents: [auditEvent],
    });

    expect(bundle.auditEvents[0].payload).toMatchObject({
      sourceSnapshotsCount: 1,
      assetsCount: 1,
      recommendationsCount: 1,
      compacted: true,
      recommendationSnapshot: {
        id: "rec-1",
        assetName: "SR-33 @ Creek",
      },
    });
    expect(bundle.auditEvents[0].payload.sourceSnapshots).toBeUndefined();
    expect(bundle.auditEvents[0].payload.assets).toBeUndefined();
    expect(bundle.actions[0].auditEvent.payload.sourceSnapshots).toBeUndefined();
    expect(auditEvent.payload.sourceSnapshots).toHaveLength(1);
  });
});

function sourceSnapshot(rawPayload: Record<string, unknown>): SourceSnapshot {
  return {
    id: "source-tiger-roads",
    incidentId: "incident-ventura",
    sourceName: "TIGERweb Roads",
    sourceKey: "tiger-roads",
    status: "online",
    stale: false,
    fetchedAt: "2026-06-28T00:00:00.000Z",
    sourceUpdatedAt: "2026-06-28T00:00:00.000Z",
    freshnessLabel: "Just now",
    detail: "Road features loaded.",
    coverageStatus: "available",
    warnings: [],
    rawPayload,
    derivedSignals: {},
  };
}

function auditEventWithBulkPayload(): AuditEvent {
  return {
    id: "audit-1",
    incidentId: "incident-ventura",
    recommendationId: "rec-1",
    eventType: "RecommendationAccepted",
    actorName: "commander@example.com",
    createdAt: "2026-06-28T00:00:00.000Z",
    summary: "Accepted recommendation.",
    payload: {
      recommendationSnapshot: {
        id: "rec-1",
        incidentId: "incident-ventura",
        assetId: "asset-1",
        assetName: "SR-33 @ Creek",
        assetType: "Culvert",
        locationLabel: "Creek",
        coordinates: [-119.2, 34.4],
        recommendedAction: "Inspect culvert.",
        finalScore: 0.7,
        score100: 70,
        riskLevel: "High",
        confidenceLevel: "High",
        reasonCodes: ["Local Asset Imported"],
        limitations: [],
        changedSinceLastRefresh: "Local Asset Recalculated",
        sourcesUpdatedLabel: "Fresh",
        dataFreshnessHours: 1,
        scoreBreakdown: {
          rainfallThreat: 0.7,
          burnSeverity: 0.5,
          slopeTerrain: 0.6,
          downstreamExposure: 0.8,
          dataFreshness: 0.9,
          confidenceMultiplier: 0.9,
          baseScore: 0.75,
          finalScore: 0.7,
        },
        createdAt: "2026-06-28T00:00:00.000Z",
      },
      sourceSnapshots: [sourceSnapshot({ features: [{ id: 1 }] })],
      assets: [{ id: "asset-1" }],
      recommendations: [{ id: "rec-1" }],
    },
  };
}

function responderAction(auditEvent: AuditEvent): ResponderAction {
  return {
    id: "action-1",
    recommendationId: "rec-1",
    action: "accept",
    note: "Reviewed.",
    actorName: "commander@example.com",
    createdAt: "2026-06-28T00:00:00.000Z",
    recommendationSnapshot: auditEvent.payload.recommendationSnapshot as ResponderAction["recommendationSnapshot"],
    auditEvent,
  };
}
