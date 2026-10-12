import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProductPromiseAudit } from "./product-promise";
import { fetchPwfdfSource, runLiveSourceRefresh, type LiveRefreshInput } from "./live-sources";
import { buildSupabasePayload, mapSupabaseRowsToBundle } from "./fireafter-supabase";
import { buildOperationalHealth } from "./readiness";
import { redactSensitiveBundleForPublic } from "./sensitive-infrastructure";
import { evidenceMaxAgeMinutes, projectBundleFreshness } from "./source-freshness";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: () => null, getSupabaseServerClient: () => null }));
import type {
  Asset,
  AuditEvent,
  Incident,
  Recommendation,
  ResponderAction,
  SourceSnapshot,
} from "./types";

describe("buildProductPromiseAudit", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-06-28T00:10:00.000Z")); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it.each([15, 60])("uses the configured %i-minute policy consistently at the linkage expiry boundary", minutes => {
    vi.stubEnv("FIREAFTER_CACHE_TTL_MINUTES", String(minutes));
    const original = readyBundle();
    const before = structuredClone(original);
    const fetchedAt = Date.parse(original.sourceSnapshots[0].fetchedAt);
    for (const delta of [-1, 0]) {
      const now = new Date(fetchedAt + minutes * 60_000 + delta);
      const projected = projectBundleFreshness(original, now, evidenceMaxAgeMinutes());
      const pwfdf = projected.sourceSnapshots.find(source => source.sourceKey === "usgs-pwfdf")!;
      expect(pwfdf.freshness?.state).toBe(delta < 0 ? "current" : "expired");
      const expected = delta < 0 ? "pass" : "gap";
      expect(gate(buildProductPromiseAudit(original, now), "basin_asset_linkage").status).toBe(expected);
      expect(gate(buildOperationalHealth(original, undefined, now.toISOString()).productPromise, "basin_asset_linkage").status).toBe(expected);
    }
    expect(original).toEqual(before);
  });

  it("never extends provider validity or revives a previously expired source under a longer TTL", () => {
    vi.stubEnv("FIREAFTER_CACHE_TTL_MINUTES", "60");
    const original = readyBundle();
    const pwfdf = original.sourceSnapshots.find(source => source.sourceKey === "usgs-pwfdf")!;
    const now = new Date("2026-06-28T00:10:00.000Z");
    pwfdf.validUntil = now.toISOString();
    expect(gate(buildProductPromiseAudit(original, now), "basin_asset_linkage").status).toBe("gap");
    delete pwfdf.validUntil;
    const previouslyExpired = projectBundleFreshness(original, now, 5);
    expect(gate(buildProductPromiseAudit(previouslyExpired, now), "basin_asset_linkage").status).toBe("gap");
  });

  it.each([
    "outside", "hole", "wrong-asset", "wrong-incident", "foreign-asset",
    "moved-recommendation", "borrowed-basin", "duplicate-asset", "missing-snapshot",
    "stale-snapshot", "wrong-fire", "unbound-fire", "changed-perimeter",
    "foreign-source", "duplicate-source", "partial-basins", "duplicate-basin",
    "invalid-geometry", "missing-asset-evidence", "legacy-inference",
    "coerced-coordinate", "provider-stale", "missing-version", "duplicate-recommendation",
    "old-discovery-version", "missing-discovery", "partial-discovery", "discovery-count-mismatch",
    "missing-analysis-version", "old-analysis-version",
  ])("rejects invalid basin relationship: %s", (mode) => {
    const bundle = readyBundle();
    const pwfdf = bundle.sourceSnapshots.find((source) => source.sourceKey === "usgs-pwfdf")!;
    const raw = pwfdf.rawPayload as ReturnType<typeof pwfdfRawPayload>;
    if (mode === "missing-analysis-version") delete (pwfdf.rawPayload as Record<string, unknown>).analysisGeometryVersion;
    if (mode === "old-analysis-version") raw.analysisGeometryVersion = "2026-09-14-basin-topology-v1";
    if (mode === "old-discovery-version") raw.linkageVersion = "2026-09-13-pwfdf-linkage-v1";
    if (mode === "missing-discovery") delete (pwfdf.rawPayload as Record<string, unknown>).assessmentDiscovery;
    if (mode === "partial-discovery") raw.assessmentDiscovery.complete = false;
    if (mode === "discovery-count-mismatch") raw.assessmentDiscovery.receivedCount = 0;
    if (mode === "outside") bundle.assets[0].coordinates = bundle.recommendations[0].coordinates = [-119, 34];
    if (mode === "hole") raw.basins[0].geometry.coordinates.push([
      [-119.31, 34.47], [-119.29, 34.47], [-119.29, 34.49], [-119.31, 34.49], [-119.31, 34.47],
    ]);
    if (mode === "wrong-asset") bundle.recommendations[0].assetId = "missing-asset";
    if (mode === "wrong-incident") bundle.recommendations[0].incidentId = "other-incident";
    if (mode === "foreign-asset") bundle.assets[0].incidentId = "other-incident";
    if (mode === "moved-recommendation") bundle.recommendations[0].coordinates = [-119.3, 34.5];
    if (mode === "borrowed-basin") {
      raw.basins.push({ ...structuredClone(raw.basins[0]), id: "different-basin" });
      raw.basinCount = 2;
      bundle.recommendations[0].evidence = [{ sourceKey: "usgs-pwfdf", sourceName: "USGS", sourceFeatureId: "different-basin", summary: "Test-only wrong relationship" }];
    }
    if (mode === "duplicate-asset") bundle.assets.push(structuredClone(bundle.assets[0]));
    if (mode === "missing-snapshot") bundle.recommendations[0].sourceSnapshotIds = ["usgs-pwfdf"];
    if (mode === "stale-snapshot") pwfdf.fetchedAt = "2026-06-27T00:00:00.000Z";
    if (mode === "wrong-fire") raw.assessment.fireName = "Unrelated Fire";
    if (mode === "unbound-fire") delete (pwfdf.rawPayload as Record<string, unknown>).selectedFire;
    if (mode === "changed-perimeter") bundle.incident.selectedFire.sourceFeatureId = "replacement-perimeter";
    if (mode === "foreign-source") pwfdf.incidentId = "other-incident";
    if (mode === "duplicate-source") bundle.sourceSnapshots.push(structuredClone(pwfdf));
    if (mode === "partial-basins") raw.basinCount = 2;
    if (mode === "duplicate-basin") { raw.basins.push(structuredClone(raw.basins[0])); raw.basinCount = 2; }
    if (mode === "invalid-geometry") raw.basins[0].geometry.type = "NotAPolygon";
    if (mode === "missing-asset-evidence") bundle.assets[0].evidence = [];
    if (mode === "legacy-inference") bundle.assets[0].origin = "inferred";
    if (mode === "coerced-coordinate") (raw.basins[0].geometry.coordinates[0][0] as unknown[])[0] = "-119.4";
    if (mode === "provider-stale") pwfdf.stale = true;
    if (mode === "missing-version") delete (pwfdf.rawPayload as Record<string, unknown>).linkageVersion;
    if (mode === "duplicate-recommendation") bundle.recommendations.push(structuredClone(bundle.recommendations[0]));

    const original = structuredClone(bundle);
    const result = gate(buildProductPromiseAudit(bundle), "basin_asset_linkage");
    expect(result.status).toBe("gap");
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(bundle).toEqual(original);
  });

  it("does not hide a broken claimed link behind another valid recommendation", () => {
    const bundle = readyBundle();
    bundle.recommendations.push({ ...recommendation(), id: "broken-rec", assetId: "missing-asset" });
    expect(gate(buildProductPromiseAudit(bundle), "basin_asset_linkage").status).toBe("gap");
  });

  it("does not hide an invalid asset claim behind a different valid asset", () => {
    const bundle = readyBundle();
    bundle.assets.push({ ...asset(), id: "outside-asset", coordinates: [-119, 34] });
    expect(gate(buildProductPromiseAudit(bundle), "basin_asset_linkage").status).toBe("gap");
  });

  it("bounds aggregate basin containment during readiness instead of resetting per asset", () => {
    const bundle = readyBundle();
    const raw = bundle.sourceSnapshots.find(source => source.sourceKey === "usgs-pwfdf")!.rawPayload as ReturnType<typeof pwfdfRawPayload>;
    const center = bundle.assets[0].coordinates;
    const ring = Array.from({ length: 1000 }, (_, i) => [center[0] + Math.cos(i * Math.PI / 500), center[1] + Math.sin(i * Math.PI / 500)]);
    ring.push([...ring[0]]);
    raw.basins[0].geometry.coordinates = [ring];
    bundle.assets = Array.from({ length: 2001 }, (_, i) => ({ ...bundle.assets[0], id: `budget-${i}` }));
    const result = gate(buildProductPromiseAudit(bundle), "basin_asset_linkage");
    expect(result.status).toBe("gap");
    expect(result.gaps.join(" ")).toMatch(/validation budget/);
    expect(result.evidence).toEqual([]);
  });

  it.each(["Polygon", "MultiPolygon"])("preserves real adapter %s linkage and snapshot identities through refresh and JSONB mapping", async geometryType => {
    const original = readyBundle();
    const keys = { nws: "nws", observations: "nws-observations", wfigs: "wfigs", wfigsYtd: "wfigs-ytd",
      firms: "firms", mtbs: "mtbs-burn-severity", pwfdf: "usgs-pwfdf", roads: "tiger-roads",
      hydro: "3dhp-flowlines", epqs: "usgs-epqs", bridges: "nbi-bridges", structures: "tnm-structures" };
    const refresh = async (now: Date) => {
      const adapters = Object.fromEntries(Object.entries(keys).map(([key, sourceKey]) => [key, async () => ({
        ...source(sourceKey, "online", "available"), fetchedAt: now.toISOString(),
        warnings: [], rawPayload: {}, derivedSignals: {},
      })])) as NonNullable<LiveRefreshInput["adapters"]>;
      adapters.pwfdf = async (incident) => fetchPwfdfSource(incident.locationContext!, incident, {
        now,
        fetchImpl: async (url) => {
          const basin = pwfdfRawPayload().basins[0];
          if (geometryType === "MultiPolygon") basin.geometry.coordinates.push(basin.geometry.coordinates[0].map(([x, y]) => [x + 1, y]));
          const locations = String(url).includes("/0/query");
          if (locations && new URL(String(url)).searchParams.get("returnIdsOnly") === "true") {
            return Response.json({ objectIdFieldName: "OBJECTID", objectIds: [1] });
          }
          return Response.json({ features: [{ attributes: locations
            ? { OBJECTID: 1, fire: "Canyon", Fire_ID: basin.fireId, assessment_date: basin.assessmentDate }
            : { OBJECTID: 42, fire_id: basin.fireId, assessment_date: basin.assessmentDate,
              BP_Legend: basin.probabilityClass, BV_Legend: basin.volumeClass, BCH_Legend: basin.combinedHazard },
          ...(!locations ? { geometry: { rings: basin.geometry.coordinates } } : {}) }] });
        },
      });
      return runLiveSourceRefresh({ incident: original.incident,
        assets: [{ ...asset(), localOrUploaded: true, sourceKey: "local-upload", metrics: { slopeTerrain: 0.2, downstreamExposure: 0.3 } }],
        adapters, now, fetchImpl: async () => { throw new Error("Unexpected network call in test"); },
      });
    };
    const now = new Date("2026-06-28T00:10:00.000Z");
    const refreshed = await refresh(now);
    expect(refreshed.recommendations).toHaveLength(1);
    expect(refreshed.recommendations[0].riskLevel).toBe("Unknown");
    expect(refreshed.recommendations[0].sourceSnapshotIds).toEqual(refreshed.sourceSnapshots.map((source) => source.id));
    const payload = JSON.parse(JSON.stringify(buildSupabasePayload(refreshed, { assets: refreshed.assets }))) as ReturnType<typeof buildSupabasePayload>;
    const reloaded = mapSupabaseRowsToBundle({ incident: payload.incident, assets: payload.assets,
      recommendations: payload.recommendations, sourceSnapshots: payload.sourceSnapshots, responderActions: [], auditEvents: [] });
    const reloadedGate = gate(buildProductPromiseAudit(reloaded, now), "basin_asset_linkage");
    const beforeBasins = refreshed.sourceSnapshots.find(source => source.sourceKey === "usgs-pwfdf")!.rawPayload!.basins;
    const afterBasins = reloaded.sourceSnapshots.find(source => source.sourceKey === "usgs-pwfdf")!.rawPayload!.basins;
    expect(afterBasins).toEqual(beforeBasins);
    expect(reloaded.sourceSnapshots.find(source => source.sourceKey === "usgs-pwfdf")!.rawPayload!.analysisGeometryVersion)
      .toBe("2026-09-14-provider-resolution-v1");
    expect((afterBasins as Array<{ geometry: { type: string } }>)[0].geometry.type).toBe(geometryType);
    expect(reloaded.assets[0].incidentId).toBe(reloaded.incident.id);
    expect(reloadedGate.status, JSON.stringify(reloadedGate)).toBe("pass");
    const futureSource = structuredClone(reloaded);
    const publication = futureSource.sourceSnapshots.find(source => source.sourceKey === "usgs-pwfdf")!;
    publication.sourceTimeBasis = undefined;
    publication.sourceUpdatedAt = new Date(now.getTime() + 1).toISOString();
    const futureGate = gate(buildProductPromiseAudit(futureSource, now), "basin_asset_linkage");
    expect(futureGate.status).toBe("gap");
    expect(futureGate.evidence).toEqual([]);
    const foreignPayload = structuredClone(payload);
    foreignPayload.assets[0].incident_id = "00000000-0000-4000-8000-000000000099";
    expect(() => mapSupabaseRowsToBundle({ incident: foreignPayload.incident, assets: foreignPayload.assets,
      recommendations: foreignPayload.recommendations, sourceSnapshots: foreignPayload.sourceSnapshots, responderActions: [], auditEvents: [] })).toThrow(/inventory/i);
    expect(gate(buildProductPromiseAudit(redactSensitiveBundleForPublic(reloaded), now), "basin_asset_linkage").status).toBe("pass");
    const next = await refresh(new Date("2026-06-28T00:15:00.000Z"));
    expect(next.sourceSnapshots.find((source) => source.sourceKey === "usgs-pwfdf")!.id)
      .not.toBe(refreshed.sourceSnapshots.find((source) => source.sourceKey === "usgs-pwfdf")!.id);
    const mixed = { ...reloaded, sourceSnapshots: next.sourceSnapshots };
    expect(gate(buildProductPromiseAudit(mixed, new Date("2026-06-28T00:15:00.000Z")), "basin_asset_linkage").status).toBe("gap");
    const report = buildOperationalHealth(mixed, {
      supabaseConfigured: true, supabaseSchemaReady: true, serverOwnedWritesVerified: true,
      atomicResponderActionWriteVerified: true, atomicBundlePersistenceWriteVerified: true,
      operatorAccountIssuanceAuditVerified: true, nasaFirmsConfigured: true, nwsUserAgentConfigured: true, cronSecretConfigured: true,
    }, "2026-06-28T00:15:00.000Z");
    expect(report.overallStatus).toBe("blocked");
    expect(gate(report.productPromise, "basin_asset_linkage").status).toBe("gap");
  });

  it("does not reveal redacted facility identities through linkage diagnostics", () => {
    const bundle = readyBundle();
    bundle.assets[0].type = "Critical Facility";
    bundle.recommendations[0].assetType = "Critical Facility";
    const publicBundle = redactSensitiveBundleForPublic(bundle);
    const result = gate(buildProductPromiseAudit(publicBundle), "basin_asset_linkage");
    expect(result.status).toBe("gap");
    expect(JSON.stringify(result)).not.toContain(bundle.assets[0].id);
    expect(JSON.stringify(result)).not.toContain(bundle.assets[0].name);
    expect(JSON.stringify(result)).not.toContain("pwfdf-Canyon_2026_v1-42");
  });

  it("passes product promise gates when source coverage, recommendations, and audit snapshots are complete", () => {
    const gates = buildProductPromiseAudit(readyBundle());

    expect(gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "data_integration", status: "pass" }),
        expect.objectContaining({ id: "geospatial_view", status: "pass" }),
        expect.objectContaining({ id: "basin_asset_linkage", status: "pass" }),
        expect.objectContaining({ id: "ranked_action_queue", status: "pass" }),
        expect.objectContaining({ id: "responsible_handling", status: "pass" }),
        expect.objectContaining({ id: "auditability", status: "pass" }),
      ]),
    );
  });

  it("finds ranked-item gaps when recommendations lack required clarity fields", () => {
    const gates = buildProductPromiseAudit({
      ...readyBundle(),
      recommendations: [
        {
          ...recommendation(),
          reasonCodes: [],
          sourcesUpdatedLabel: "",
          confidenceLevel: "Low",
          limitations: [],
          evidence: [],
        },
      ],
    });

    expect(gate(gates, "ranked_action_queue").status).toBe("gap");
    expect(gate(gates, "ranked_action_queue").gaps).toEqual(
      expect.arrayContaining([
        "Top recommendations need visible reason codes, source timestamps, limitations, and evidence.",
      ]),
    );
  });

  it("does not accept metadata-only PWFDF coverage as basin-to-asset proof", () => {
    const bundle = readyBundle();
    bundle.sourceSnapshots = bundle.sourceSnapshots.map((item) =>
      item.sourceKey === "usgs-pwfdf" ? { ...item, rawPayload: { available: true } } : item,
    );

    const result = gate(buildProductPromiseAudit(bundle), "basin_asset_linkage");

    expect(result.status).toBe("gap");
    expect(result.gaps).toContain(
      "A validated USGS PWFDF combined-hazard basin layer must be available for the selected fire.",
    );
  });

  it("distinguishes available PWFDF basins from missing asset overlap", () => {
    const bundle = readyBundle();
    const outsideAsset = {
      ...asset(),
      coordinates: [-119, 34] as [number, number],
      evidence: [
        {
          sourceKey: "tiger-roads",
          sourceName: "TIGERweb Roads",
          summary: "Road geometry outside the returned basin layer.",
        },
      ],
    };
    bundle.assets = [outsideAsset];
    bundle.recommendations = [{
      ...recommendation(),
      assetId: outsideAsset.id,
      coordinates: outsideAsset.coordinates,
      evidence: outsideAsset.evidence,
    }];

    const result = gate(buildProductPromiseAudit(bundle), "basin_asset_linkage");

    expect(result.status).toBe("gap");
    expect(result.evidence).toContain(
      "1 validated USGS PWFDF basin and 1 asset are loaded, but no current asset-to-basin evidence link can be verified.",
    );
    expect(result.nextAction).toContain("No current asset-to-basin link is verified");
    expect(result.nextAction).toContain("overlapping source assets");
  });

  it("detects when basin-linked asset evidence is dropped from recommendations", () => {
    const bundle = readyBundle();
    bundle.recommendations = [{
      ...recommendation(),
      evidence: [],
    }];

    const result = gate(buildProductPromiseAudit(bundle), "basin_asset_linkage");

    expect(result.status).toBe("gap");
    expect(result.gaps).toContain(
      "A basin-linked asset exists, but its recommendation lost the exact PWFDF feature evidence.",
    );
    expect(result.nextAction).toContain("recommendation evidence is rebuilt");
  });

  it("makes the PWFDF refresh prerequisite actionable for read-only sessions", () => {
    const bundle = { ...readyBundle(), currentUser: null };
    bundle.sourceSnapshots = bundle.sourceSnapshots.map((item) =>
      item.sourceKey === "usgs-pwfdf"
        ? {
            ...item,
            coverageStatus: "not_available",
            rawPayload: { available: false },
          }
        : item,
    );

    const result = gate(buildProductPromiseAudit(bundle), "basin_asset_linkage");

    expect(result.status).toBe("gap");
    expect(result.nextAction).toContain("operator-issued");
    expect(result.nextAction).toContain("incident commander or analyst");
  });

  it("requires replacing a stale saved fire context before the refresh action", () => {
    const bundle = {
      ...readyBundle(),
      incident: {
        ...readyBundle().incident,
        selectedFire: {
          ...readyBundle().incident.selectedFire,
          sourceKey: "wfigs",
          sourceFeatureId: "stale-fire-1",
          coverageStatus: "not_available" as const,
        },
        fireCandidates: [
          {
            name: "Current Fire",
            acres: 1200,
            perimeterUpdated: "2026-06-28T00:00:00.000Z",
            source: "NIFC WFIGS",
            sourceKey: "wfigs" as const,
            sourceFeatureId: "current-fire-1",
            coverageStatus: "available" as const,
          },
        ],
      },
      sourceSnapshots: readyBundle().sourceSnapshots.map((item) =>
        item.sourceKey === "usgs-pwfdf"
          ? {
              ...item,
              coverageStatus: "not_available" as const,
              rawPayload: { available: false },
            }
          : item,
      ),
    };

    const result = gate(buildProductPromiseAudit(bundle), "basin_asset_linkage");

    expect(result.status).toBe("gap");
    expect(result.nextAction).toContain("Select a currently published WFIGS");
    expect(result.nextAction).toContain("then run Refresh");
  });

  it("flags unsafe emergency-command language without blocking safe evacuation-route context", () => {
    const gates = buildProductPromiseAudit({
      ...readyBundle(),
      recommendations: [
        {
          ...recommendation(),
          assetType: "Evacuation Route",
          recommendedAction: "Automatically close the road and order evacuation now.",
        },
      ],
    });

    expect(gate(gates, "responsible_handling").status).toBe("gap");
    expect(gate(gates, "responsible_handling").gaps).toContain(
      "Remove automatic closure, evacuation order, or exact-prediction language from recommendation copy.",
    );
  });

  it("flags closure-review style language as unsafe", () => {
    const gates = buildProductPromiseAudit({
      ...readyBundle(),
      recommendations: [
        {
          ...recommendation(),
          assetType: "Road Crossing",
          recommendedAction: "Inspect crossing and prepare for closure review before dispatch.",
        },
      ],
    });

    expect(gate(gates, "responsible_handling").status).toBe("gap");
  });

  it("requires audit records to preserve actor, timestamp, note, snapshot, and source evidence", () => {
    const gates = buildProductPromiseAudit({
      ...readyBundle(),
      actions: [
        {
          ...action(),
          note: "",
          actorName: "",
          recommendationSnapshot: {
            ...recommendation(),
            evidence: [],
          },
        },
      ],
      auditEvents: [
        {
          ...auditEvent(),
          payload: {},
        },
      ],
    });

    expect(gate(gates, "auditability").status).toBe("gap");
    expect(gate(gates, "auditability").gaps).toEqual(
      expect.arrayContaining([
        "Responder actions must preserve actor, timestamp, note, recommendation snapshot, and source evidence.",
      ]),
    );
  });
});

function gate(gates: ReturnType<typeof buildProductPromiseAudit>, id: string) {
  const found = gates.find((item) => item.id === id);
  if (!found) throw new Error(`Missing gate ${id}`);
  return found;
}

function readyBundle() {
  return {
    incident: activeIncident(),
    assets: [asset()],
    sourceSnapshots: [
      source("nws", "online", "available"),
      source("wfigs", "online", "available"),
      source("firms", "online", "available"),
      source("tiger-roads", "online", "available", {
        features: [{ id: "road-1", coordinates: [[-119.31, 34.48], [-119.3, 34.49]] }],
      }),
      source("3dhp-flowlines", "online", "available", {
        features: [{ id: "flow-1", coordinates: [[-119.32, 34.47], [-119.29, 34.5]] }],
      }),
      source("usgs-epqs", "online", "available"),
      source("usgs-pwfdf", "online", "available", pwfdfRawPayload()),
    ],
    recommendations: [recommendation()],
    actions: [action()],
    auditEvents: [auditEvent()],
    currentUser: {
      id: "user-1",
      email: "commander@example.com",
      role: "incident_commander" as const,
    },
  };
}

function activeIncident(): Incident {
  return {
    id: "incident-ventura",
    locationId: "ventura-county-ca",
    county: "Ventura County",
    state: "CA",
    title: "Ventura County Storm Watch",
    code: "CA-FA-06111-001",
    status: "Storm Watch",
    stormWindow: "Next 48-72 hrs",
    rainfallForecast: "0.75 - 1.25 in",
    lastRefresh: "10:24 AM PDT",
    dataFreshness: "High",
    activeAlerts: 1,
    selectedFire: {
      name: "Canyon Fire",
      acres: 1200,
      perimeterUpdated: "2026-06-28T00:00:00.000Z",
      source: "NIFC WFIGS",
      sourceKey: "wfigs",
      sourceFeatureId: "canyon-perimeter-1",
      coverageStatus: "available",
    },
    locationContext: {
      id: "ventura-county-ca",
      county: "Ventura County",
      state: "CA",
      label: "Ventura County, CA",
      centroid: [-119.1391, 34.3705],
      bbox: [-119.4778, 33.9905, -118.6325, 34.9011],
      fips: "06111",
      fireWeatherZone: "auto",
      population: 0,
      wildfireContext: "Live Census TIGERweb county geometry loaded.",
      sourceKey: "tigerweb-counties",
      coverageStatus: "available",
      boundary: {
        type: "Polygon",
        coordinates: [[[-119.47, 33.99], [-118.63, 33.99], [-118.63, 34.9], [-119.47, 34.9], [-119.47, 33.99]]],
      },
    },
    coverageStatus: "available",
  };
}

function source(
  sourceKey: string,
  status: SourceSnapshot["status"],
  coverageStatus: NonNullable<SourceSnapshot["coverageStatus"]>,
  rawPayload: Record<string, unknown> = {},
): SourceSnapshot {
  return {
    id: `source-${sourceKey}`,
    incidentId: "incident-ventura",
    sourceKey,
    sourceName: sourceKey,
    fetchedAt: "2026-06-28T00:00:00.000Z",
    sourceUpdatedAt: "2026-06-28T00:00:00.000Z",
    status,
    stale: false,
    freshnessLabel: "Fresh",
    detail: "Source returned data.",
    coverageStatus,
    warnings: [],
    rawPayload,
  };
}

function asset(): Asset {
  return {
    id: "asset-1",
    incidentId: "incident-ventura",
    name: "SR-33 @ Matilija Creek",
    type: "Road Crossing",
    locationLabel: "Matilija Creek",
    coordinates: [-119.303, 34.481],
    geometry: { type: "Point", coordinates: [-119.303, 34.481] },
    source: "TIGERweb roads + USGS 3DHP flowline",
    confidence: "High",
    localOrUploaded: false,
    sourceKey: "tiger-roads",
    sourceFeatureIds: ["road-1", "flowline-1"],
    coverageStatus: "available",
    evidence: [
      {
        sourceKey: "tiger-roads",
        sourceName: "TIGERweb Roads",
        summary: "Road line matched nearby hydrography.",
      },
      {
        sourceKey: "usgs-pwfdf",
        sourceName: "USGS PWFDF",
        sourceFeatureId: "pwfdf-Canyon_2026_v1-42",
        summary: "High combined debris-flow hazard.",
      },
    ],
  };
}

function recommendation(): Recommendation {
  return {
    id: "rec-1",
    incidentId: "incident-ventura",
    assetId: "asset-1",
    assetName: "SR-33 @ Matilija Creek",
    assetType: "Road Crossing",
    locationLabel: "Matilija Creek",
    coordinates: [-119.303, 34.481],
    recommendedAction: "Inspect road crossing and review debris conditions with road crew.",
    finalScore: 0.72,
    score100: 72,
    riskLevel: "High",
    confidenceLevel: "High",
    reasonCodes: ["Rainfall Threshold Proximity", "Burn Severity", "Downstream Exposure"],
    limitations: ["Screening-level source data; field validation remains required."],
    changedSinceLastRefresh: "Source-Backed Candidate",
    sourcesUpdatedLabel: "Fresh",
    dataFreshnessHours: 1,
    scoreBreakdown: {
      rainfallThreat: 0.7,
      burnSeverity: 0.4,
      slopeTerrain: 0.8,
      downstreamExposure: 0.9,
      dataFreshness: 1,
      confidenceMultiplier: 0.95,
      baseScore: 0.76,
      finalScore: 0.72,
    },
    evidence: asset().evidence,
    sourceSnapshotIds: ["source-nws", "source-tiger-roads", "source-3dhp-flowlines", "source-usgs-pwfdf"],
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}

function pwfdfRawPayload() {
  return {
    analysisGeometryVersion: "2026-09-14-provider-resolution-v1",
    available: true,
    linkageVersion: "2026-09-14-pwfdf-discovery-v2",
    assessmentDiscovery: { version: "2026-09-13-object-id-inventory-v1", complete: true, expectedCount: 1, receivedCount: 1 },
    selectedFire: { sourceKey: "wfigs", sourceFeatureId: "canyon-perimeter-1", name: "Canyon Fire" },
    assessment: {
      fireName: "Canyon",
      fireId: "Canyon_2026_v1",
      assessmentDate: "2026-06-27T00:00:00.000Z",
    },
    basinCount: 1,
    basins: [{
      id: "pwfdf-Canyon_2026_v1-42",
      fireId: "Canyon_2026_v1",
      assessmentDate: "2026-06-27T00:00:00.000Z",
      probabilityClass: "60-80%",
      volumeClass: "10,000-100,000",
      combinedHazard: "High",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.6],
          [-119.4, 34.6], [-119.4, 34.4],
        ]],
      },
    }],
  };
}

function action(): ResponderAction {
  return {
    id: "action-1",
    recommendationId: "rec-1",
    action: "accept",
    note: "Inspect by 1600.",
    actorName: "Incident Commander",
    createdAt: "2026-06-28T00:05:00.000Z",
    recommendationSnapshot: recommendation(),
    auditEvent: auditEvent(),
  };
}

function auditEvent(): AuditEvent {
  return {
    id: "audit-1",
    incidentId: "incident-ventura",
    recommendationId: "rec-1",
    eventType: "RecommendationAccepted",
    actorName: "Incident Commander",
    createdAt: "2026-06-28T00:05:00.000Z",
    summary: "Accepted SR-33 @ Matilija Creek.",
    payload: {
      action: "accept",
      recommendationSnapshot: recommendation(),
    },
  };
}
