import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { SOURCE_LINE_GEOMETRY_VERSION, SOURCE_LINE_UNAVAILABLE_WARNING } from "./source-line-geometry";
import { createResponderAction } from "./audit";
import { requireIncidentAccess, requireRecommendationAccess } from "./auth";
import { SCORING_VERSION } from "./scoring";
import { createQueueReadIndex, queueReadPageIds } from "./queue-read-index";
import { QUEUE_SOURCE_VERSION, queueSourceProjection, readQueueSourceModel } from "./queue-source-read-model";
import { SOURCE_SPATIAL_ENCODING } from "./source-spatial-storage";
import { parseInventoryManifest } from "./inventory-manifest";
import { projectRecommendationFreshness } from "./source-freshness";
import { inferCrossingAssets } from "./live-sources";
import { linkPwfdfHazardsToAssets, type PwfdfAssessment, type PwfdfBasinHazard } from "./pwfdf";
import {
  buildSupabasePayload,
  checkSupabaseRealitySchema,
  getDefaultOrganizationMembership,
  getDefaultOrganizationId,
  getIncidentAuthorizationContext,
  getRecommendationAuthorizationContext,
  getSupabaseIncidentBundle,
  getSupabaseIncidentBundleByDatabaseId,
  listSupabaseIncidentIds,
  mapSupabaseRowsToBundle,
  persistImportedAssetsToSupabase,
  persistBundleToSupabase,
  recordSupabaseAction,
} from "./fireafter-supabase";
import { getSupabaseAdminClient, getSupabaseServerClient } from "./supabase";
import { importOperation } from "../test/import-operation-fixture";
import { IMPORT_COMMIT_RPC } from "./import-operation";
import {
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC,
  ATOMIC_RESPONDER_ACTION_SECURITY_RPC,
  ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
  OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC,
  OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
  SCHEDULED_REFRESH_SECURITY_PROBE_RPC,
  SCHEDULED_REFRESH_SECURITY_VERSION,
} from "./operational-write-security";
import type { Asset, Incident, Recommendation, SourceSnapshot } from "./types";

vi.mock("./supabase", () => ({
  getSupabaseAdminClient: vi.fn(),
  getSupabaseServerClient: vi.fn(),
}));

const bundlePrincipal = { kind: "user" as const, actorId: "10000000-0000-4000-8000-000000000001", organizationId: getDefaultOrganizationId() };
const bundleWriteContext = { actorId: bundlePrincipal.actorId, organizationId: bundlePrincipal.organizationId, expectedRevision: null, operation: "refresh" as const };
const getSupabaseAdminClientMock = vi.mocked(getSupabaseAdminClient);
const getSupabaseServerClientMock = vi.mocked(getSupabaseServerClient);

describe("FireAfter Supabase persistence mapping", () => {
  it.each(["inline", "gzip"])("retains the legacy %s envelope field order used by saved page hashes", format => {
    const original = fixtureBundle("ventura");
    original.sourceSnapshots[0].rawPayload = { note: "x".repeat(format === "gzip" ? 300_000 : 1) };
    const payload = buildSupabasePayload(original, { auditEvents: [], publication: { assetMapEnabled: false, sourceSpatialEnabled: false } });
    const keys = Object.keys(payload.sourceSnapshots[0].raw_payload);
    expect(keys).toEqual(["domainSourceId", "domainIncidentId", "sourceKey", "detail", "sourceTimeBasis", "validUntil", "warnings",
      ...(format === "gzip" ? ["rawPayloadEncoding", "rawPayloadBytes", "rawPayloadHash", "rawPayloadGzip"] : ["rawPayload"]),
      "derivedSignals", "queueReadModel"]);
  });
  it.each([true, false])("retains source and queue semantics with spatial storage enabled=%s", enabled => {
    const original = fixtureBundle("ventura"), source = original.sourceSnapshots[0];
    Object.assign(source, { sourceKey: "tiger-roads", sourceName: "Census TIGERweb", sourceUrl: "https://tigerweb.geo.census.gov/", warnings: ["Saved provider data"],
      rawPayload: { geometryVersion: SOURCE_LINE_GEOMETRY_VERSION, featureCount: 1, inventoryComplete: true,
        features: [{ id: "road-a", sourceKey: "tiger-roads", sourceName: "Census TIGERweb", sourceUrl: "https://tigerweb.geo.census.gov/",
          paths: [[[-119.2, 34.1], [-119.1, 34.2]], [[-119, 34.3], [-118.9, 34.4]]] }] } });
    const options = { assets: [fixtureAsset(original.incident.id)], auditEvents: [], publication: { assetMapEnabled: false, sourceSpatialEnabled: enabled, revision: "ecbd733a-d77e-40c5-b803-3afdf0a1d749" } };
    const payload = buildSupabasePayload(original, options);
    expect(payload.sourceSnapshots[0].raw_payload.rawPayloadEncoding).toBe(enabled ? SOURCE_SPATIAL_ENCODING : undefined);
    const restored = mapSupabaseRowsToBundle(payload);
    expect(restored.sourceSnapshots[0].rawPayload).toEqual(source.rawPayload);
    const legacy = buildSupabasePayload(original, { ...options, publication: { ...options.publication, sourceSpatialEnabled: false } });
    expect(restored.sourceSnapshots).toEqual(mapSupabaseRowsToBundle(legacy).sourceSnapshots);
    expect(readQueueSourceModel(queueSourceProjection(payload.sourceSnapshots[0]))).toEqual(readQueueSourceModel(queueSourceProjection(legacy.sourceSnapshots[0])));
    expect(restored.recommendations).toEqual(mapSupabaseRowsToBundle(legacy).recommendations);
  });
  it("keeps an invalid source's original evidence and warning instead of publishing empty spatial coverage", () => {
    const original = fixtureBundle("ventura"), source = original.sourceSnapshots[0];
    source.sourceKey = "tiger-roads";
    source.rawPayload = { geometryVersion: "legacy", features: [{ id: "road-a", coordinates: [[-119, 34], [-118, 35]] }] };
    const payload = buildSupabasePayload(original, { auditEvents: [], assets: [fixtureAsset(original.incident.id)], publication: { assetMapEnabled: false, sourceSpatialEnabled: true } });
    expect(payload.sourceSnapshots[0].raw_payload.rawPayloadEncoding).toBeUndefined();
    const restored = mapSupabaseRowsToBundle(payload).sourceSnapshots[0];
    expect(restored.rawPayload).toEqual(source.rawPayload);
    expect(restored.coverageStatus).toBe("not_available");
  });
  it("retains provider-error diagnostics when hydrating a failed line acquisition", () => {
    const original = fixtureBundle("ventura");
    original.sourceSnapshots[0] = { ...original.sourceSnapshots[0], sourceKey: "3dhp-flowlines",
      status: "offline", stale: true, coverageStatus: "error", detail: "The provider could not supply the inventory.",
      warnings: ["No replacement values were used."],
      rawPayload: { available: false, status: "error", reason: "provider_error", inventoryComplete: false },
    };
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    const restored = mapSupabaseRowsToBundle(payload);
    expect(restored.sourceSnapshots[0]).toMatchObject({ status: "offline", stale: true,
      coverageStatus: "error", detail: original.sourceSnapshots[0].detail });
    expect(restored.sourceSnapshots[0].warnings).toContain(SOURCE_LINE_UNAVAILABLE_WARNING);
    expect(restored.sourceSnapshots[0].detail).not.toContain("legacy");
  });
  it("restores deterministic tied queue positions rather than database row order", () => {
    const original = fixtureBundle("ventura");
    const assets = ["Zulu", "Alpha", "Bravo"].map(name => ({
      ...fixtureAsset(original.incident.id), id: `asset-${name}`, name: `${name} bridge`,
    }));
    original.recommendations = assets.map(asset => ({ ...original.recommendations[0],
      id: `rec-${asset.id}`, assetId: asset.id, assetName: asset.name, riskLevel: "Unknown", score100: 0,
    }));
    const payload = buildSupabasePayload(original, { assets, auditEvents: [] });
    expect(mapSupabaseRowsToBundle(payload).recommendations.map(row => row.assetName))
      .toEqual(["Alpha bridge", "Bravo bridge", "Zulu bridge"]);
    payload.recommendations.reverse();
    expect(mapSupabaseRowsToBundle(payload).recommendations.map(row => row.assetName))
      .toEqual(["Alpha bridge", "Bravo bridge", "Zulu bridge"]);
  });
  it("binds both page orders to the real persisted mapper, including uploads, aliases and legacy risk", () => {
    const original = fixtureBundle("ventura");
    const assets = ["Zulu", "Alpha", "Bravo", "Delta"].map((name, index) => ({ ...fixtureAsset(original.incident.id),
      id: `asset-${name}`, name: `${name} bridge`, type: "Bridge" as const,
      ...(index === 1 ? { localOrUploaded: true, origin: "uploaded" as const, sourceKey: "local-upload" } : {}) }));
    original.recommendations = assets.map((asset, index) => ({ ...original.recommendations[0], id: `rec-${asset.id}`,
      assetId: asset.id, assetName: asset.name, score100: [95, 30, 20, 80][index], riskLevel: "High",
      scoreBreakdown: { ...original.recommendations[0].scoreBreakdown, scoringVersion: index === 3 ? "legacy" : SCORING_VERSION } }));
    const payload = buildSupabasePayload(original, { assets, write: { ...bundleWriteContext,
      rowIds: { asset: {}, source: {}, recommendation: { "rec-asset-Zulu": "80000000-0000-4000-8000-000000000008" } } } });
    const mapped = mapSupabaseRowsToBundle(payload);
    const inventory = parseInventoryManifest(payload.incident.selected_fire.inventoryManifest)!;
    expect(inventory.queueIndex!.current).toBeNull();
    expect(payload.recommendations.map(row => [row.score_breakdown.domainRecommendationId, row.score_100, row.risk_level, row.score_breakdown.scoringVersion]))
      .toEqual(original.recommendations.map(row => [row.id, row.score100, row.riskLevel, row.scoreBreakdown.scoringVersion]));
    expect(payload.recommendations[0].id).toBe("80000000-0000-4000-8000-000000000008");
    const rowIds = new Map(payload.recommendations.map(row => [row.score_breakdown.domainRecommendationId, row.id]));
    for (const [state, recommendations] of [["current", mapped.recommendations], ["expired", projectRecommendationFreshness(mapped.recommendations, [], new Date())]] as const) {
      expect(queueReadPageIds(inventory, { revision: inventory.revision, state, start: 0, limit: 50 })).toEqual(recommendations.map(row => rowIds.get(row.id)));
    }
    expect(mapped.recommendations.filter(row => row.riskLevel === "Unknown").map(row => row.assetId)).toEqual(["asset-Delta", "asset-Alpha"]);
  });
  it("hydrates every coordinate from a compressed large source snapshot", () => {
    const original = fixtureBundle("ventura");
    const geometry = Array.from({ length: 20000 }, (_, id) => [id, -120.123456789, 48.123456789]);
    original.sourceSnapshots[0].rawPayload = { ...original.sourceSnapshots[0].rawPayload, retainedGeometry: geometry };
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    expect(payload.sourceSnapshots[0].raw_payload.rawPayloadEncoding).toBe("gzip-json-v1");
    const restored = mapSupabaseRowsToBundle(payload);
    expect(restored.sourceSnapshots[0].rawPayload?.retainedGeometry).toEqual(geometry);
  });
  it.each([{ note: "FireAfter browser smoke" }, { non_operational: true }])(
    "excludes late markers inside compressed current sources from membership and identity: %j", (marker) => {
      const original = fixtureBundle("ventura");
      const source = original.sourceSnapshots[0];
      source.rawPayload = { retainedGeometry: Array.from({ length: 20000 }, (_, i) => [i, -120.123456789, 35.123456789]), marker };
      const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
      expect(payload.sourceSnapshots[0].raw_payload.rawPayloadEncoding).toBe("gzip-json-v1");
      const restored = mapSupabaseRowsToBundle(payload);
      expect(restored.sourceSnapshots.some(row => row.id === source.id)).toBe(false);
      expect(restored.persistence.rowIds.source[source.id]).toBeUndefined();
      expect(restored.assets).toHaveLength(1);
      expect(restored.sourceSnapshots).toHaveLength(original.sourceSnapshots.length - 1);
    },
  );
  it("does not decode retired source geometry while retaining its historical identity", () => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    const retiredId = "80000000-0000-4000-8000-000000000008";
    payload.sourceSnapshots.push({ ...payload.sourceSnapshots[0], id: retiredId,
      raw_payload: { ...payload.sourceSnapshots[0].raw_payload, domainSourceId: "retired-source",
        rawPayloadEncoding: "gzip-json-v1", rawPayloadBytes: 64 * 1024 * 1024,
        rawPayloadHash: "invalid-retired-hash", rawPayloadGzip: "not-a-current-payload" },
    });
    const restored = mapSupabaseRowsToBundle(payload);
    expect(restored.sourceSnapshots).toHaveLength(original.sourceSnapshots.length);
    expect(restored.sourceSnapshots.some(source => source.id === "retired-source")).toBe(false);
    expect(restored.persistence.rowIds.source["retired-source"]).toBe(retiredId);
  });
  it("still rejects a corrupt compressed payload selected by the current manifest", () => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    Object.assign(payload.sourceSnapshots[0].raw_payload, { rawPayloadEncoding: "gzip-json-v1",
      rawPayloadBytes: 1024, rawPayloadHash: "invalid", rawPayloadGzip: "not-a-current-payload" });
    expect(() => mapSupabaseRowsToBundle(payload)).toThrow();
  });
  it.each(["incident", "recommendation"] as const)("FA10-I2 routing resolves UUID-shaped %s aliases and enforces real authorization", async (kind) => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    const alias = "90000000-0000-4000-8000-000000000009";
    if (kind === "incident") payload.incident.selected_fire.domainIncidentId = alias;
    else payload.recommendations[0].score_breakdown.domainRecommendationId = alias;
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident], recommendations: payload.recommendations,
      assets: payload.assets, source_snapshots: payload.sourceSnapshots, responder_actions: [], audit_events: [],
      organization_members: [{ user_id: bundlePrincipal.actorId, organization_id: bundlePrincipal.organizationId, role: "incident_commander" }] };
    const rpc = vi.fn(async (name, args) => commandReceipt(name, args));
    const client = { from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc,
      auth: { getUser: async () => ({ data: { user: { id: bundlePrincipal.actorId } }, error: null }) } };
    getSupabaseAdminClientMock.mockReturnValue(client as never);
    getSupabaseServerClientMock.mockResolvedValue(client as never);
    const authorize = kind === "incident" ? requireIncidentAccess : requireRecommendationAccess;
    await expect(authorize(alias)).resolves.toMatchObject({ id: bundlePrincipal.actorId });
    if (kind === "incident") await expect(getSupabaseIncidentBundle(alias)).resolves.toMatchObject({ persistence: { databaseIncidentId: payload.incident.id } });
    else {
      await expect(recordSupabaseAction({ ...commandContext(payload.incident), recommendationId: alias, action: "annotate", note: "Alias review", actorName: "Test operator" }))
        .resolves.toMatchObject({ recommendationId: alias });
      expect(rpc.mock.calls.at(-1)![1]).toMatchObject({
        p_request: { recommendationId: payload.recommendations[0].id },
        p_action: { recommendation_id: payload.recommendations[0].id },
      });
    }
    payload.incident.organization_id = "80000000-0000-4000-8000-000000000008";
    await expect(authorize(alias)).rejects.toMatchObject({ status: 403 });
  });

  it.each(["incident", "recommendation"] as const)("FA10-I2 routing rejects cross-namespace %s collisions before commands", async (kind) => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    const alias = "90000000-0000-4000-8000-000000000009";
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident], recommendations: payload.recommendations };
    if (kind === "incident") {
      payload.incident.selected_fire.domainIncidentId = alias;
      db.incidents.push({ ...payload.incident, id: alias, selected_fire: { domainIncidentId: "different-incident" } });
    } else {
      payload.recommendations[0].score_breakdown.domainRecommendationId = alias;
      db.recommendations.push({ ...payload.recommendations[0], id: alias, score_breakdown: { domainRecommendationId: "different-recommendation" } });
    }
    const rpc = vi.fn();
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    const lookup = kind === "incident" ? getIncidentAuthorizationContext : getRecommendationAuthorizationContext;
    await expect(lookup(alias)).rejects.toMatchObject({ code: "read_invalid" });
    if (kind === "incident") await expect(getSupabaseIncidentBundle(alias)).rejects.toMatchObject({ code: "read_invalid" });
    else await expect(recordSupabaseAction({ ...commandContext(payload.incident), recommendationId: alias, action: "annotate", note: "No misrouting", actorName: "Test operator" })).rejects.toMatchObject({ code: "read_invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["incident", "recommendation"] as const)("FA10-I2 routing permits identical database and alias %s identities", async (kind) => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    payload.incident.selected_fire.domainIncidentId = payload.incident.id;
    payload.recommendations[0].score_breakdown.domainRecommendationId = payload.recommendations[0].id;
    const db = { incidents: [payload.incident], recommendations: payload.recommendations };
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }) } as never);
    const lookup = kind === "incident" ? getIncidentAuthorizationContext : getRecommendationAuthorizationContext;
    await expect(lookup(kind === "incident" ? payload.incident.id : payload.recommendations[0].id)).resolves.toMatchObject({ organizationId: payload.incident.organization_id });
  });

  it("FA10-I2 routing rejects duplicate non-UUID incident aliases instead of selecting the newest", async () => {
    const payload = buildSupabasePayload(fixtureBundle("ventura"), { assets: [], auditEvents: [] });
    const db = { incidents: [payload.incident, { ...payload.incident, id: "90000000-0000-4000-8000-000000000009" }] };
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }) } as never);
    await expect(getSupabaseIncidentBundle(payload.incident.selected_fire.domainIncidentId as string)).rejects.toMatchObject({ code: "read_invalid" });
  });

  it.each(["incident", "recommendation"] as const)("FA10-I2 routing fails closed when the %s alias query is unavailable", async (kind) => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    const db = { incidents: [payload.incident], recommendations: payload.recommendations };
    const rpc = vi.fn();
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => ({
      ...createReadBuilder(table, db), contains: () => ({ maybeSingle: async () => ({ data: null, error: { code: "08006" } }) }),
    }) }), rpc } as never);
    const lookup = kind === "incident" ? getIncidentAuthorizationContext : getRecommendationAuthorizationContext;
    await expect(lookup(kind === "incident" ? payload.incident.id : payload.recommendations[0].id)).rejects.toMatchObject({ code: "08006" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("FA10-I2 routing rejects duplicate recommendation aliases", async () => {
    const payload = buildSupabasePayload(fixtureBundle("ventura"), { auditEvents: [] });
    const db = { recommendations: [payload.recommendations[0], { ...payload.recommendations[0], id: "90000000-0000-4000-8000-000000000009" }] };
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }) } as never);
    await expect(getRecommendationAuthorizationContext(payload.recommendations[0].score_breakdown.domainRecommendationId as string))
      .rejects.toMatchObject({ code: "read_invalid" });
  });

  it("FA10-I2 routing keeps internal database keys explicit when another record shadows them", async () => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    const otherId = "90000000-0000-4000-8000-000000000009";
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [payload.incident, { ...payload.incident, id: otherId, selected_fire: { domainIncidentId: payload.incident.id } }],
      recommendations: [...payload.recommendations, { ...payload.recommendations[0], id: otherId, incident_id: otherId,
        score_breakdown: { domainRecommendationId: payload.recommendations[0].id } }],
      assets: payload.assets, source_snapshots: payload.sourceSnapshots, responder_actions: [], audit_events: [],
    };
    const rpc = vi.fn(async (name, args) => {
      if (name !== ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC && name !== IMPORT_COMMIT_RPC) return commandReceipt(name, args);
      db.incidents[0] = args.p_incident;
      return name === IMPORT_COMMIT_RPC ? commandReceipt(name, args) : { data: null, error: null };
    });
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    const mapped = mapSupabaseRowsToBundle(payload);
    await expect(persistBundleToSupabase(mapped, { assets: mapped.assets, auditEvents: [], write: { ...bundleWriteContext, ...mapped.persistence } }))
      .resolves.toMatchObject({ persistence: { databaseIncidentId: payload.incident.id } });
    await expect(recordSupabaseAction({ ...commandContext(db.incidents[0]), recommendationId: original.recommendations[0].id,
      action: "annotate", note: "Internal identity preserved", actorName: "Test operator" })).resolves.toMatchObject({ recommendationId: original.recommendations[0].id });
  });

  it("FA10-I2 retains historical identities without restoring retired inventory", () => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    const retainedId = "80000000-0000-4000-8000-000000000008";
    payload.recommendations[0].id = retainedId;
    const retired = { ...payload, incident: { ...payload.incident, selected_fire: { ...payload.incident.selected_fire,
      inventoryManifest: { ...(payload.incident.selected_fire.inventoryManifest as object), assetIds: [], recommendationIds: [], sourceSnapshotIds: [], queueIndex: createQueueReadIndex([]) },
    } } };
    const before = structuredClone(retired);
    const current = mapSupabaseRowsToBundle(retired);
    expect(current.assets).toEqual([]);
    expect(current.recommendations).toEqual([]);
    const reintroduced = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [], write: { ...bundleWriteContext, ...current.persistence } });
    expect(reintroduced.recommendations[0].id).toBe(retainedId);
    expect(retired).toEqual(before);
  });

  it("FA10-I2 rejects a reserved persisted child alias instead of dropping it", () => {
    const bundle = fixtureBundle("ventura");
    const payload = buildSupabasePayload(bundle, { assets: [fixtureAsset(bundle.incident.id)], auditEvents: [] });
    payload.assets[0].properties.domainAssetId = "__proto__";
    expect(() => mapSupabaseRowsToBundle(payload)).toThrow(/inventory/i);
  });

  it("FA10-I2 rejects ambiguous child aliases instead of overwriting their database identity", () => {
    const bundle = fixtureBundle("ventura");
    const first = fixtureAsset(bundle.incident.id);
    const payload = buildSupabasePayload(bundle, { assets: [first, { ...first, id: "second-asset" }], auditEvents: [] });
    payload.assets[1].properties.domainAssetId = first.id;
    expect(() => mapSupabaseRowsToBundle(payload)).toThrow(/inventory/i);
  });
  it.each([false, true])("FA10-I2 reads back the committed database incident, not a UUID-shaped domain alias: %s", async (aliasOccupied) => {
    const original = { ...fixtureBundle("ventura"), recommendations: [], sourceSnapshots: [] };
    const payload = buildSupabasePayload(original, { assets: [], auditEvents: [] });
    const alias = "90000000-0000-4000-8000-000000000009";
    payload.incident.selected_fire.domainIncidentId = alias;
    const mapped = mapSupabaseRowsToBundle(payload);
    const other = { ...payload.incident, id: alias, selected_fire: { ...payload.incident.selected_fire, domainIncidentId: "other-incident" } };
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident, ...(aliasOccupied ? [other] : [])], assets: [], recommendations: [], source_snapshots: [], responder_actions: [], audit_events: [] };
    const rpc = vi.fn(async (_name, args) => {
      db.incidents = db.incidents.map((row) => row.id === args.p_incident.id ? args.p_incident : row);
      return { error: null };
    });
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    await expect(persistBundleToSupabase(mapped, { assets: [], auditEvents: [], write: { ...bundleWriteContext, ...mapped.persistence } })).resolves.toMatchObject({
      incident: { id: alias }, persistence: { databaseIncidentId: payload.incident.id, organizationId: payload.incident.organization_id },
    });
  });

  it("FA10-I2 retains legacy child database IDs through import, reload and a real command serialization", async () => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    delete payload.assets[0].properties.domainAssetId;
    delete payload.recommendations[0].score_breakdown.domainRecommendationId;
    for (const source of payload.sourceSnapshots) delete source.raw_payload.domainSourceId;
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident], assets: payload.assets, recommendations: payload.recommendations, source_snapshots: payload.sourceSnapshots, responder_actions: [], audit_events: [] };
    const rpc = vi.fn(async (name, args) => {
      if (name !== ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC && name !== IMPORT_COMMIT_RPC) return commandReceipt(name, args);
      db.incidents = [args.p_incident];
      for (const [table, incoming] of [["assets", args.p_assets], ["recommendations", args.p_recommendations], ["source_snapshots", args.p_source_snapshots]] as const) {
        const rows = new Map(db[table].map((row) => [row.id, row]));
        for (const row of incoming) rows.set(row.id, row);
        db[table] = [...rows.values()];
      }
      db.audit_events.push(...args.p_audit_events);
      return name === IMPORT_COMMIT_RPC ? commandReceipt(name, args) : { data: null, error: null };
    });
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    const prepared = await getSupabaseIncidentBundle(original.incident.id);
    await persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal, persistence: prepared!.persistence, incidentId: original.incident.id, assets: [],
      auditEvent: { id: "legacy-import", incidentId: original.incident.id, eventType: "AssetsImported", actorName: "Test operator", createdAt: "2026-09-14T00:00:00Z", summary: "Retained inventory import", payload: {} },
    });
    expect(db.assets.map((row) => row.id)).toEqual(payload.assets.map((row) => row.id));
    expect(db.recommendations.map((row) => row.id)).toEqual(payload.recommendations.map((row) => row.id));
    expect(db.source_snapshots.map((row) => row.id)).toEqual(payload.sourceSnapshots.map((row) => row.id));
    const reloaded = await getSupabaseIncidentBundle(original.incident.id);
    expect(reloaded!.recommendations).toEqual([]);
    const refreshed = await persistBundleToSupabase({ ...reloaded!, recommendations: prepared!.recommendations }, {
      assets: reloaded!.assets, auditEvents: [], write: { ...bundleWriteContext, ...reloaded!.persistence },
    });
    expect(refreshed!.recommendations[0].id).toBe(payload.recommendations[0].id);
    const result = await recordSupabaseAction({ ...commandContext(db.incidents[0]), recommendationId: refreshed!.recommendations[0].id, action: "annotate", note: "Round trip review", actorName: "Test operator" });
    expect(result?.recommendationSnapshot.assetId).toBe(payload.assets[0].id);
    expect(rpc.mock.calls.at(-1)![1]).toMatchObject({ p_action: { recommendation_id: payload.recommendations[0].id } });
  });

  it.each(["missing aliases", "conflicting aliases", "legacy parents"])("FA10-I2 binds current recommendation and command snapshots to their validated parents: %s", async (scenario) => {
    const bundle = fixtureBundle("ventura");
    const payload = buildSupabasePayload(bundle, { assets: [fixtureAsset(bundle.incident.id)], auditEvents: [] });
    const breakdown = payload.recommendations[0].score_breakdown;
    if (scenario === "legacy parents") {
      delete payload.incident.selected_fire.domainIncidentId;
      delete payload.assets[0].properties.domainAssetId;
      // This predates versioned projections, which bind the original parent alias.
      delete (payload.incident.selected_fire.inventoryManifest as { sourceQueueVersion?: string }).sourceQueueVersion;
    } else if (scenario === "missing aliases") {
      delete breakdown.domainIncidentId;
      delete breakdown.domainAssetId;
    } else {
      breakdown.domainIncidentId = "unrelated-incident";
      breakdown.domainAssetId = "unrelated-asset";
    }
    const incidentId = scenario === "legacy parents" ? payload.incident.id : bundle.incident.id;
    const assetId = scenario === "legacy parents" ? payload.assets[0].id : bundle.recommendations[0].assetId;
    const before = structuredClone(payload);
    const mapped = mapSupabaseRowsToBundle(payload);
    expect(mapped.recommendations[0]).toMatchObject({ incidentId, assetId });
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident], assets: payload.assets, recommendations: payload.recommendations, source_snapshots: payload.sourceSnapshots, responder_actions: [], audit_events: [] };
    const rpc = vi.fn(commandReceipt);
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    await recordSupabaseAction({ ...commandContext(payload.incident), recommendationId: payload.recommendations[0].id, action: "annotate", note: "Parent identity review", actorName: "Test operator" });
    expect(rpc.mock.calls.at(-1)![1]).toMatchObject({
      p_action: { recommendation_snapshot: { incidentId, assetId }, recommendation_id: payload.recommendations[0].id },
      p_audit_event: { incident_id: payload.incident.id, payload: { recommendationSnapshot: { incidentId, assetId } } },
    });
    expect(payload).toEqual(before);
  });

  it.each([
    { change: { databaseIncidentId: undefined }, code: "FB400" },
    { change: { databaseIncidentId: "not-a-uuid" }, code: "FB400" },
    { change: { databaseIncidentId: "90000000-0000-4000-8000-000000000009" }, code: "FB409" },
    { change: { organizationId: "90000000-0000-4000-8000-000000000009" }, code: "FB401" },
  ])("FA10-I1 denies changed or missing preparation identity before RPC: $code / $change", async ({ change, code }) => {
    const bundle = { ...fixtureBundle("ventura"), recommendations: [], sourceSnapshots: [] };
    const payload = buildSupabasePayload(bundle, { assets: [], auditEvents: [] });
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident], assets: [], recommendations: [], source_snapshots: [], responder_actions: [], audit_events: [] };
    const rpc = vi.fn();
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    const persistence = { ...mapSupabaseRowsToBundle(payload).persistence, ...change };
    await expect(persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal, persistence, incidentId: bundle.incident.id, assets: [],
      auditEvent: { id: "identity-denied", incidentId: bundle.incident.id, eventType: "AssetsImported", actorName: "Test operator", createdAt: "2026-09-14T00:00:00Z", summary: "Identity denial", payload: {} },
    })).rejects.toMatchObject({ code });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([false, true])("FA10-I1 sends the original revision to commit without retrying a late conflict: %s", async (conflict) => {
    const bundle = { ...fixtureBundle("ventura"), recommendations: [], sourceSnapshots: [] };
    const payload = buildSupabasePayload(bundle, { assets: [], auditEvents: [] });
    const persistence = mapSupabaseRowsToBundle(payload).persistence;
    const original = structuredClone(persistence);
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident], assets: [], recommendations: [], source_snapshots: [], responder_actions: [], audit_events: [] };
    const rpc = vi.fn(async (_name, args) => {
      if (conflict) return { error: { code: "FB409" } };
      db.incidents = [args.p_incident]; db.audit_events = args.p_audit_events;
      return commandReceipt(_name, args);
    });
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    const result = persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal, persistence, incidentId: bundle.incident.id, assets: [],
      auditEvent: { id: "original-revision", incidentId: bundle.incident.id, eventType: "AssetsImported", actorName: "Test operator", createdAt: "2026-09-14T00:00:00Z", summary: "Original revision", payload: {} },
    });
    if (conflict) await expect(result).rejects.toMatchObject({ code: "FB409" });
    else await expect(result).resolves.toMatchObject({ persistence: original });
    expect(rpc).toHaveBeenCalledExactlyOnceWith(IMPORT_COMMIT_RPC, expect.objectContaining({
      p_expected_revision: original.expectedRevision, p_actor_id: bundlePrincipal.actorId,
      p_incident: expect.objectContaining({ id: original.databaseIncidentId, organization_id: original.organizationId }),
    }));
    expect(persistence).toEqual(original);
  });

  it("FA10-I2 rejects an audit belonging to another incident before serialization", () => {
    const bundle = fixtureBundle("ventura");
    expect(() => buildSupabasePayload(bundle, { assets: [], auditEvents: [{ id: "foreign-audit", incidentId: "unrelated-incident", eventType: "AssetsImported", actorName: "Test operator", createdAt: "2026-09-14T00:00:00Z", summary: "Foreign audit", payload: {} }] })).toThrow(/context is invalid/);
  });

  it("FA10-I2 records a legacy recommendation UUID without hashing its foreign keys again", async () => {
    const bundle = fixtureBundle("ventura");
    const payload = buildSupabasePayload(bundle, { assets: [fixtureAsset(bundle.incident.id)], auditEvents: [] });
    delete payload.recommendations[0].score_breakdown.domainRecommendationId;
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident], assets: payload.assets, recommendations: payload.recommendations, source_snapshots: payload.sourceSnapshots, responder_actions: [], audit_events: [] };
    const rpc = vi.fn(commandReceipt);
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    await recordSupabaseAction({ ...commandContext(payload.incident), recommendationId: payload.recommendations[0].id, action: "annotate", note: "Legacy recommendation review", actorName: "Test operator" });
    const args = rpc.mock.calls.at(-1)![1] as unknown as { p_action: { recommendation_id: string }; p_audit_event: { recommendation_id: string; incident_id: string } };
    expect(args.p_action.recommendation_id).toBe(payload.recommendations[0].id);
    expect(args.p_audit_event.recommendation_id).toBe(payload.recommendations[0].id);
    expect(args.p_audit_event.incident_id).toBe(payload.incident.id);
  });

  it.each([undefined, "incident-legacy-random"])("FA10-I2 preserves an actual database ID instead of hashing its mapped domain identity: %s", (domainId) => {
    const payload = buildSupabasePayload(fixtureBundle("ventura"), { assets: [], actions: [], auditEvents: [] });
    const databaseId = "90000000-0000-4000-8000-000000000009";
    payload.incident.id = databaseId;
    payload.incident.selected_fire = { ...payload.incident.selected_fire, domainIncidentId: domainId };
    delete payload.incident.selected_fire.inventoryManifest;
    const mapped = mapSupabaseRowsToBundle({ incident: payload.incident, assets: [], recommendations: [], sourceSnapshots: [], responderActions: [], auditEvents: [] });
    const wire = buildSupabasePayload(mapped, { assets: [], actions: [], auditEvents: [], write: { ...bundleWriteContext, ...mapped.persistence } });
    expect(wire.incident.id).toBe(databaseId);
  });

  it("FA10-I1 rejects an import whose preparation revision differs from the reread before any RPC", async () => {
    const bundle = { ...fixtureBundle("ventura"), recommendations: [], sourceSnapshots: [] };
    const payload = buildSupabasePayload(bundle, { assets: [], auditEvents: [] });
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident], assets: [], recommendations: [], source_snapshots: [], responder_actions: [], audit_events: [] };
    const rpc = vi.fn(async () => ({ error: { code: "FB409" } }));
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    await expect(persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal,
      persistence: { organizationId: bundlePrincipal.organizationId, databaseIncidentId: payload.incident.id, expectedRevision: "90000000-0000-4000-8000-000000000009" },
      incidentId: bundle.incident.id, assets: [], auditEvent: { id: "import-original", incidentId: bundle.incident.id, eventType: "AssetsImported", actorName: "Test operator", createdAt: "2026-09-14T00:00:00Z", summary: "Test import", payload: {} },
    } as Parameters<typeof persistImportedAssetsToSupabase>[0])).rejects.toMatchObject({ code: "FB409" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("FA10-I2 binds a UUID-alias audit to the database incident without rehashing", () => {
    const bundle = fixtureBundle("ventura");
    const first = buildSupabasePayload(bundle, { assets: [], auditEvents: [] });
    const wire = buildSupabasePayload(bundle, { assets: [], auditEvents: [{ id: "alias-event", incidentId: first.incident.id, eventType: "FireContextSelected", actorName: "Test actor", createdAt: "2026-09-14T00:00:00Z", summary: "Test selection", payload: {} }],
      write: { ...bundleWriteContext, databaseIncidentId: first.incident.id } as typeof bundleWriteContext,
    });
    expect(wire.auditEvents[0].incident_id).toBe(first.incident.id);
  });

  it("FA12 rejects a combined over-budget import before commit and does not double-count replacements", async () => {
    const bundle = { ...fixtureBundle("ventura"), recommendations: [], sourceSnapshots: [] };
    const initial = buildSupabasePayload(bundle, { assets: [] });
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [initial.incident], assets: [], recommendations: [], source_snapshots: [], responder_actions: [], audit_events: [] };
    const rpc = vi.fn(async (_name, payload) => {
      db.incidents = [payload.p_incident]; db.assets = payload.p_assets; db.source_snapshots = payload.p_source_snapshots;
      db.recommendations = payload.p_recommendations; db.audit_events.push(...payload.p_audit_events);
      return commandReceipt(_name, payload);
    });
    getSupabaseAdminClientMock.mockReturnValue({ from(table: string) { return { select() { return createReadBuilder(table, db); } }; }, rpc } as never);
    const polygon = (id: string, x: number): Asset => {
      const ring = Array.from({ length: 500 }, (_, i): [number, number] => [x + 0.01 * Math.cos(i * Math.PI / 250), 34.4 + 0.01 * Math.sin(i * Math.PI / 250)]);
      ring.push([...ring[0]]);
      return { ...fixtureAsset(bundle.incident.id), id, localOrUploaded: true, origin: "uploaded", coordinates: ring[0], geometry: { type: "Polygon", coordinates: [ring] } };
    };
    const first = polygon("polygon-1", -119.2), second = polygon("polygon-2", -119.3);
    const upload = async (asset: Asset) => persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal, persistence: (await getSupabaseIncidentBundle(bundle.incident.id))!.persistence, incidentId: bundle.incident.id, assets: [asset], auditEvent: {
      id: `audit-${asset.id}`, incidentId: bundle.incident.id, eventType: "AssetsImported", actorName: "Test operator", createdAt: "2026-09-14T00:00:00Z", summary: "Test import", payload: {},
    } });
    await upload(first);
    expect(rpc).toHaveBeenCalledTimes(1);
    const before = structuredClone(db);
    await expect(upload(second)).rejects.toMatchObject({ code: "uploaded_geometry_invalid" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(db).toEqual(before);
    expect((await getSupabaseIncidentBundle(bundle.incident.id))?.assets).toHaveLength(1);
    await upload({ ...first, confidence: "High" });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect((await getSupabaseIncidentBundle(bundle.incident.id))?.assets).toHaveLength(1);
  });
  it.each([SCORING_VERSION, undefined])("FA12 projects retained upload confidence without rewriting history: %s", (version) => {
    const bundle = fixtureBundle("ventura");
    bundle.recommendations[0].scoreBreakdown.scoringVersion = version;
    const asset = { ...fixtureAsset(bundle.incident.id), localOrUploaded: true, origin: "uploaded" as const, confidence: "High" as const };
    const action = createResponderAction({ recommendation: bundle.recommendations[0], action: "annotate", note: "Historical decision", actorName: "Test operator" });
    const payload = buildSupabasePayload(bundle, { assets: [asset], actions: [action], auditEvents: [action.auditEvent] });
    const before = structuredClone(payload);
    const mapped = mapSupabaseRowsToBundle({ incident: payload.incident, assets: payload.assets, recommendations: payload.recommendations,
      sourceSnapshots: payload.sourceSnapshots, responderActions: payload.responderActions, auditEvents: payload.auditEvents });
    expect(mapped.assets[0]).toMatchObject({ confidence: "Low", confidenceReason: expect.stringContaining("unverified") });
    expect(mapped.recommendations[0]).toMatchObject({ confidenceLevel: "Low", riskLevel: "Unknown", scoreBreakdown: { scoreBasis: version ? "review-only" : "legacy-unassessed" } });
    expect(mapped.actions[0].recommendationSnapshot).toEqual(before.responderActions[0].recommendation_snapshot);
    expect(payload).toEqual(before);
  });

  it("FA12 rejects malformed retained upload geometry rather than coercing it or returning a partial inventory", () => {
    const bundle = fixtureBundle("ventura");
    const asset = { ...fixtureAsset(bundle.incident.id), localOrUploaded: true, origin: "uploaded" as const };
    const payload = buildSupabasePayload(bundle, { assets: [asset] });
    payload.assets[0].geometry_geojson = { type: "LineString", coordinates: [[-119.22, 34.45], [999, 34.5]] };
    expect(() => mapSupabaseRowsToBundle({ incident: payload.incident, assets: payload.assets, recommendations: payload.recommendations,
      sourceSnapshots: payload.sourceSnapshots, responderActions: [], auditEvents: [] })).toThrow(/correct and reimport/);
  });

  it("FA10 replays the stored decision after inventory refresh without rebuilding its snapshot", async () => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)] });
    const context = commandContext(payload.incident);
    const saved = createResponderAction({ recommendation: original.recommendations[0], action: "annotate",
      note: "Original decision", actorName: "Test operator", createdAt: "2026-09-13T12:00:00Z",
      command: { id: context.commandId, actorId: context.actorId, expectedRevision: context.expectedRevision } });
    const rows = buildSupabasePayload(original, { actions: [saved], auditEvents: [saved.auditEvent] });
    const receipt = { action: { ...rows.responderActions[0], actor_id: context.actorId },
      auditEvent: { ...rows.auditEvents[0], actor_id: context.actorId } };
    const db = { incidents: [payload.incident], recommendations: payload.recommendations };
    (payload.incident.selected_fire.inventoryManifest as { revision: string }).revision = "6c047a7e-a97d-4e6c-9188-b1d6e2de117c";
    const rpc = vi.fn().mockResolvedValue({ data: receipt, error: null });
    const from = vi.fn((table: string) => ({ select: () => createReadBuilder(table, db) }));
    getSupabaseAdminClientMock.mockReturnValue({ from, rpc } as never);
    const input = { ...context, recommendationId: original.recommendations[0].id,
      action: "annotate" as const, note: "Original decision", actorName: "Test operator" };
    const result = await recordSupabaseAction(input);
    expect(result?.id).toBe(saved.id);
    expect(result?.createdAt).toBe(saved.createdAt);
    expect(result?.auditEvent.id).toBe(saved.auditEvent.id);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_action: null, p_audit_event: null });
    expect(from.mock.calls.some(([table]) => table === "assets" || table === "source_snapshots")).toBe(false);
    receipt.auditEvent.payload.commandId = "other-command";
    await expect(recordSupabaseAction(input)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("FA10 publishes the persisted inventory revision and preserves distinct same-time command pairs", () => {
    const original = fixtureBundle("ventura");
    const context = { actorId: "00000000-0000-4000-8000-000000000001", expectedRevision: "0ca1f8d8-a8bb-440a-a4bf-ddbbf31a0069" };
    const actions = ["d5554057-33bc-4e55-8d4a-2a4421eab174", "5d97e218-7fbc-4fb9-bd89-e0786778bde6"].map((id) =>
      createResponderAction({ recommendation: original.recommendations[0], action: "accept", note: "Same note",
        actorName: "Test operator", createdAt: "2026-09-13T12:00:00Z", command: { ...context, id } }));
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], actions,
      auditEvents: actions.map((action) => action.auditEvent) });
    const result = mapSupabaseRowsToBundle(payload);
    expect(result.recommendations[0].inventoryRevision).toBe((payload.incident.selected_fire.inventoryManifest as { revision: string }).revision);
    expect(result.actions).toHaveLength(2);
    for (const action of result.actions) expect(action.auditEvent.id).toBe(action.id.replace("action-command-", "audit-command-"));
  });
  it("binds each complete payload to a unique current-inventory generation", () => {
    const original = fixtureBundle("ventura");
    const first = buildSupabasePayload(original);
    const second = buildSupabasePayload(original);
    expect(first.incident.selected_fire.inventoryManifest).toEqual({
      version: "2026-09-13-inventory-v1",
      revision: expect.any(String),
      assetIds: first.assets.map((row) => row.id),
      recommendationIds: first.recommendations.map((row) => row.id),
      sourceSnapshotIds: first.sourceSnapshots.map((row) => row.id),
      queueIndex: createQueueReadIndex(original.recommendations),
      sourceQueueVersion: QUEUE_SOURCE_VERSION,
    });
    expect(second.incident.selected_fire.inventoryManifest).not.toEqual(first.incident.selected_fire.inventoryManifest);
  });

  it("excludes retired assets and recommendations while retaining their historical decisions", () => {
    const original = fixtureBundle("ventura");
    const retiredAsset = { ...fixtureAsset(original.incident.id), id: "retired-asset" };
    const retiredRecommendation = { ...original.recommendations[0], id: "retired-recommendation", assetId: retiredAsset.id };
    const action = createResponderAction({ recommendation: retiredRecommendation, action: "annotate", note: "Historical fixture", actorName: "Fixture reviewer" });
    const retired = buildSupabasePayload({ ...original, recommendations: [retiredRecommendation] }, { assets: [retiredAsset], actions: [action], auditEvents: [action.auditEvent] });
    const current = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)] });
    const result = mapSupabaseRowsToBundle({ ...current,
      assets: [...current.assets, ...retired.assets], recommendations: [...current.recommendations, ...retired.recommendations],
      responderActions: retired.responderActions, auditEvents: retired.auditEvents,
    });
    expect(result.assets.map((asset) => asset.id)).toEqual([original.recommendations[0].assetId]);
    expect(result.recommendations.map((recommendation) => recommendation.id)).toEqual([original.recommendations[0].id]);
    expect(result.actions[0].recommendationSnapshot.id).toBe(retiredRecommendation.id);
    expect(result.auditEvents[0].recommendationId).toBe(retiredRecommendation.id);
    expect(result.incident.selectedFire).not.toHaveProperty("inventoryManifest");
  });

  it("withholds legacy inventory while preserving uploads for an authorized recovery refresh", () => {
    const original = fixtureBundle("ventura");
    const uploaded = { ...fixtureAsset(original.incident.id), id: "local-upload", localOrUploaded: true, origin: "uploaded" as const };
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id), uploaded] });
    delete payload.incident.selected_fire.inventoryManifest;
    const result = mapSupabaseRowsToBundle(payload);
    expect(result.assets.map((asset) => asset.id)).toEqual([uploaded.id]);
    expect(result.recommendations).toEqual([]);
    expect(result.sourceSnapshots).toEqual([]);
    expect(result.incident.status).toBe("Stale Data");
    expect(result.incident.lastRefresh).toContain("authorized refresh");
  });

  it("does not hide ambiguous current sources behind latest-timestamp deduplication", () => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload({ ...original, sourceSnapshots: [original.sourceSnapshots[0],
      { ...original.sourceSnapshots[0], id: "second-current-source", fetchedAt: "2026-06-27T14:25:00.000Z" }] });
    const result = mapSupabaseRowsToBundle(payload);
    expect(result.sourceSnapshots).toHaveLength(2);
    expect(result.sourceSnapshots.map((source) => source.id)).toContain("second-current-source");
  });

  it.each(["assets", "recommendations", "sourceSnapshots"] as const)("rejects a missing current %s row instead of exposing a partial bundle", (collection) => {
    const payload = buildSupabasePayload(fixtureBundle("ventura"));
    payload[collection] = [];
    expect(() => mapSupabaseRowsToBundle(payload)).toThrow(/inventory/i);
  });

  it.each(["assets", "recommendations", "sourceSnapshots"] as const)("rejects duplicate or foreign current %s identities", (collection) => {
    const payload = buildSupabasePayload(fixtureBundle("ventura"));
    const duplicate = structuredClone(payload);
    duplicate[collection].push(duplicate[collection][0] as never);
    expect(() => mapSupabaseRowsToBundle(duplicate)).toThrow(/inventory/i);
    payload[collection][0].incident_id = "foreign-incident";
    expect(() => mapSupabaseRowsToBundle(payload)).toThrow(/inventory/i);
  });

  it("rejects a refresh generation change even when all table counts stay identical", async () => {
    const original = fixtureBundle("ventura");
    const first = buildSupabasePayload(original);
    const next = buildSupabasePayload(original);
    const db = { incidents: [first.incident], assets: first.assets, recommendations: first.recommendations, source_snapshots: first.sourceSnapshots };
    getSupabaseAdminClientMock.mockReturnValue({ from(table: string) {
      if (table === "assets") db.incidents = [next.incident];
      return { select() { return createReadBuilder(table, db); } };
    } } as never);
    await expect(getSupabaseIncidentBundle(original.incident.id)).rejects.toMatchObject({ code: "read_generation" });
  });

  it("reuses only source rows while rereading incidents, inventory and newly recorded history", async () => {
    const { original, payload, db, queryLog } = sourceCacheFixture();
    const first = await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    const sourceQueries = queryLog.filter(entry => entry.table === "source_snapshots").length;
    expect(sourceQueries).toBeGreaterThan(0);
    const action = createResponderAction({ recommendation: original.recommendations[0], action: "annotate",
      note: "Cache test only", actorName: "Fixture reviewer" });
    const history = buildSupabasePayload(original, { actions: [action], auditEvents: [action.auditEvent] });
    db.responder_actions = history.responderActions;
    db.audit_events = history.auditEvents;
    const previousQueryCount = queryLog.length;
    const second = await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    expect(second?.sourceSnapshots).toEqual(first?.sourceSnapshots);
    expect(second?.actions[0].note).toBe("Cache test only");
    expect(second?.auditEvents[0]).toMatchObject({ id: history.auditEvents[0].id,
      summary: action.auditEvent.summary, eventType: action.auditEvent.eventType });
    expect(queryLog.filter(entry => entry.table === "source_snapshots")).toHaveLength(sourceQueries);
    const freshTables = new Set(queryLog.slice(previousQueryCount).map(entry => entry.table));
    for (const table of ["incidents", "assets", "recommendations", "responder_actions", "audit_events"]) {
      expect(freshTables.has(table)).toBe(true);
    }
    expect(db.incidents[0]).toEqual(payload.incident);
  });

  it("bypasses source reuse by default and on database-ID write/recovery reads", async () => {
    const { original, payload, db, queryLog } = sourceCacheFixture();
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    const initialQueries = queryLog.filter(entry => entry.table === "source_snapshots").length;
    (db.source_snapshots[0].raw_payload as Record<string, unknown>).detail = "Changed outside a revision";
    const uncached = await getSupabaseIncidentBundle(original.incident.id);
    const recovery = await getSupabaseIncidentBundleByDatabaseId(payload.incident.id);
    expect(uncached?.sourceSnapshots[0].detail).toBe("Changed outside a revision");
    expect(recovery?.sourceSnapshots[0].detail).toBe("Changed outside a revision");
    expect(queryLog.filter(entry => entry.table === "source_snapshots")).toHaveLength(initialQueries * 3);
  });

  it("expires source reuse after fifteen seconds without extending it on a hit", async () => {
    const { original, db, queryLog } = sourceCacheFixture();
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    try {
      await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
      const initialQueries = queryLog.filter(entry => entry.table === "source_snapshots").length;
      (db.source_snapshots[0].raw_payload as Record<string, unknown>).detail = "Updated source detail";
      now.mockReturnValue(15_999);
      const hit = await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
      expect(hit?.sourceSnapshots[0].detail).toBe(original.sourceSnapshots[0].detail);
      expect(queryLog.filter(entry => entry.table === "source_snapshots")).toHaveLength(initialQueries);
      now.mockReturnValue(16_000);
      const expired = await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
      expect(expired?.sourceSnapshots[0].detail).toBe("Updated source detail");
      expect(queryLog.filter(entry => entry.table === "source_snapshots")).toHaveLength(initialQueries * 2);
    } finally { now.mockRestore(); }
  });

  it.each(["revision", "organization", "incident-field"])("invalidates source reuse when the %s changes", async mode => {
    const { original, payload, db, queryLog } = sourceCacheFixture();
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    const initialQueries = queryLog.filter(entry => entry.table === "source_snapshots").length;
    if (mode === "revision") {
      db.incidents = [buildSupabasePayload(original).incident];
    } else if (mode === "organization") {
      db.incidents = [{ ...payload.incident, organization_id: "10000000-0000-4000-8000-000000000002" }];
    } else {
      db.incidents = [{ ...payload.incident, title: "Updated incident title" }];
    }
    (db.source_snapshots[0].raw_payload as Record<string, unknown>).detail = "New generation source detail";
    const next = await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    expect(next?.sourceSnapshots[0].detail).toBe("New generation source detail");
    expect(queryLog.filter(entry => entry.table === "source_snapshots")).toHaveLength(initialQueries * 2);
  });

  it("still rejects and evicts a cache hit if the incident changes during the read", async () => {
    const { original, payload, db, from, queryLog } = sourceCacheFixture();
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    from.mockImplementation((table: string) => {
      if (table === "assets") db.incidents = [buildSupabasePayload(original).incident];
      return { select: () => createReadBuilder(table, db, queryLog) };
    });
    await expect(getSupabaseIncidentBundle(original.incident.id, { sourceCache: true }))
      .rejects.toMatchObject({ code: "read_generation" });
    from.mockImplementation((table: string) => ({ select: () => createReadBuilder(table, db, queryLog) }));
    db.incidents = [payload.incident];
    (db.source_snapshots[0].raw_payload as Record<string, unknown>).detail = "Reread after eviction";
    const result = await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    expect(result?.sourceSnapshots[0].detail).toBe("Reread after eviction");
  });

  it("does not share cached source rows between clients or incidents", async () => {
    const { original, db, from, queryLog } = sourceCacheFixture();
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    const other = fixtureBundle("boulder");
    const next = buildSupabasePayload(other, { assets: [fixtureAsset(other.incident.id)] });
    db.incidents.push(next.incident);
    db.assets.push(...next.assets);
    db.recommendations.push(...next.recommendations);
    db.source_snapshots.push(...next.sourceSnapshots);
    const second = await getSupabaseIncidentBundle(other.incident.id, { sourceCache: true });
    expect(second?.sourceSnapshots[0].incidentId).toBe(other.incident.id);
    const queryCount = queryLog.filter(entry => entry.table === "source_snapshots").length;
    getSupabaseAdminClientMock.mockReturnValue({ from } as never);
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    expect(queryLog.filter(entry => entry.table === "source_snapshots").length).toBeGreaterThan(queryCount);
  });

  it("does not let caller mutation poison cached source data", async () => {
    const { original } = sourceCacheFixture();
    const first = await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    first!.sourceSnapshots[0].detail = "Caller mutation";
    first!.sourceSnapshots[0].rawPayload!.detail = "Nested caller mutation";
    const second = await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    expect(second?.sourceSnapshots[0].detail).toBe(original.sourceSnapshots[0].detail);
    expect(second?.sourceSnapshots[0].rawPayload?.detail).not.toBe("Nested caller mutation");
  });

  it("does not cache rows that fail inventory verification", async () => {
    const { original, payload, db, queryLog } = sourceCacheFixture();
    db.source_snapshots = [];
    await expect(getSupabaseIncidentBundle(original.incident.id, { sourceCache: true })).rejects.toThrow(/inventory/i);
    db.source_snapshots = payload.sourceSnapshots;
    const queriesAfterFailure = queryLog.filter(entry => entry.table === "source_snapshots").length;
    const result = await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    expect(result?.sourceSnapshots).toHaveLength(1);
    expect(queryLog.filter(entry => entry.table === "source_snapshots").length).toBeGreaterThan(queriesAfterFailure);
  });

  it("does not cache legacy incidents without a verified inventory manifest", async () => {
    const { original, payload, queryLog } = sourceCacheFixture();
    delete payload.incident.selected_fire.inventoryManifest;
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    const initialQueries = queryLog.filter(entry => entry.table === "source_snapshots").length;
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    expect(queryLog.filter(entry => entry.table === "source_snapshots")).toHaveLength(initialQueries * 2);
  });

  it("evicts the oldest entry rather than retaining more than four counties", async () => {
    const { original, db, queryLog } = sourceCacheFixture();
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    for (let index = 0; index < 4; index++) {
      const other = fixtureBundle(`county-${index}`);
      const next = buildSupabasePayload(other, { assets: [fixtureAsset(other.incident.id)] });
      db.incidents.push(next.incident);
      db.assets.push(...next.assets);
      db.recommendations.push(...next.recommendations);
      db.source_snapshots.push(...next.sourceSnapshots);
      await getSupabaseIncidentBundle(other.incident.id, { sourceCache: true });
    }
    const queryCount = queryLog.filter(entry => entry.table === "source_snapshots").length;
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    expect(queryLog.filter(entry => entry.table === "source_snapshots").length).toBeGreaterThan(queryCount);
  });

  it("does not retain a source transfer above the per-entry cache byte limit", async () => {
    const { original, payload, queryLog } = sourceCacheFixture();
    payload.sourceSnapshots[0].raw_payload.cacheTestPadding = "x".repeat(16 * 1024 * 1024);
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    const initialQueries = queryLog.filter(entry => entry.table === "source_snapshots").length;
    await getSupabaseIncidentBundle(original.incident.id, { sourceCache: true });
    expect(queryLog.filter(entry => entry.table === "source_snapshots")).toHaveLength(initialQueries * 2);
  });

  it.each(["retired", "legacy", "changed", "missing-source"])("does not call the action RPC for %s inventory", async (mode) => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)] });
    const next = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)] });
    if (mode === "legacy") delete payload.incident.selected_fire.inventoryManifest;
    if (mode === "retired") {
      (payload.incident.selected_fire.inventoryManifest as { recommendationIds: string[] }).recommendationIds = [];
      (payload.incident.selected_fire.inventoryManifest as { queueIndex: unknown }).queueIndex = createQueueReadIndex([]);
    }
    const db = { incidents: [payload.incident], assets: payload.assets, recommendations: payload.recommendations,
      source_snapshots: mode === "missing-source" ? [] : payload.sourceSnapshots };
    const rpc = vi.fn(commandReceipt);
    getSupabaseAdminClientMock.mockReturnValue({ from(table: string) {
      if (mode === "changed" && table === "source_snapshots") db.incidents = [next.incident];
      return { select() { return createReadBuilder(table, db); } };
    }, rpc } as never);
    await expect(recordSupabaseAction({ ...commandContext(db.incidents[0]), recommendationId: original.recommendations[0].id,
      action: "annotate", note: "Test-only action", actorName: "Fixture reviewer" })).rejects.toMatchObject({
        code: mode === "changed" ? "read_generation" : mode === "missing-source" ? "read_invalid" : mode === "legacy" ? "FA409" : "read_unverified",
      });
    expect(rpc.mock.calls.every((call) => (call[1] as { p_action?: unknown }).p_action === null)).toBe(true);
  });

  it("atomically persists a new membership set, retains history, and includes later uploads after reload", async () => {
    const original = fixtureBundle("ventura");
    const oldAsset = fixtureAsset(original.incident.id);
    const oldAction = createResponderAction({ recommendation: original.recommendations[0], action: "annotate", note: "Historical test decision", actorName: "Fixture reviewer" });
    const first = buildSupabasePayload(original, { assets: [oldAsset], actions: [oldAction], auditEvents: [oldAction.auditEvent] });
    const db: Record<string, Record<string, unknown>[]> = JSON.parse(JSON.stringify({ incidents: [first.incident], assets: first.assets,
      recommendations: first.recommendations, source_snapshots: first.sourceSnapshots, responder_actions: first.responderActions, audit_events: first.auditEvents }));
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === ATOMIC_RESPONDER_ACTION_SECURITY_RPC) return { data: null, error: null };
      expect([ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC, IMPORT_COMMIT_RPC]).toContain(name);
      const payload = JSON.parse(JSON.stringify(args));
      db.incidents = [payload.p_incident];
      db.source_snapshots = payload.p_source_snapshots;
      for (const [table, key] of [["assets", "p_assets"], ["recommendations", "p_recommendations"], ["audit_events", "p_audit_events"]]) {
        const rows = new Map(db[table].map((row) => [row.id, row]));
        for (const row of payload[key]) rows.set(row.id, row);
        db[table] = [...rows.values()];
      }
      return name === IMPORT_COMMIT_RPC ? commandReceipt(name, payload) : { error: null };
    });
    getSupabaseAdminClientMock.mockReturnValue({ from(table: string) { return { select() { return createReadBuilder(table, db); } }; }, rpc } as never);
    const nextAsset = { ...oldAsset, id: "new-inventory-asset" };
    const nextRecommendation = { ...original.recommendations[0], id: "new-inventory-recommendation", assetId: nextAsset.id };
    const refreshed = await persistBundleToSupabase({ ...original, recommendations: [nextRecommendation] }, { write: { ...bundleWriteContext, expectedRevision: (first.incident.selected_fire.inventoryManifest as { revision: string }).revision }, assets: [nextAsset], actions: [], auditEvents: [] });
    expect(db.assets).toHaveLength(2);
    expect(db.recommendations).toHaveLength(2);
    expect(refreshed?.assets.map((asset) => asset.id)).toEqual([nextAsset.id]);
    expect(refreshed?.recommendations.map((recommendation) => recommendation.id)).toEqual([nextRecommendation.id]);
    expect(refreshed?.actions[0].recommendationSnapshot.id).toBe(original.recommendations[0].id);
    const upload = { ...oldAsset, id: "new-upload", localOrUploaded: true, origin: "uploaded" as const };
    await persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal, persistence: refreshed!.persistence, incidentId: original.incident.id, assets: [upload], auditEvent: {
      id: "import-test-event", incidentId: original.incident.id, eventType: "AssetsImported", actorName: "Fixture reviewer",
      summary: "Test-only import", payload: {}, createdAt: "2026-06-27T14:26:00.000Z",
    } });
    const reloaded = await getSupabaseIncidentBundle(original.incident.id);
    expect(reloaded?.assets.map((asset) => asset.id).sort()).toEqual([nextAsset.id, upload.id].sort());
    expect(reloaded?.recommendations).toEqual([]);
    expect(db.recommendations).toHaveLength(2);
    expect(reloaded?.actions[0].id).toBe(oldAction.id);
    const afterImportRefresh = await persistBundleToSupabase({ ...reloaded!, recommendations: [nextRecommendation] }, {
      assets: reloaded!.assets, actions: [], auditEvents: [], write: { ...bundleWriteContext, ...reloaded!.persistence },
    });
    expect(afterImportRefresh?.recommendations.map(item => item.id)).toEqual([nextRecommendation.id]);
    expect(afterImportRefresh?.recommendations[0].assetId).toBe(nextAsset.id);
    expect(afterImportRefresh?.assets.map(item => item.id).sort()).toEqual([nextAsset.id, upload.id].sort());
    expect(afterImportRefresh?.actions[0].id).toBe(oldAction.id);
    expect(db.recommendations).toHaveLength(2);
    const callsBefore = rpc.mock.calls.length;
    await expect(recordSupabaseAction({ ...commandContext(db.incidents[0]), recommendationId: original.recommendations[0].id, action: "accept", note: "", actorName: "Fixture reviewer" })).rejects.toMatchObject({ code: "read_unverified" });
    expect(rpc).toHaveBeenCalledTimes(callsBefore + 1);
    expect(rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_action: null, p_audit_event: null });
  });

  it("uses real PostgREST client counts and keyset requests to reload a complete serialized inventory", async () => {
    const original = fixtureBundle("ventura");
    const assets = Array.from({ length: 601 }, (_, index) => ({ ...fixtureAsset(original.incident.id), id: `rest-${index}` }));
    const recommendations = assets.map((asset, index) => ({ ...original.recommendations[0], id: `rest-rec-${index}`, assetId: asset.id }));
    const payload = JSON.parse(JSON.stringify(buildSupabasePayload({ ...original, recommendations }, { assets })));
    const db: Record<string, Record<string, unknown>[]> = { incidents: [{ ...payload.incident, created_at: "2026-06-27T14:24:00Z" }],
      assets: payload.assets, recommendations: payload.recommendations, source_snapshots: payload.sourceSnapshots };
    const calls: URL[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://database.example");
      calls.push(url);
      const table = url.pathname.split("/").at(-1)!;
      let rows = [...(db[table] ?? [])];
      const incidentFilter = url.searchParams.get("incident_id");
      if (incidentFilter) rows = rows.filter((row) => `eq.${row.incident_id}` === incidentFilter);
      const cursor = url.searchParams.get("id");
      if (cursor?.startsWith("gt.")) rows = rows.filter((row) => String(row.id) > cursor.slice(3));
      if (url.searchParams.get("order") === "id.asc") rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const count = rows.length;
      const head = init?.method === "HEAD";
      rows = rows.slice(0, Math.min(73, Number(url.searchParams.get("limit") ?? 73)));
      if (["assets", "recommendations", "source_snapshots"].includes(table)) {
        expect(new Headers(init?.headers).get("prefer")).toContain("count=exact");
      }
      return new Response(head ? null : JSON.stringify(rows), { status: 200,
        headers: { "content-type": "application/json", "content-range": `${rows.length ? `0-${rows.length - 1}` : "*"}/${count}` } });
    };
    getSupabaseAdminClientMock.mockReturnValue(createClient("https://database.example", "synthetic-test-key", {
      global: { fetch: fetchImpl }, auth: { persistSession: false, autoRefreshToken: false },
    }) as never);
    const bundle = await getSupabaseIncidentBundle(original.incident.id);
    expect(bundle?.assets.map((asset) => asset.id).sort()).toEqual(assets.map((asset) => asset.id).sort());
    expect(bundle?.recommendations.map((item) => item.id).sort()).toEqual(recommendations.map((item) => item.id).sort());
    expect(calls.some((url) => url.searchParams.get("id")?.startsWith("gt."))).toBe(true);
  });

  it.each(["short-page", "missing-count", "changed-count", "duplicate-id", "foreign-incident", "empty-page", "over-budget"])(
    "handles persisted inventory paging boundary: %s", async (mode) => {
      const original = fixtureBundle("ventura");
      const assets = Array.from({ length: 601 }, (_, index) => ({ ...fixtureAsset(original.incident.id), id: `paging-${index}` }));
      const payload = buildSupabasePayload({ ...original, recommendations: [] }, { assets });
      const db = { incidents: [{ ...payload.incident, created_at: "2026-06-27T14:24:00Z" }], assets: payload.assets, source_snapshots: payload.sourceSnapshots };
      let reads = 0;
      getSupabaseAdminClientMock.mockReturnValue({ from(table: string) { return {
        select(_columns: string, options?: { head?: boolean }) {
          const builder = createReadBuilder(table, db);
          const then = builder.then.bind(builder);
          builder.then = (fulfilled, rejected) => then((result) => {
            const changed = { ...result, count: result.count };
            if (table === "assets") {
              reads++;
              if (mode === "short-page" && !options?.head) changed.data = result.data.slice(0, 100);
              if (mode === "missing-count") changed.count = null;
              if (mode === "changed-count" && reads > 1) changed.count = (changed.count ?? 0) + 1;
              if (mode === "duplicate-id" && result.data.length > 1) changed.data = [result.data[0], result.data[0]];
              if (mode === "foreign-incident" && result.data.length) changed.data = [{ ...result.data[0], incident_id: "other" }];
              if (mode === "empty-page") changed.data = [];
              if (mode === "over-budget") changed.count = 100001;
            }
            return fulfilled ? fulfilled(changed) : changed as never;
          }, rejected);
          return builder;
        },
      }; } } as never);
      const result = getSupabaseIncidentBundle(original.incident.id);
      if (mode === "short-page") {
        expect((await result)?.assets).toHaveLength(601);
        expect(reads).toBe(8);
      } else {
        await expect(result).rejects.toMatchObject({ name: "InventoryCapacityError" });
      }
    });

  it("reloads every asset and recommendation beyond the provider row cap", async () => {
    const original = fixtureBundle("ventura");
    const assets = Array.from({ length: 1201 }, (_, index) => ({ ...fixtureAsset(original.incident.id), id: `inventory-${index}` }));
    const recommendations = assets.map((asset, index) => ({ ...original.recommendations[0], id: `inventory-rec-${index}`, assetId: asset.id }));
    const payload = buildSupabasePayload({ ...original, recommendations }, { assets });
    const db = { incidents: [{ ...payload.incident, created_at: "2026-06-27T14:24:00Z" }],
      assets: payload.assets, recommendations: payload.recommendations, source_snapshots: payload.sourceSnapshots };
    const queries: QueryLogEntry[] = [];
    getSupabaseAdminClientMock.mockReturnValue({ from(table: string) {
      return { select() { return createReadBuilder(table, db, queries); } };
    } } as never);
    const bundle = await getSupabaseIncidentBundle(original.incident.id);
    expect(bundle?.assets).toHaveLength(1201);
    expect(bundle?.recommendations).toHaveLength(1201);
    expect(queries.filter((query) => query.table === "assets").length).toBeGreaterThan(1);
    expect(queries.filter((query) => query.table === "responder_actions")).toEqual([
      expect.objectContaining({ filter: { type: "eq", column: "recommendations.incident_id", value: payload.incident.id }, limitCount: 200 }),
    ]);
  });

  it.each([true, false])("retains real inferred crossings through basin coverage=%s, JSON persistence, reload and action lookup", async (available) => {
    const original = fixtureBundle("ventura");
    const inferred = inferCrossingAssets(original.incident,
      [{ id: "road-1", sourceKey: "tiger-roads", sourceName: "TIGERweb",
        paths: [[[-119.4, 34.45], [-119.1, 34.45]]] }],
      [{ id: "flow-1", sourceKey: "3dhp-flowlines", sourceName: "USGS",
        paths: [[[-119.22, 34.3], [-119.22, 34.6]]] }]);
    expect(inferred).toHaveLength(1);
    const assessment: PwfdfAssessment = { fireId: "test-fire", fireName: "Test fire",
      assessmentDate: "2026-06-27T00:00:00.000Z" };
    const basin: PwfdfBasinHazard = { id: "test-basin", fireId: assessment.fireId,
      assessmentDate: assessment.assessmentDate, probabilityClass: "60-80%",
      volumeClass: "10,000-100,000", combinedHazard: "High", geometry: { type: "Polygon",
        coordinates: [[[-119.4, 34.3], [-119.1, 34.3], [-119.1, 34.6], [-119.4, 34.6], [-119.4, 34.3]]] } };
    const assets = linkPwfdfHazardsToAssets(inferred, available ? assessment : undefined, available ? [basin] : []);
    const before = structuredClone(assets);
    original.recommendations[0] = { ...original.recommendations[0], assetId: assets[0].id,
      assetName: assets[0].name, coordinates: assets[0].coordinates, evidence: assets[0].evidence };
    const payload = buildSupabasePayload(original, { assets });
    const rows = JSON.parse(JSON.stringify({ incident: { ...payload.incident, created_at: "2026-06-27T14:24:00Z" },
      assets: payload.assets, sourceSnapshots: payload.sourceSnapshots,
      recommendations: payload.recommendations, responderActions: [], auditEvents: [] }));
    const result = mapSupabaseRowsToBundle(rows);
    expect(result.assets).toHaveLength(1);
    expect(result.recommendations).toHaveLength(1);
    expect(result.assets[0].metrics?.inferenceGeometryVersion).toBe(SOURCE_LINE_GEOMETRY_VERSION);
    expect(result.assets[0].evidence).toEqual(assets[0].evidence);
    const db = { incidents: [rows.incident], assets: rows.assets,
      recommendations: rows.recommendations, source_snapshots: rows.sourceSnapshots };
    const rpc = vi.fn(commandReceipt);
    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) { return { select() { return createReadBuilder(table, db); } }; }, rpc,
    } as never);
    const action = await recordSupabaseAction({ ...commandContext(db.incidents[0]), recommendationId: original.recommendations[0].id,
      action: "annotate", note: "Test-only provenance check", actorName: "Fixture operator" });
    expect(action).not.toBeNull();
    expect(rpc).toHaveBeenCalledWith(ATOMIC_RESPONDER_ACTION_SECURITY_RPC, expect.objectContaining({
      p_action: expect.objectContaining({ recommendation_snapshot: expect.objectContaining({ assetId: assets[0].id }) }),
    }));
    expect(assets).toEqual(before);
  });

  it("round-trips multipart source geometry and inferred part provenance without simplification", () => {
    const original = fixtureBundle("ventura");
    const asset = fixtureAsset(original.incident.id);
    asset.evidence = [{ sourceKey: "tiger-roads", sourceName: "TIGERweb", sourceFeatureId: "road-1", sourcePartIndex: 1, summary: "Second road part" }];
    const paths = [Array.from({ length: 200 }, (_, i) => [-119.4 + i / 10000, 34.2]), [[-119.2, 34.3], [-119.1, 34.4]]];
    original.sourceSnapshots[0] = { ...original.sourceSnapshots[0], sourceKey: "tiger-roads", rawPayload: {
      geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
      features: [{ id: "road-1", sourceKey: "tiger-roads", sourceName: "TIGERweb", paths }],
    } };
    const payload = buildSupabasePayload(original, { assets: [asset] });
    const rows = { incident: { ...payload.incident, created_at: "2026-06-27T14:24:00Z" }, assets: payload.assets,
      sourceSnapshots: payload.sourceSnapshots, recommendations: payload.recommendations, responderActions: [], auditEvents: [] };
    const result = mapSupabaseRowsToBundle(rows);
    expect(result.sourceSnapshots[0].rawPayload).toEqual(original.sourceSnapshots[0].rawPayload);
    expect(result.assets[0].evidence).toEqual(asset.evidence);
    expect(result.assets[0].metrics?.inferenceGeometryVersion).toBe(SOURCE_LINE_GEOMETRY_VERSION);
  });

  it("withholds legacy inferred assets and current recommendations without rewriting their audit history", () => {
    const original = fixtureBundle("ventura");
    const legacy = fixtureAsset(original.incident.id);
    delete legacy.metrics!.inferenceGeometryVersion;
    const action = createResponderAction({ recommendation: original.recommendations[0], action: "annotate", note: "Historical review", actorName: "Fixture operator" });
    const payload = buildSupabasePayload(original, { assets: [legacy], actions: [action], auditEvents: [action.auditEvent] });
    const rows = { incident: { ...payload.incident, created_at: "2026-06-27T14:24:00Z" }, assets: payload.assets,
      sourceSnapshots: payload.sourceSnapshots, recommendations: payload.recommendations, responderActions: payload.responderActions, auditEvents: payload.auditEvents };
    const before = structuredClone(rows);
    const result = mapSupabaseRowsToBundle(rows);
    expect(result.assets).toEqual([]);
    expect(result.recommendations).toEqual([]);
    expect(result.auditEvents).toHaveLength(1);
    expect(result.actions).toHaveLength(1);
    expect(rows).toEqual(before);
  });

  it("rejects new actions on legacy inferred geometry before calling the write RPC", async () => {
    const original = fixtureBundle("ventura");
    const legacy = fixtureAsset(original.incident.id);
    delete legacy.metrics!.inferenceGeometryVersion;
    const payload = buildSupabasePayload(original, { assets: [legacy] });
    const db = { incidents: [{ ...payload.incident, created_at: "2026-06-27T14:24:00Z" }], assets: payload.assets, recommendations: payload.recommendations };
    const rpc = vi.fn(commandReceipt);
    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) { return { select() { return createReadBuilder(table, db); } }; }, rpc,
    } as never);
    expect(await recordSupabaseAction({ ...commandContext(db.incidents[0]), recommendationId: original.recommendations[0].id, action: "accept", note: "Test only", actorName: "Fixture operator" })).toBeNull();
    expect(rpc.mock.calls.every((call) => (call[1] as { p_action?: unknown }).p_action === null)).toBe(true);
  });

  it("round-trips provider time provenance and forecast validity without inventing publication dates", () => {
    const original = fixtureBundle("ventura");
    original.incident.alertCoverageStatus = "partial";
    original.sourceSnapshots[0].sourceTimeBasis = "provider";
    original.sourceSnapshots[0].validUntil = "2026-06-29T14:00:00.000Z";
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)] });
    const rows = {
      incident: { ...payload.incident, created_at: "2026-06-27T14:24:00.000Z" },
      assets: payload.assets, sourceSnapshots: payload.sourceSnapshots,
      recommendations: payload.recommendations, responderActions: [], auditEvents: [],
    };
    expect(mapSupabaseRowsToBundle(rows).incident.alertCoverageStatus).toBe("partial");
    delete rows.incident.selected_fire.alertCoverageStatus;
    expect(mapSupabaseRowsToBundle(rows).incident.alertCoverageStatus).toBe("unavailable");
    expect(mapSupabaseRowsToBundle(rows).sourceSnapshots[0]).toMatchObject({
      sourceTimeBasis: "provider", validUntil: "2026-06-29T14:00:00.000Z", sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
    });
    rows.sourceSnapshots[0].source_updated_at = null;
    expect(mapSupabaseRowsToBundle(rows).sourceSnapshots[0].sourceUpdatedAt).toBe("");
  });
  it("marks legacy scores unassessed and round-trips the new scoring contract", () => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    const rows = {
      incident: { ...payload.incident, created_at: "2026-06-27T14:24:00.000Z" },
      assets: payload.assets, sourceSnapshots: payload.sourceSnapshots,
      recommendations: payload.recommendations, responderActions: [], auditEvents: [],
    };
    const legacy = mapSupabaseRowsToBundle(rows).recommendations[0];
    expect(legacy.riskLevel).toBe("Unknown");
    expect(legacy.scoreBreakdown.scoreBasis).toBe("legacy-unassessed");
    expect(legacy.recommendedAction).toContain("Unknown does not mean low hazard");
    expect(legacy.reasonCodes).toEqual(["Legacy evidence interpretation: refresh required"]);
    expect(legacy.changedSinceLastRefresh).toContain("Legacy ranking");
    expect(Object.values(legacy.scoreBreakdown.metricStatus ?? {})).toEqual(Array(5).fill("not_available"));
    expect(rows.recommendations[0].reason_codes).toContain("Heavy Rain Forecast");
    expect(payload.recommendations[0].risk_level).toBe("High");
    rows.recommendations[0].score_breakdown.scoringVersion = "2026-09-12-independent-evidence-v2";
    expect(mapSupabaseRowsToBundle(rows).recommendations[0].riskLevel).toBe("Unknown");

    original.recommendations[0].scoreBreakdown.scoringVersion = SCORING_VERSION;
    original.recommendations[0].scoreBreakdown.scoreBasis = "review-only";
    original.recommendations[0].riskLevel = "Unknown";
    const currentPayload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)], auditEvents: [] });
    const current = mapSupabaseRowsToBundle({ ...rows, recommendations: currentPayload.recommendations }).recommendations[0];
    expect(current.riskLevel).toBe("Unknown");
    expect(current.scoreBreakdown.scoringVersion).toBe(SCORING_VERSION);
    expect(current.scoreBreakdown.scoreBasis).toBe("review-only");
    expect(currentPayload.recommendations[0].score_breakdown.scoringVersion).toBe(SCORING_VERSION);
  });

  it("does not persist or return legacy FIRMS credentials from source or audit JSON", () => {
    const url = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/synthetic-storage-key/VIIRS/1,2,3,4/3";
    const original = fixtureBundle("ventura");
    original.sourceSnapshots[0].sourceUrl = url;
    original.sourceSnapshots[0].rawPayload = { warning: `Source: ${url}` };
    const action = createResponderAction({
      recommendation: original.recommendations[0], action: "annotate",
      actorName: "fixture operator", note: `Source: ${url}`,
    });
    const payload = buildSupabasePayload(original, {
      assets: [fixtureAsset(original.incident.id)], actions: [action], auditEvents: [action.auditEvent],
    });
    expect(JSON.stringify(payload)).not.toContain("synthetic-storage-key");
    expect(original.sourceSnapshots[0].sourceUrl).toBe(url);

    // Represent records written by an older deployment, including immutable audit data.
    payload.sourceSnapshots[0].source_url = url;
    payload.auditEvents[0].payload.legacyUrl = url;
    const result = mapSupabaseRowsToBundle({
      incident: { ...payload.incident, created_at: "2026-06-27T14:24:00.000Z" },
      assets: payload.assets, sourceSnapshots: payload.sourceSnapshots,
      recommendations: payload.recommendations, responderActions: payload.responderActions,
      auditEvents: payload.auditEvents,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-storage-key");
    expect(payload.sourceSnapshots[0].source_url).toBe(url);
    expect(payload.auditEvents[0].payload.legacyUrl).toBe(url);
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reads the signed-in user's membership without requiring the service-role key", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        organization_id: "org-1",
        user_id: "user-1",
        role: "incident_commander",
      },
      error: null,
    });
    const userFilter = vi.fn(() => ({ maybeSingle }));
    const organizationFilter = vi.fn(() => ({ eq: userFilter }));
    const select = vi.fn(() => ({ eq: organizationFilter }));
    getSupabaseServerClientMock.mockResolvedValue({
      from: vi.fn(() => ({ select })),
    } as never);

    await expect(getDefaultOrganizationMembership("user-1")).resolves.toEqual({
      organization_id: "org-1",
      user_id: "user-1",
      role: "incident_commander",
    });
    expect(select).toHaveBeenCalledWith("organization_id,user_id,role");
    expect(organizationFilter).toHaveBeenCalledWith("organization_id", expect.any(String));
    expect(userFilter).toHaveBeenCalledWith("user_id", "user-1");
    expect(getSupabaseAdminClientMock).not.toHaveBeenCalled();
  });

  it("selects least-recently-refreshed incidents so cron does not starve older counties", async () => {
    const result = {
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          selected_fire: { domainIncidentId: "incident-oldest" },
          last_refresh: "2026-06-01T00:00:00.000Z",
        },
      ],
      error: null,
      count: 1,
    };
    const abortSignal = vi.fn(() => ({ retry: () => Promise.resolve(result) }));
    const limit = vi.fn(() => ({ abortSignal }));
    const order = vi.fn(() => ({ limit }));
    const select = vi.fn(() => ({ order, abortSignal }));
    getSupabaseAdminClientMock.mockReturnValue({
      from: vi.fn(() => ({ select })),
    } as never);

    await expect(listSupabaseIncidentIds(7)).resolves.toEqual(["incident-oldest"]);
    expect(select).toHaveBeenCalledWith("id, selected_fire, last_refresh");
    expect(order).toHaveBeenCalledWith("id", {
      ascending: true,
    });
    expect(limit).toHaveBeenCalledWith(1);
    expect(select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("keeps real Los Angeles and Ventura incidents in scheduled refresh discovery", async () => {
    const result = {
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          selected_fire: { domainIncidentId: "incident-los-angeles-ca" },
          last_refresh: null,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          selected_fire: { domainIncidentId: "incident-ventura-ca" },
          last_refresh: null,
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          selected_fire: { domainIncidentId: "incident-custom-custom-hartford" },
          last_refresh: null,
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          selected_fire: {
            domainIncidentId: "incident-training",
            metadata: { fireafterNonOperational: true },
          },
          last_refresh: null,
        },
      ],
      error: null,
      count: 4,
    };
    const abortSignal = vi.fn(() => ({ retry: () => Promise.resolve(result) }));
    const limit = vi.fn(() => ({ abortSignal }));
    const order = vi.fn(() => ({ limit }));
    const select = vi.fn(() => ({ order, abortSignal }));
    getSupabaseAdminClientMock.mockReturnValue({
      from: vi.fn(() => ({ select })),
    } as never);

    await expect(listSupabaseIncidentIds()).resolves.toEqual([
      "incident-los-angeles-ca",
      "incident-ventura-ca",
    ]);
  });

  it("reports reality-upgrade schema readiness without throwing", async () => {
    const healthy = await checkSupabaseRealitySchema({
      from(table: string) {
        return {
          select(columns: string) {
            return {
              limit(count: number) {
                return Promise.resolve({
                  data: [{ table, columns, count }],
                  error: null,
                });
              },
            };
          },
        };
      },
      rpc(functionName: string) {
        return Promise.resolve({
          data:
            functionName === "fireafter_server_owned_write_security_version"
              ? "20260914070900"
              : functionName === ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC
                ? ATOMIC_RESPONDER_ACTION_SECURITY_VERSION
              : functionName === ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC
                ? ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION
              : functionName === OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC
                ? OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION
              : functionName === SCHEDULED_REFRESH_SECURITY_PROBE_RPC
                ? SCHEDULED_REFRESH_SECURITY_VERSION
              : null,
          error: null,
        });
      },
    });

    expect(healthy.ready).toBe(true);
    expect(healthy.serverOwnedWritesVersion).toBe("20260914070900");
    expect(healthy.serverOwnedWritesProbeError).toBeNull();
    expect(healthy.atomicResponderActionVersion).toBe(
      ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
    );
    expect(healthy.atomicResponderActionProbeError).toBeNull();
    expect(healthy.atomicBundlePersistenceVersion).toBe(
      ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
    );
    expect(healthy.atomicBundlePersistenceProbeError).toBeNull();
    expect(healthy.operatorAccountIssuanceAuditVersion).toBe(
      OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
    );
    expect(healthy.operatorAccountIssuanceAuditProbeError).toBeNull();
    expect(healthy.scheduledRefreshVersion).toBe(
      SCHEDULED_REFRESH_SECURITY_VERSION,
    );
    expect(healthy.scheduledRefreshProbeError).toBeNull();
    expect(healthy.errors).toEqual([]);

    const missing = await checkSupabaseRealitySchema({
      from() {
        return {
          select() {
            return {
              limit() {
                return Promise.resolve({
                  data: null,
                  error: { message: "permission denied for table source_runs" },
                });
              },
            };
          },
        };
      },
      rpc() {
        return Promise.resolve({
          data: null,
          error: { message: "function unavailable" },
        });
      },
    });

    expect(missing.ready).toBe(false);
    expect(missing.serverOwnedWritesVersion).toBeNull();
    expect(missing.serverOwnedWritesProbeError).toBe(
      "Server-owned operational-write security probe is unavailable.",
    );
    expect(missing.atomicResponderActionProbeError).toBe(
      "Atomic responder-action persistence security probe is unavailable.",
    );
    expect(missing.atomicBundlePersistenceProbeError).toBe(
      "Atomic bundle persistence security probe is unavailable.",
    );
    expect(missing.operatorAccountIssuanceAuditProbeError).toBe(
      "Operator account issuance audit security probe is unavailable.",
    );
    expect(missing.scheduledRefreshProbeError).toBe(
      "Durable scheduled-refresh lease security probe is unavailable.",
    );
    expect(missing.errors).toContain("Supabase schema probe for source_runs is unavailable; verify Supabase connectivity and retry.");
    expect(missing.errors.join(" ")).not.toContain("permission denied");
  });

  it("keeps schema readiness separate from server-owned-write control drift", async () => {
    const drifted = await checkSupabaseRealitySchema({
      from() {
        return {
          select() {
            return {
              limit() {
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
        };
      },
      rpc() {
        return Promise.resolve({ data: null, error: null });
      },
    });

    expect(drifted.ready).toBe(true);
    expect(drifted.serverOwnedWritesVersion).toBeNull();
    expect(drifted.serverOwnedWritesProbeError).toBeNull();
    expect(drifted.atomicResponderActionVersion).toBeNull();
    expect(drifted.atomicResponderActionProbeError).toBeNull();
    expect(drifted.atomicBundlePersistenceVersion).toBeNull();
    expect(drifted.atomicBundlePersistenceProbeError).toBeNull();
    expect(drifted.operatorAccountIssuanceAuditVersion).toBeNull();
    expect(drifted.operatorAccountIssuanceAuditProbeError).toBeNull();
    expect(drifted.scheduledRefreshVersion).toBeNull();
    expect(drifted.scheduledRefreshProbeError).toBeNull();
    expect(drifted.errors).toEqual([]);
  });

  it("normalizes transport failures without exposing raw fetch errors", async () => {
    const unavailable = await checkSupabaseRealitySchema({
      from() {
        return {
          select() {
            return {
              limit() {
                throw new TypeError("fetch failed");
              },
            };
          },
        };
      },
      rpc() {
        throw new TypeError("fetch failed");
      },
    });

    expect(unavailable.ready).toBe(false);
    expect(unavailable.errors).toContain(
      "Supabase schema probe for source_runs is unavailable; verify Supabase connectivity and retry.",
    );
    expect(unavailable.errors.join(" ")).not.toContain("fetch failed");
    expect(unavailable.serverOwnedWritesProbeError).toBe(
      "Server-owned operational-write security probe is unavailable.",
    );
    expect(unavailable.atomicResponderActionProbeError).toBe(
      "Atomic responder-action persistence security probe is unavailable.",
    );
    expect(unavailable.atomicBundlePersistenceProbeError).toBe(
      "Atomic bundle persistence security probe is unavailable.",
    );
  });

  it("stores app domain identifiers inside json payloads while using uuid database keys", async () => {
    const refreshed = fixtureBundle("ventura");

    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });

    expect(payload.incident.selected_fire.domainIncidentId).toBe(
      refreshed.incident.id,
    );
    expect(payload.assets).toHaveLength(refreshed.recommendations.length);
    expect(payload.assets[0].id).toMatch(uuidPattern);
    expect(payload.assets[0].properties.domainAssetId).toBe(
      refreshed.recommendations[0].assetId,
    );
    expect(payload.recommendations[0].id).toMatch(uuidPattern);
    expect(payload.recommendations[0].score_breakdown.domainRecommendationId).toBe(
      refreshed.recommendations[0].id,
    );
    expect(payload.recommendations[0].score_breakdown.domainIncidentId).toBe(
      refreshed.incident.id,
    );
  });

  it("drops persisted assets and dependent recommendations with invalid coordinates", () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    payload.assets[0].properties.coordinates = ["not-a-longitude", "not-a-latitude"];

    const bundle = mapSupabaseRowsToBundle({
      incident: {
        ...payload.incident,
        created_at: "2026-06-27T14:24:00.000Z",
      },
      assets: payload.assets,
      sourceSnapshots: payload.sourceSnapshots,
      recommendations: payload.recommendations,
      responderActions: [],
      auditEvents: payload.auditEvents,
    });

    expect(bundle.assets).toEqual([]);
    expect(bundle.recommendations).toEqual([]);
    expect(
      JSON.stringify(bundle).includes("-118.2437") ||
        JSON.stringify(bundle).includes("34.0522"),
    ).toBe(false);
  });

  it("writes explicit defaults for nullable domain fields backed by not-null Supabase columns", async () => {
    const refreshed = fixtureBundle("ventura");
    refreshed.incident.fireCandidates = undefined;
    refreshed.incident.coverageStatus = undefined;
    refreshed.sourceSnapshots[0].coverageStatus = undefined;
    refreshed.sourceSnapshots[0].sourceUpdatedAt = "Not refreshed";
    const asset = {
      ...fixtureAsset(refreshed.incident.id),
      sourceFeatureIds: undefined,
      coverageStatus: undefined,
    };
    const recommendation = {
      ...refreshed.recommendations[0],
      evidence: undefined,
      sourceSnapshotIds: undefined,
      scoreBreakdown: {
        ...refreshed.recommendations[0].scoreBreakdown,
        metricStatus: undefined,
      },
    };

    const payload = buildSupabasePayload(
      {
        ...refreshed,
        recommendations: [recommendation],
      },
      {
        assets: [asset],
      },
    );

    expect(payload.incident.fire_candidates).toEqual([]);
    expect(payload.incident.coverage_status).toBe("not_available");
    expect(payload.sourceSnapshots[0].coverage_status).toBe("not_available");
    expect(payload.sourceSnapshots[0].source_updated_at).toBeNull();
    expect(payload.assets[0].source_feature_ids).toEqual([]);
    expect(payload.assets[0].coverage_status).toBe("not_available");
    expect(payload.recommendations[0].evidence).toEqual([]);
    expect(payload.recommendations[0].metric_status).toEqual({});
    expect(payload.recommendations[0].source_snapshot_ids).toEqual([]);
  });

  it("persists imported assets without fabricating placeholder recommendations", async () => {
    const refreshed = fixtureBundle("ventura");
    const importedAsset = {
      ...fixtureAsset(refreshed.incident.id),
      id: "asset-ventura-uploaded-culvert",
      name: "Uploaded field-verified culvert",
      localOrUploaded: true,
      origin: "uploaded" as const,
      confidence: "High" as const,
    };

    const payload = buildSupabasePayload(
      {
        incident: refreshed.incident,
        sourceSnapshots: [],
        recommendations: [],
      },
      {
        assets: [importedAsset],
        auditEvents: [],
      },
    );

    expect(payload.assets).toHaveLength(1);
    expect(payload.assets[0].properties.domainAssetId).toBe(importedAsset.id);
    expect(payload.recommendations).toEqual([]);
  });

  it.each([false, true])("reports authoritative import receipt telemetry (replayed=%s)", async replayed => {
    const refreshed = fixtureBundle("ventura");
    const asset = { ...fixtureAsset(refreshed.incident.id), localOrUploaded: true, origin: "uploaded" as const };
    const payload = buildSupabasePayload(refreshed, { assets: [asset], auditEvents: [] });
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [{ ...payload.incident, created_at: "2026-06-27T14:24:00.000Z" }],
      source_snapshots: payload.sourceSnapshots, assets: payload.assets, recommendations: payload.recommendations,
      responder_actions: [], audit_events: [],
    };
    const priorAuditId = "50000000-0000-4000-8000-000000000005";
    const rpc = vi.fn(async (name: string, args: Parameters<typeof commandReceipt>[1]) => {
      const response = await commandReceipt(name, args);
      if (replayed && name === IMPORT_COMMIT_RPC) (response.data as { auditEventId: string }).auditEventId = priorAuditId;
      return response;
    });
    getSupabaseAdminClientMock.mockReturnValue({ from(table: string) {
      return { select() { return createReadBuilder(table, db); } };
    }, rpc } as never);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = await persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal,
        incidentId: refreshed.incident.id, assets: [asset],
        persistence: (await getSupabaseIncidentBundle(refreshed.incident.id))!.persistence,
        auditEvent: { id: "new-audit-attempt", incidentId: refreshed.incident.id, eventType: "AssetsImported",
          actorName: "test operator", createdAt: "2026-06-28T00:00:00.000Z", summary: "Import", payload: { assetCount: 1 } },
      });
      expect(result?.replayed).toBe(replayed);
      expect(info).toHaveBeenCalledWith("[fireafter] import operation confirmed", {
        operation: "asset_import", code: replayed ? "replayed" : "committed",
        operationId: importOperation.operationId, incidentId: result!.receipt.incidentId,
        assetCount: result!.receipt.assetCount, auditEventId: result!.receipt.auditEventId,
      });
      if (replayed) expect(result!.receipt.auditEventId).toBe(priorAuditId);
      expect(JSON.stringify(info.mock.calls)).not.toContain("new-audit-attempt");
    } finally { info.mockRestore(); }
  });

  it("FA10-O2 persists import and audit while retiring the pre-import recommendation queue", async () => {
    const refreshed = fixtureBundle("ventura");
    const existingAsset = fixtureAsset(refreshed.incident.id);
    const importedAsset = {
      ...existingAsset,
      id: "asset-ventura-uploaded-culvert",
      name: "Uploaded field-verified culvert",
      localOrUploaded: true,
      origin: "uploaded" as const,
      confidence: "High" as const,
    };
    const payload = buildSupabasePayload(refreshed, {
      assets: [existingAsset],
      auditEvents: [],
    });
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [
        {
          ...payload.incident,
          created_at: "2026-06-27T14:24:00.000Z",
        },
      ],
      source_snapshots: payload.sourceSnapshots,
      assets: payload.assets,
      recommendations: payload.recommendations,
      responder_actions: [],
      audit_events: [],
    };
    const rpc = vi.fn(commandReceipt);
    const upsert = vi.fn();

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db);
          },
          upsert,
        };
      },
      rpc,
    } as never);

    await expect(
      persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal,
        incidentId: refreshed.incident.id,
        assets: [importedAsset],
        persistence: (await getSupabaseIncidentBundle(refreshed.incident.id))!.persistence,
        auditEvent: {
          id: "audit-import-atomic",
          incidentId: refreshed.incident.id,
          eventType: "AssetsImported",
          actorName: "commander@example.com",
          createdAt: "2026-06-28T00:00:00.000Z",
          summary: "Imported one local asset.",
          payload: { assetCount: 1 },
        },
      }),
    ).resolves.toBeTruthy();

    expect(rpc).toHaveBeenCalledWith(
      IMPORT_COMMIT_RPC,
      expect.objectContaining({
        p_source_snapshots: expect.arrayContaining([
          expect.objectContaining({ source_key: "nws" }),
        ]),
        p_recommendations: [],
        p_incident: expect.objectContaining({ selected_fire: expect.objectContaining({ inventoryManifest: expect.objectContaining({ recommendationIds: [] }) }) }),
        p_assets: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              domainAssetId: importedAsset.id,
            }),
          }),
        ]),
        p_audit_events: expect.arrayContaining([
          expect.objectContaining({ event_type: "AssetsImported" }),
        ]),
      }),
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects imported assets that carry a different incident identity", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
      auditEvents: [],
    });
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [
        {
          ...payload.incident,
          created_at: "2026-06-27T14:24:00.000Z",
        },
      ],
      source_snapshots: payload.sourceSnapshots,
      assets: payload.assets,
      recommendations: payload.recommendations,
      responder_actions: [],
      audit_events: [],
    };
    const rpc = vi.fn(commandReceipt);

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db);
          },
        };
      },
      rpc,
    } as never);

    await expect(
      persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal,
        incidentId: refreshed.incident.id,
        assets: [{ ...fixtureAsset(refreshed.incident.id), incidentId: "incident-other" }],
        persistence: (await getSupabaseIncidentBundle(refreshed.incident.id))!.persistence,
        auditEvent: {
          id: "audit-import-invalid-incident",
          incidentId: refreshed.incident.id,
          eventType: "AssetsImported",
          actorName: "commander@example.com",
          createdAt: "2026-06-28T00:00:00.000Z",
          summary: "Imported one local asset.",
          payload: {},
        },
      }),
    ).rejects.toThrow("Imported assets must belong to the selected incident");
    expect(rpc.mock.calls.every((call) => (call[1] as { p_action?: unknown }).p_action === null)).toBe(true);
  });

  it("rejects responder action writes when the incident belongs to another organization", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [
        {
          ...payload.incident,
          organization_id: "org-other",
          created_at: "2026-06-27T14:24:00.000Z",
        },
      ],
      assets: payload.assets,
      recommendations: payload.recommendations,
    };

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db);
          },
          upsert() {
            throw new Error(`unexpected write to ${table}`);
          },
        };
      },
    } as never);

    await expect(
      recordSupabaseAction({ ...commandContext(db.incidents[0]),
        recommendationId: refreshed.recommendations[0].id,
        action: "accept",
        note: "Field crew assigned.",
        actorName: "commander@example.com",
        actorOrganizationId: "00000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow("Incident access denied");
  });

  it("rejects imported asset writes when the incident belongs to another organization", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [
        {
          ...payload.incident,
          organization_id: "org-other",
          created_at: "2026-06-27T14:24:00.000Z",
        },
      ],
    };

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db);
          },
          upsert() {
            throw new Error(`unexpected write to ${table}`);
          },
        };
      },
    } as never);

    await expect(
      persistImportedAssetsToSupabase({ importOperation, principal: bundlePrincipal,
        incidentId: refreshed.incident.id,
        assets: [fixtureAsset(refreshed.incident.id)],
        persistence: { organizationId: bundlePrincipal.organizationId, expectedRevision: null, databaseIncidentId: payload.incident.id },
        auditEvent: {
          id: "audit-import",
          incidentId: refreshed.incident.id,
          eventType: "AssetsImported",
          actorName: "commander@example.com",
          createdAt: "2026-06-27T14:24:00.000Z",
          summary: "Imported one local asset.",
          payload: {},
        },
        actorOrganizationId: "org-allowed",
      }),
    ).rejects.toThrow("Incident access denied");
  });

  it.each([undefined, null, "unknown", "2026-09-14-provider-resolution-v1"])("removes unverified basin evidence from new command receipts: %s", async version => {
    const refreshed = fixtureBundle("ventura");
    const recommendation = refreshed.recommendations[0];
    recommendation.scoreBreakdown.scoringVersion = SCORING_VERSION;
    const evidence = [{ sourceKey: "usgs-pwfdf", sourceName: "USGS", sourceFeatureId: "legacy-basin", summary: "Basin claim" },
      { sourceKey: "tiger-roads", sourceName: "Roads", summary: "Unrelated road evidence" }];
    recommendation.evidence = evidence;
    const now = new Date().toISOString();
    refreshed.sourceSnapshots = [{ id: "source-pwfdf", incidentId: refreshed.incident.id, sourceKey: "usgs-pwfdf", sourceName: "USGS",
      fetchedAt: now, sourceUpdatedAt: now, status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Current", detail: "Test provider",
      rawPayload: version === undefined ? {} : { analysisGeometryVersion: version } }];
    const payload = buildSupabasePayload(refreshed, { assets: [fixtureAsset(refreshed.incident.id)] });
    const db: Record<string, Array<Record<string, unknown>>> = { incidents: [payload.incident], assets: payload.assets,
      recommendations: payload.recommendations, source_snapshots: payload.sourceSnapshots };
    const original = structuredClone(db);
    const rpc = vi.fn(commandReceipt);
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }), rpc } as never);
    const action = await recordSupabaseAction({ ...commandContext(payload.incident), recommendationId: recommendation.id,
      action: "annotate", note: "Review current evidence", actorName: "Test operator" });
    const expected = version === "2026-09-14-provider-resolution-v1" ? evidence : evidence.slice(1);
    expect(action).not.toBeNull();
    expect(action!.recommendationSnapshot.evidence).toEqual(expected);
    const sent = rpc.mock.calls[1][1] as { p_action: { recommendation_snapshot: Recommendation };
      p_audit_event: { payload: { recommendationSnapshot: Recommendation } } };
    expect(sent.p_action.recommendation_snapshot.evidence).toEqual(expected);
    expect(sent.p_audit_event.payload.recommendationSnapshot.evidence).toEqual(expected);
    if (version !== "2026-09-14-provider-resolution-v1") {
      expect(action!.recommendationSnapshot).toMatchObject({ riskLevel: "Unknown", confidenceLevel: "Low" });
    }
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(db).toEqual(original);
    expect(recommendation.evidence).toEqual(evidence);
  });

  it("persists an aged responder snapshot and audit event through one atomic RPC", async () => {
    const refreshed = fixtureBundle("ventura");
    refreshed.recommendations[0].scoreBreakdown.scoringVersion = SCORING_VERSION;
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [
        {
          ...payload.incident,
          created_at: "2026-06-27T14:24:00.000Z",
        },
      ],
      assets: payload.assets,
      recommendations: payload.recommendations,
      source_snapshots: payload.sourceSnapshots,
    };
    const rpc = vi.fn(commandReceipt);
    const upsert = vi.fn();

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db);
          },
          upsert,
        };
      },
      rpc,
    } as never);

    const actorId = "00000000-0000-4000-8000-000000000001";
    const action = await recordSupabaseAction({ ...commandContext(db.incidents[0]),
      recommendationId: refreshed.recommendations[0].id,
      action: "annotate",
      note: "Field crew assigned.",
      actorName: "commander@example.com",
      actorId,
    });

    expect(action?.action).toBe("annotate");
    expect(action?.recommendationSnapshot.riskLevel).toBe("Unknown");
    expect(action?.recommendationSnapshot.limitations.join(" ")).toContain("expired");
    expect(action?.recommendationSnapshot.score100).toBe(72);
    expect(Object.values(action!.recommendationSnapshot.scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("not_available"));
    expect(Object.values(refreshed.recommendations[0].scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("available"));
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      ATOMIC_RESPONDER_ACTION_SECURITY_RPC,
      expect.objectContaining({
        p_action: expect.objectContaining({ actor_id: actorId }),
        p_audit_event: expect.objectContaining({ actor_id: actorId }),
      }),
    );
    expect(upsert).not.toHaveBeenCalled();
    const sent = rpc.mock.calls[1][1] as { p_action: { recommendation_snapshot: Recommendation };
      p_audit_event: { payload: { recommendationSnapshot: Recommendation } } };
    expect(Object.values(sent.p_action.recommendation_snapshot.scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("not_available"));
    expect(Object.values(sent.p_audit_event.payload.recommendationSnapshot.scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("not_available"));
  });

  it("fails closed when the atomic responder action RPC rejects", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [{ ...payload.incident, created_at: "2026-06-27T14:24:00.000Z" }],
      assets: payload.assets,
      recommendations: payload.recommendations,
      source_snapshots: payload.sourceSnapshots,
    };
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: new Error("atomic persistence unavailable"),
    });
    const upsert = vi.fn();

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db);
          },
          upsert,
        };
      },
      rpc,
    } as never);

    await expect(
      recordSupabaseAction({ ...commandContext(db.incidents[0]),
        recommendationId: refreshed.recommendations[0].id,
        action: "annotate",
        note: "Field crew assigned.",
        actorName: "commander@example.com",
      }),
    ).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses action arrays at the bundle boundary; decisions require the command RPC", async () => {
    const refreshed = fixtureBundle("ventura");
    const action = createResponderAction({ recommendation: refreshed.recommendations[0], action: "accept",
      note: "Test decision", actorName: "Test actor" });
    const rpc = vi.fn();
    getSupabaseAdminClientMock.mockReturnValue({ rpc } as never);
    await expect(persistBundleToSupabase(refreshed, { write: bundleWriteContext, actions: [action], auditEvents: [action.auditEvent] }))
      .rejects.toMatchObject({ code: "FB400" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when the atomic bundle persistence RPC rejects", async () => {
    const refreshed = fixtureBundle("ventura");
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: new Error("bundle persistence unavailable"),
    });
    const upsert = vi.fn();

    getSupabaseAdminClientMock.mockReturnValue({
      from() {
        return { upsert };
      },
      rpc,
    } as never);

    await expect(persistBundleToSupabase(refreshed, { write: bundleWriteContext })).rejects.toThrow(
      "The bundle write outcome is unconfirmed",
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rehydrates persisted rows into the dashboard bundle shape", async () => {
    const refreshed = fixtureBundle("boulder");
    const action = createResponderAction({
      recommendation: refreshed.recommendations[0],
      action: "accept",
      note: "Crew assigned for field verification.",
      actorName: "Incident Commander",
    });
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
      actions: [action],
      auditEvents: [action.auditEvent],
    });

    const bundle = mapSupabaseRowsToBundle({
      incident: {
        ...payload.incident,
        id: payload.incident.id,
        created_at: "2026-06-27T14:24:00.000Z",
      },
      assets: payload.assets.map((asset) => ({
        ...asset,
        created_at: "2026-06-27T14:24:00.000Z",
      })),
      sourceSnapshots: payload.sourceSnapshots,
      recommendations: payload.recommendations.map((recommendation) => ({
        ...recommendation,
        created_at: "2026-06-27T14:24:00.000Z",
      })),
      responderActions: payload.responderActions.map((responderAction) => ({
        ...responderAction,
        created_at: "2026-06-27T14:24:00.000Z",
      })),
      auditEvents: payload.auditEvents.map((auditEvent) => ({
        ...auditEvent,
        created_at: "2026-06-27T14:24:00.000Z",
      })),
    });

    expect(bundle.incident.id).toBe(refreshed.incident.id);
    expect(bundle.assets[0].id).toBe(refreshed.recommendations[0].assetId);
    expect(bundle.recommendations[0].id).toBe(refreshed.recommendations[0].id);
    expect(bundle.actions[0].recommendationSnapshot.id).toBe(
      refreshed.recommendations[0].id,
    );
    expect(bundle.auditEvents[0].eventType).toBe("RecommendationAccepted");
  });

  it("filters known smoke/demo rows and fixture suggestions from persisted bundles", async () => {
    const refreshed = fixtureBundle("boulder");
    const action = createResponderAction({
      recommendation: refreshed.recommendations[0],
      action: "accept",
      note: "Crew assigned for field verification.",
      actorName: "Incident Commander",
    });
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
      actions: [action],
      auditEvents: [action.auditEvent],
    });
    const demoAsset = {
      ...payload.assets[0],
      id: "11111111-1111-4111-8111-111111111111",
      name: "Live DB Test Culvert",
      source: "ventura-county-assets.csv",
      origin: "uploaded" as const,
      local_or_uploaded: true,
    };
    const demoRecommendation = {
      ...payload.recommendations[0],
      id: "22222222-2222-4222-8222-222222222222",
      asset_id: demoAsset.id,
      score_breakdown: {
        ...payload.recommendations[0].score_breakdown,
        assetName: demoAsset.name,
        domainRecommendationId: "rec-live-db-test-culvert",
      },
    };
    const demoAction = {
      ...payload.responderActions[0],
      id: "33333333-3333-4333-8333-333333333333",
      actor_name: "J. Smith",
      note: "Supabase connectivity smoke test action.",
      recommendation_snapshot: {
        ...payload.responderActions[0].recommendation_snapshot,
        assetName: demoAsset.name,
      },
    };
    const demoAudit = {
      ...payload.auditEvents[0],
      id: "44444444-4444-4444-8444-444444444444",
      actor_name: "J. Smith",
      summary: "J. Smith accepted Live DB Test Culvert.",
      payload: {
        ...payload.auditEvents[0].payload,
        assetName: demoAsset.name,
      },
    };
    const demoSourceSnapshot = {
      ...payload.sourceSnapshots[0],
      id: "55555555-5555-4555-8555-555555555555",
      raw_payload: {
        ...payload.sourceSnapshots[0].raw_payload,
        domainSourceId: "source-legacy-heuristic",
        detail: "Historical heuristic burn-scar scoring is active.",
      },
    };

    const bundle = mapSupabaseRowsToBundle({
      incident: {
        ...payload.incident,
        created_at: "2026-06-27T14:24:00.000Z",
      },
      assets: [...payload.assets, demoAsset],
      sourceSnapshots: [...payload.sourceSnapshots, demoSourceSnapshot],
      recommendations: [...payload.recommendations, demoRecommendation],
      responderActions: [...payload.responderActions, demoAction],
      auditEvents: [...payload.auditEvents, demoAudit],
    });

    expect(bundle.locations.map((location) => location.id)).toEqual([
      refreshed.incident.locationContext?.id,
    ]);
    expect(bundle.assets.map((asset) => asset.name)).not.toContain(
      "Live DB Test Culvert",
    );
    expect(bundle.recommendations.map((recommendation) => recommendation.assetName))
      .not.toContain("Live DB Test Culvert");
    expect(bundle.actions.map((responderAction) => responderAction.actorName))
      .not.toContain("J. Smith");
    expect(bundle.auditEvents.map((event) => event.actorName)).not.toContain(
      "J. Smith",
    );
    expect(bundle.sourceSnapshots.map((source) => source.id)).not.toContain(
      "source-legacy-heuristic",
    );
    expect(bundle.assets).toHaveLength(payload.assets.length);
    expect(bundle.recommendations).toHaveLength(payload.recommendations.length);
    expect(bundle.actions).toHaveLength(payload.responderActions.length);
    expect(bundle.auditEvents).toHaveLength(payload.auditEvents.length);
    expect(bundle.sourceSnapshots).toHaveLength(payload.sourceSnapshots.length);
  });

  it("bounds append-only history reads when rehydrating an incident bundle", async () => {
    const refreshed = fixtureBundle("ventura");
    const action = createResponderAction({
      recommendation: refreshed.recommendations[0],
      action: "accept",
      note: "Crew assigned for field verification.",
      actorName: "Incident Commander",
    });
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
      actions: [action],
      auditEvents: [action.auditEvent],
    });
    const queryLog: QueryLogEntry[] = [];
    const timestamp = (index: number) =>
      new Date(Date.UTC(2026, 5, 27, 14, index, 0)).toISOString();
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [
        {
          ...payload.incident,
          created_at: timestamp(0),
        },
      ],
      source_snapshots: payload.sourceSnapshots,
      assets: payload.assets,
      recommendations: payload.recommendations,
      responder_actions: Array.from({ length: 250 }, (_, index) => ({
        ...payload.responderActions[0],
        id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        created_at: timestamp(index),
      })),
      audit_events: Array.from({ length: 250 }, (_, index) => ({
        ...payload.auditEvents[0],
        id: `audit-${index}`,
        created_at: timestamp(index),
      })),
    };

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db, queryLog);
          },
        };
      },
    } as never);

    const bundle = await getSupabaseIncidentBundle(refreshed.incident.id);

    const auditDecisionRead = queryLog.find(
      (entry) => entry.table === "audit_events" && entry.filter?.type === "in",
    );
    const auditSystemRead = queryLog.find(
      (entry) =>
        entry.table === "audit_events" &&
        entry.filter?.type === "eq" &&
        entry.limitCount === 80,
    );
    const actionRead = queryLog.find(
      (entry) =>
        entry.table === "responder_actions" && entry.filter?.type === "eq" && entry.filter.column === "recommendations.incident_id",
    );
    expect(auditDecisionRead).toMatchObject({
      orderColumn: "created_at",
      ascending: false,
      limitCount: 100,
    });
    expect(auditSystemRead).toMatchObject({
      orderColumn: "created_at",
      ascending: false,
      limitCount: 80,
    });
    expect(actionRead).toMatchObject({
      orderColumn: "created_at",
      ascending: false,
      limitCount: 200,
    });
    expect(bundle?.auditEvents).toHaveLength(1);
    expect(bundle?.auditEvents[0].id).toBe("audit-249");
    expect(bundle?.actions).toHaveLength(1);
    expect(bundle?.actions[0].createdAt).toBe(timestamp(249));
  });

  it("keeps the incident bundle renderable when the audit history read fails", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [payload.incident],
      source_snapshots: payload.sourceSnapshots,
      assets: payload.assets,
      recommendations: payload.recommendations,
      responder_actions: [],
      audit_events: [],
    };

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db, [], new Set(["audit_events"]));
          },
        };
      },
    } as never);

    const bundle = await getSupabaseIncidentBundle(refreshed.incident.id);

    expect(bundle?.incident.id).toBe(refreshed.incident.id);
    expect(bundle?.assets).toHaveLength(payload.assets.length);
    expect(bundle?.auditEvents).toEqual([]);
    expect(bundle?.auditEventsStatus).toBe("unavailable");
  });

  it("pins unscoped bundle loads to the default demo incident instead of the newest incident", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [
        {
          ...payload.incident,
          selected_fire: {
            ...payload.incident.selected_fire,
            domainIncidentId: "incident-utah-county-ut",
          },
          created_at: "2026-06-27T00:00:00.000Z",
        },
        {
          ...payload.incident,
          id: "11111111-2222-4333-8444-555555555555",
          selected_fire: {
            ...payload.incident.selected_fire,
            domainIncidentId: "incident-okanogan-county-wa",
          },
          created_at: "2026-07-09T00:00:00.000Z",
        },
      ],
      source_snapshots: payload.sourceSnapshots,
      assets: payload.assets,
      recommendations: payload.recommendations,
    };

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db);
          },
        };
      },
    } as never);

    const bundle = await getSupabaseIncidentBundle();

    expect(bundle?.incident.id).toBe("incident-utah-county-ut");
  });

  it.each([undefined, "incident-missing-default"])("does not substitute the newest county when default %s is missing", async configured => {
    vi.stubEnv("FIREAFTER_DEFAULT_INCIDENT_ID", configured);
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)] });
    const db = { incidents: [{ ...payload.incident, created_at: "2026-10-08T00:00:00Z" }] };
    const queryLog: QueryLogEntry[] = [];
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({
      select: () => createReadBuilder(table, db, queryLog),
    }) } as never);

    expect(await getSupabaseIncidentBundle()).toBeNull();
    expect(queryLog).toEqual([expect.objectContaining({ table: "incidents", filter: {
      type: "contains", column: "selected_fire", value: { domainIncidentId: configured ?? "incident-utah-county-ut" },
    } })]);
  });

  it("does not substitute another county when the pinned incident is non-operational", async () => {
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)] });
    vi.stubEnv("FIREAFTER_DEFAULT_INCIDENT_ID", original.incident.id);
    const db = { incidents: [
      { ...payload.incident, selected_fire: { ...payload.incident.selected_fire, fireafterNonOperational: true } },
      { ...payload.incident, id: "11111111-2222-4333-8444-555555555555", selected_fire: { ...payload.incident.selected_fire, domainIncidentId: "incident-other-county" }, created_at: "2026-10-08T00:00:00Z" },
    ] };
    const queryLog: QueryLogEntry[] = [];
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db, queryLog) }) } as never);

    expect(await getSupabaseIncidentBundle()).toBeNull();
    expect(queryLog).toHaveLength(1);
    expect(queryLog[0].filter).toMatchObject({ type: "contains", value: { domainIncidentId: original.incident.id } });
  });

  it.each(["", "   ", "x".repeat(257)])("rejects invalid default configuration without querying any county: %s", async configured => {
    vi.stubEnv("FIREAFTER_DEFAULT_INCIDENT_ID", configured);
    const from = vi.fn(); getSupabaseAdminClientMock.mockReturnValue({ from } as never);
    await expect(getSupabaseIncidentBundle()).rejects.toMatchObject({ code: "read_invalid" });
    expect(from).not.toHaveBeenCalled();
  });

  it("an explicit county overrides a missing configured default", async () => {
    vi.stubEnv("FIREAFTER_DEFAULT_INCIDENT_ID", "incident-missing-default");
    const original = fixtureBundle("ventura");
    const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)] });
    const db = { incidents: [payload.incident], source_snapshots: payload.sourceSnapshots, assets: payload.assets,
      recommendations: payload.recommendations, responder_actions: [], audit_events: [] };
    getSupabaseAdminClientMock.mockReturnValue({ from: (table: string) => ({ select: () => createReadBuilder(table, db) }) } as never);
    expect((await getSupabaseIncidentBundle(original.incident.id))?.incident.id).toBe(original.incident.id);
  });

  it("rejects explicitly non-operational incidents before reading child tables", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const queryLog: QueryLogEntry[] = [];
    const db: Record<string, Array<Record<string, unknown>>> = {
      incidents: [
        {
          ...payload.incident,
          selected_fire: {
            ...payload.incident.selected_fire,
            fireafterNonOperational: true,
          },
          created_at: "2026-06-27T00:00:00.000Z",
        },
      ],
      source_snapshots: payload.sourceSnapshots,
      assets: payload.assets,
      recommendations: payload.recommendations,
    };

    getSupabaseAdminClientMock.mockReturnValue({
      from(table: string) {
        return {
          select() {
            return createReadBuilder(table, db, queryLog);
          },
        };
      },
    } as never);

    await expect(
      getSupabaseIncidentBundle(refreshed.incident.id),
    ).resolves.toBeNull();
    expect(queryLog.map((entry) => entry.table)).toEqual(["incidents"]);
  });

  it("uses unique database ids for repeated audit rows and compacts repeated domain audit ids in bundles", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const duplicateAuditPayload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
      auditEvents: [
        {
          id: "audit-incident-ventura-ca-created",
          incidentId: refreshed.incident.id,
          eventType: "IncidentCreated",
          actorName: "FireAfter",
          summary: "Repeated created audit event.",
          payload: {},
          createdAt: "2026-06-27T14:24:00.000Z",
        },
        {
          id: "audit-incident-ventura-ca-created",
          incidentId: refreshed.incident.id,
          eventType: "IncidentCreated",
          actorName: "FireAfter",
          summary: "Repeated created audit event.",
          payload: {},
          createdAt: "2026-06-27T14:25:00.000Z",
        },
      ],
    });
    const repeatedAuditPayload = {
      ...duplicateAuditPayload.auditEvents[0].payload,
      domainAuditEventId: "audit-incident-ventura-ca-created",
    };

    expect(new Set(duplicateAuditPayload.auditEvents.map((event) => event.id)).size).toBe(2);

    const bundle = mapSupabaseRowsToBundle({
      incident: {
        ...payload.incident,
        created_at: "2026-06-27T14:24:00.000Z",
      },
      assets: payload.assets,
      sourceSnapshots: payload.sourceSnapshots,
      recommendations: payload.recommendations,
      responderActions: [],
      auditEvents: [
        {
          ...duplicateAuditPayload.auditEvents[0],
          id: "11111111-1111-4111-8111-111111111111",
          payload: repeatedAuditPayload,
          created_at: "2026-06-27T14:24:00.000Z",
        },
        {
          ...duplicateAuditPayload.auditEvents[0],
          id: "22222222-2222-4222-8222-222222222222",
          payload: repeatedAuditPayload,
          created_at: "2026-06-27T14:25:00.000Z",
        },
      ],
    });

    expect(bundle.auditEvents.map((event) => event.id)).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("prefers current live source snapshots over legacy seeded snapshots", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const legacySnapshot = {
      ...payload.sourceSnapshots[0],
      id: "33333333-3333-4333-8333-333333333333",
      source_key: null,
      fetched_at: "2026-06-26T14:24:00.000Z",
      source_name: "NWS Forecast Grid",
      raw_payload: {
        domainSourceId: "source-incident-ventura-ca-legacy",
        detail: "legacy seeded source snapshot",
      },
    };

    const bundle = mapSupabaseRowsToBundle({
      incident: {
        ...payload.incident,
        created_at: "2026-06-27T14:24:00.000Z",
      },
      assets: payload.assets,
      sourceSnapshots: [legacySnapshot, ...payload.sourceSnapshots],
      recommendations: payload.recommendations,
      responderActions: [],
      auditEvents: payload.auditEvents,
    });

    expect(bundle.sourceSnapshots).toHaveLength(payload.sourceSnapshots.length);
    expect(bundle.sourceSnapshots.map((source) => source.detail)).not.toContain(
      "legacy seeded source snapshot",
    );
  });

  it("excludes stale recommendation rows from older refresh generations", async () => {
    const refreshed = fixtureBundle("ventura");
    const payload = buildSupabasePayload(refreshed, {
      assets: [fixtureAsset(refreshed.incident.id)],
    });
    const staleRecommendation = {
      ...payload.recommendations[0],
      id: "44444444-4444-4444-8444-444444444444",
      score_100: 99,
      score_breakdown: {
        ...payload.recommendations[0].score_breakdown,
        domainRecommendationId: "rec-incident-ventura-ca-stale-upload",
        assetName: "Stale Uploaded Culvert",
        createdAt: "2026-06-26T14:00:00.000Z",
      },
      created_at: "2026-06-26T14:00:00.000Z",
      changed_since_last_refresh: "Higher Risk",
    };

    const bundle = mapSupabaseRowsToBundle({
      incident: {
        ...payload.incident,
        created_at: "2026-06-27T14:24:00.000Z",
      },
      assets: payload.assets,
      sourceSnapshots: payload.sourceSnapshots,
      recommendations: [staleRecommendation, ...payload.recommendations],
      responderActions: [],
      auditEvents: payload.auditEvents,
    });

    expect(bundle.recommendations).toHaveLength(payload.recommendations.length);
    expect(bundle.recommendations.map((recommendation) => recommendation.assetName)).not.toContain(
      "Stale Uploaded Culvert",
    );
  });

  it("round-trips PWFDF basin payloads and source-linked asset evidence through JSONB mappings", () => {
    const refreshed = fixtureBundle("ventura");
    const pwfdf: SourceSnapshot = {
      id: "source-pwfdf",
      incidentId: refreshed.incident.id,
      sourceKey: "usgs-pwfdf",
      sourceName: "USGS PWFDF",
      fetchedAt: "2026-06-27T14:24:00.000Z",
      sourceUpdatedAt: "2026-06-20T00:00:00.000Z",
      status: "online",
      stale: false,
      freshnessLabel: "7 days ago",
      detail: "One validated basin loaded.",
      coverageStatus: "available",
      rawPayload: {
        assessment: {
          fireName: "Ventura",
          fireId: "Ventura_2026_v1",
          assessmentDate: "2026-06-20T00:00:00.000Z",
        },
        basinCount: 1,
        basins: [{
          id: "pwfdf-Ventura_2026_v1-42",
          fireId: "Ventura_2026_v1",
          assessmentDate: "2026-06-20T00:00:00.000Z",
          probabilityClass: "60-80%",
          volumeClass: "10,000-100,000",
          combinedHazard: "High",
          geometry: { type: "Polygon", coordinates: [[
            [-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.6],
            [-119.4, 34.6], [-119.4, 34.4],
          ]] },
        }],
      },
    };
    const linkedAsset: Asset = {
      ...fixtureAsset(refreshed.incident.id),
      evidence: [{
        sourceKey: "usgs-pwfdf",
        sourceName: "USGS PWFDF",
        sourceFeatureId: "pwfdf-Ventura_2026_v1-42",
        summary: "High combined hazard.",
      }],
      metrics: {
        ...fixtureAsset(refreshed.incident.id).metrics,
        pwfdfCombinedHazard: "High",
        pwfdfProbabilityClass: "60-80%",
        pwfdfAssessmentDate: "2026-06-20T00:00:00.000Z",
      },
    };
    const payload = buildSupabasePayload(
      { ...refreshed, sourceSnapshots: [...refreshed.sourceSnapshots, pwfdf] },
      { assets: [linkedAsset] },
    );
    const bundle = mapSupabaseRowsToBundle({
      incident: { ...payload.incident, created_at: "2026-06-27T14:24:00.000Z" },
      assets: payload.assets,
      sourceSnapshots: payload.sourceSnapshots,
      recommendations: payload.recommendations,
      responderActions: [],
      auditEvents: payload.auditEvents,
    });

    expect(bundle.sourceSnapshots.find((source) => source.sourceKey === "usgs-pwfdf")?.rawPayload)
      .toMatchObject({ basinCount: 1, basins: [expect.objectContaining({ combinedHazard: "High" })] });
    expect(bundle.assets[0]).toMatchObject({
      evidence: [expect.objectContaining({ sourceFeatureId: "pwfdf-Ventura_2026_v1-42" })],
      metrics: expect.objectContaining({ pwfdfCombinedHazard: "High" }),
    });
  });

  it("keeps current uploaded-asset recommendations after their change text becomes a movement summary", async () => {
    const refreshed = fixtureBundle("ventura");
    const uploadedAsset = {
      ...fixtureAsset(refreshed.incident.id),
      id: `asset-${refreshed.incident.id}-upload-1`,
      name: "Diamond Fork culvert Utah County GIS OBJECTID 4",
      type: "Culvert" as const,
      locationLabel: "Diamond Fork",
      source: "UtahCounty_Culverts_FS_OBJECTID_4.csv",
      confidence: "High" as const,
      localOrUploaded: true,
      origin: "uploaded" as const,
      sourceFeatureIds: [],
    };
    const uploadedRecommendation = {
      ...fixtureRecommendation(refreshed.incident.id),
      id: `rec-${refreshed.incident.id}-${uploadedAsset.id}`,
      assetId: uploadedAsset.id,
      assetName: uploadedAsset.name,
      assetType: uploadedAsset.type,
      locationLabel: uploadedAsset.locationLabel,
      changedSinceLastRefresh:
        "position unchanged (was #1, now #1), score stable. Sources updated: NWS Latest Observations (online -> online)",
      sourceSnapshotIds: ["nws"],
      createdAt: "2026-06-27T14:24:00.000Z",
    };
    const payload = buildSupabasePayload(
      {
        incident: refreshed.incident,
        sourceSnapshots: refreshed.sourceSnapshots,
        recommendations: [uploadedRecommendation, ...refreshed.recommendations],
      },
      {
        assets: [uploadedAsset, fixtureAsset(refreshed.incident.id)],
      },
    );

    const bundle = mapSupabaseRowsToBundle({
      incident: {
        ...payload.incident,
        created_at: "2026-06-27T14:24:00.000Z",
      },
      assets: payload.assets,
      sourceSnapshots: payload.sourceSnapshots,
      recommendations: payload.recommendations,
      responderActions: [],
      auditEvents: payload.auditEvents,
    });

    expect(bundle.recommendations.map((recommendation) => recommendation.assetName)).toContain(
      "Diamond Fork culvert Utah County GIS OBJECTID 4",
    );
    expect(
      bundle.recommendations.find(
        (recommendation) =>
          recommendation.assetName === "Diamond Fork culvert Utah County GIS OBJECTID 4",
      )?.locationLabel,
    ).toBe("Diamond Fork");
  });
});

function sourceCacheFixture() {
  const original = fixtureBundle("ventura");
  const payload = buildSupabasePayload(original, { assets: [fixtureAsset(original.incident.id)] });
  const db: Record<string, Array<Record<string, unknown>>> = {
    incidents: [payload.incident], assets: payload.assets, recommendations: payload.recommendations,
    source_snapshots: payload.sourceSnapshots, responder_actions: [], audit_events: [],
  };
  const queryLog: QueryLogEntry[] = [];
  const from = vi.fn((table: string) => ({ select: () => createReadBuilder(table, db, queryLog) }));
  getSupabaseAdminClientMock.mockReturnValue({ from } as never);
  return { original, payload, db, from, queryLog };
}

function fixtureBundle(seed: string): {
  incident: Incident;
  sourceSnapshots: SourceSnapshot[];
  recommendations: Recommendation[];
} {
  const incidentId = `incident-${seed}`;
  const incident: Incident = {
    id: incidentId,
    locationId: `${seed}-ca`,
    county: seed === "boulder" ? "Boulder County" : "Ventura County",
    state: seed === "boulder" ? "CO" : "CA",
    title: `${seed} FireAfter Watch`,
    code: `${seed.toUpperCase()}-FA-001`,
    status: "Storm Watch",
    stormWindow: "Next 48-72 hrs",
    rainfallForecast: "2.05 in forecast total rainfall",
    lastRefresh: "10:24 AM PDT",
    dataFreshness: "High",
    activeAlerts: 1,
    selectedFire: {
      name: "Current WFIGS Fire",
      acres: 15842,
      perimeterUpdated: "Jun 27, 2026, 10:00 AM EDT",
      source: "NIFC WFIGS Current Interagency Fire Perimeters",
      sourceKey: "wfigs",
      coverageStatus: "available",
    },
    locationContext: {
      id: `${seed}-ca`,
      county: seed === "boulder" ? "Boulder County" : "Ventura County",
      state: seed === "boulder" ? "CO" : "CA",
      label: seed === "boulder" ? "Boulder County, CO" : "Ventura County, CA",
      centroid: [-119.1391, 34.3705],
      bbox: [-119.6, 34, -118.6, 34.7],
      fips: seed === "boulder" ? "08013" : "06111",
      fireWeatherZone: "auto",
      population: 1,
      wildfireContext: "Fixture county context.",
      coverageStatus: "available",
    },
    coverageStatus: "available",
  };
  const sourceSnapshots: SourceSnapshot[] = [
    {
      id: `source-${incidentId}-nws`,
      incidentId,
      sourceKey: "nws",
      sourceName: "NWS Forecast Grid and Active Alerts",
      fetchedAt: "2026-06-27T14:24:00.000Z",
      sourceUpdatedAt: "2026-06-27T14:00:00.000Z",
      status: "online",
      stale: false,
      freshnessLabel: "24 min ago",
      detail: "NWS quantitative precipitation loaded.",
      coverageStatus: "available",
      rawPayload: {},
      derivedSignals: { rainfallThreat: 0.82 },
    },
  ];
  return {
    incident,
    sourceSnapshots,
    recommendations: [fixtureRecommendation(incidentId)],
  };
}

function fixtureAsset(incidentId: string): Asset {
  return {
    id: `asset-${incidentId}-crossing`,
    incidentId,
    name: "Pine Creek Road @ Canyon Creek",
    type: "Inferred Crossing",
    locationLabel: "Canyon Creek",
    coordinates: [-119.22, 34.45],
    geometry: { type: "Point", coordinates: [-119.22, 34.45] },
    source: "Census TIGERweb roads + USGS 3DHP flowlines",
    confidence: "Medium",
    localOrUploaded: false,
    origin: "inferred",
    sourceFeatureIds: ["road-1", "flowline-1"],
    coverageStatus: "partial",
    metrics: {
      inferenceGeometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
      slopeTerrain: 0.7,
      downstreamExposure: 0.8,
    },
  };
}

function fixtureRecommendation(incidentId: string): Recommendation {
  const asset = fixtureAsset(incidentId);
  return {
    id: `rec-${incidentId}-${asset.id}`,
    incidentId,
    assetId: asset.id,
    assetName: asset.name,
    assetType: asset.type,
    locationLabel: asset.locationLabel,
    coordinates: asset.coordinates,
    recommendedAction: "Inspect inferred crossing and upstream channel.",
    finalScore: 0.72,
    score100: 72,
    riskLevel: "High",
    confidenceLevel: "Medium",
    reasonCodes: ["Heavy Rain Forecast", "Official Road Geometry"],
    limitations: ["Inferred crossing requires field verification."],
    changedSinceLastRefresh: "Source-Backed Candidate",
    sourcesUpdatedLabel: "24 min ago",
    dataFreshnessHours: 1,
    scoreBreakdown: {
      rainfallThreat: 0.82,
      burnSeverity: 0.7,
      slopeTerrain: 0.7,
      downstreamExposure: 0.8,
      dataFreshness: 0.9,
      confidenceMultiplier: 0.8,
      baseScore: 0.8,
      finalScore: 0.72,
      metricStatus: {
        rainfallThreat: "available",
        burnSeverity: "available",
        slopeTerrain: "available",
        downstreamExposure: "available",
        dataFreshness: "available",
      },
    },
    evidence: asset.evidence,
    sourceSnapshotIds: ["nws"],
    createdAt: "2026-06-27T14:24:00.000Z",
  };
}

function createReadBuilder(
  table: string,
  db: Record<string, Array<Record<string, unknown>>>,
  queryLog: QueryLogEntry[] = [],
  rejectedTables: Set<string> = new Set(),
) {
  const rows = () => db[table] ?? [];
  let filter: QueryFilter | undefined;
  const filters: QueryFilter[] = [];
  let orderColumn: string | undefined;
  let ascending = true;
  const orders: { column: string; ascending: boolean }[] = [];
  let limitCount: number | undefined;
  let afterId: string | undefined;

  const execute = () => {
    let data = rows();
    for (const activeFilter of filters) {
      if (activeFilter.type === "eq") {
        if (table === "responder_actions" && activeFilter.column === "recommendations.incident_id") {
          data = data.flatMap(row => {
            const parent = db.recommendations?.find(recommendation => recommendation.id === row.recommendation_id);
            return parent?.incident_id === activeFilter.value ? [{ ...row, recommendations: { incident_id: parent.incident_id } }] : [];
          });
        } else data = data.filter((row) => row[activeFilter.column] === activeFilter.value);
      }
      if (activeFilter.type === "in") {
        data = data.filter((row) => activeFilter.values.includes(String(row[activeFilter.column])));
      }
      if (activeFilter.type === "contains") {
        data = data.filter((row) => Object.entries(activeFilter.value).every(([key, value]) =>
          (row[activeFilter.column] as Record<string, unknown> | undefined)?.[key] === value));
      }
    }
    if (orders.length) data = [...data].sort((a, b) => {
      for (const order of orders) {
        const delta = String(a[order.column] ?? "").localeCompare(String(b[order.column] ?? "")) * (order.ascending ? 1 : -1);
        if (delta) return delta;
      }
      return 0;
    });
    if (afterId !== undefined) data = data.filter((row) => String(row.id) > afterId!);
    const count = data.length;
    data = data.slice(0, Math.min(limitCount ?? 1000, 1000));
    if (table === "source_snapshots" && filters.some(item => item.type === "in" && item.column === "id")) {
      data = data.map(row => queueSourceProjection(row as Parameters<typeof queueSourceProjection>[0]));
    }
    queryLog.push({
      table,
      filter,
      orderColumn,
      ascending,
      limitCount,
    });
    if (rejectedTables.has(table)) {
      return Promise.reject(new Error("simulated audit query timeout"));
    }
    return Promise.resolve({
      data,
      count,
      error: null,
    });
  };

  const builder = {
    abortSignal(signal: AbortSignal) {
      expect(signal).toBeInstanceOf(AbortSignal);
      return builder;
    },
    retry(enabled: boolean) {
      expect(enabled).toBe(false);
      return builder;
    },
    gt(column: string, value: string) {
      expect(column).toBe("id");
      afterId = value;
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      if (!orderColumn) { orderColumn = column; ascending = options?.ascending ?? true; }
      orders.push({ column, ascending: options?.ascending ?? true });
      return builder;
    },
    limit(count: number) {
      limitCount = count;
      return builder;
    },
    eq(column: string, value: string) {
      filter = { type: "eq", column, value };
      filters.push(filter);
      return builder;
    },
    in(column: string, values: string[]) {
      filter = { type: "in", column, values };
      filters.push(filter);
      return builder;
    },
    contains(column: string, value: Record<string, unknown>) {
      filter = { type: "contains", column, value };
      filters.push(filter);
      return builder;
    },
    maybeSingle() {
      return execute().then((result) => ({
        data: result.data.length === 1 ? result.data[0] : null,
        error: result.data.length > 1 ? { code: "PGRST116", message: "Multiple rows for singular query" } : result.error,
      }));
    },
    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?:
        | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return execute().then(onfulfilled, onrejected);
    },
  };

  return builder;
}

type QueryResult = {
  count?: number | null;
  data: Record<string, unknown>[];
  error: null;
};

type QueryFilter =
  | {
      type: "eq";
      column: string;
      value: string;
    }
  | {
      type: "in";
      column: string;
      values: string[];
    }
  | {
      type: "contains";
      column: string;
      value: Record<string, unknown>;
    };

type QueryLogEntry = {
  table: string;
  filter?: QueryFilter;
  orderColumn?: string;
  ascending?: boolean;
  limitCount?: number;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


function commandContext(incident: Record<string, unknown>) {
  const selected = incident.selected_fire as { inventoryManifest?: { revision: string } } | undefined;
  return { commandId: "d5554057-33bc-4e55-8d4a-2a4421eab174",
    expectedRevision: selected?.inventoryManifest?.revision ?? "0ca1f8d8-a8bb-440a-a4bf-ddbbf31a0069",
    actorId: "00000000-0000-4000-8000-000000000001", actorOrganizationId: String(incident.organization_id) };
}

function commandReceipt(name: string, args: { p_action?: unknown; p_audit_event?: unknown; p_operation_id?: string; p_request_hash?: string;
  p_incident?: { id: string; selected_fire: { inventoryManifest: { revision: string } } };
  p_audit_events?: { id: string; payload?: { assetCount?: number } }[] }) {
  // Controlled transport only. SQL atomicity, validation and grants are not emulated.
  if (name === IMPORT_COMMIT_RPC) return Promise.resolve({ data: {
    operationId: args.p_operation_id, requestHash: args.p_request_hash,
    incidentId: args.p_incident!.id, revision: args.p_incident!.selected_fire.inventoryManifest.revision,
    auditEventId: args.p_audit_events![0].id, assetCount: args.p_audit_events![0].payload?.assetCount ?? 1,
    committedAt: "2026-09-14T09:00:00Z",
  }, error: null });
  return Promise.resolve({ data: args.p_action ? { action: args.p_action, auditEvent: args.p_audit_event } : null, error: null });
}
