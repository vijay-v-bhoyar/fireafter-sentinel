import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOperationalHealth, deploymentChecksFromEnv } from "./readiness";
import type {
  Asset,
  AuditEvent,
  Incident,
  Recommendation,
  ResponderAction,
  SourceSnapshot,
} from "./types";

describe("buildOperationalHealth", () => {
  it("FA20 requires affirmative atomic proof rather than an omitted field", () => {
    // @ts-expect-error Deliberately malformed runtime input; the typed contract must still require a boolean.
    const report = buildOperationalHealth(readyBundle(), { ...readyDeploymentChecks(), atomicResponderActionWriteVerified: undefined });
    expect(report.deployment.blockers).toContain("Atomic responder-action persistence migration has not been verified.");
    expect(report.deployment.actions.join(" ")).toContain("20261002010000");
    expect(report.deployment.actions.join(" ")).not.toContain("20260914034000");
  });
  it("FA19-C2 reports the read boundary only with affirmative proof", () => {
    const report = buildOperationalHealth(readyBundle(), readyDeploymentChecks());
    expect(report.deployment.blockers.join(" ")).not.toContain("Server-owned operational-read");
    expect(report.deployment.evidence.join(" ")).toContain("operational-read migration version 20260913230300");
    expect(deploymentChecksFromEnv().serverOwnedReadsVerified).toBe(false);
  });
  it.each([false, undefined])("FA19-C2 blocks absent raw-read protection: %s", (verified) => {
    const report = buildOperationalHealth(readyBundle(), { ...readyDeploymentChecks(), serverOwnedReadsVerified: verified });
    expect(report.overallStatus).toBe("blocked");
    expect(report.deployment.blockers.join(" ")).toContain("Server-owned operational-read");
  });
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-06-28T00:10:00.000Z")); });
  afterEach(() => vi.useRealTimers());

  it("blocks expired checks even when they previously explained no coverage or fallback age", () => {
    const bundle = readyBundle();
    const noCoverage = source("firms", "online", "not_available", true, ["No recent hotspots."]);
    const fallback = source("wfigs-ytd", "online", "available", true);
    fallback.detail = "Year-to-date perimeter fallback loaded";
    bundle.sourceSnapshots.push(noCoverage, fallback);
    const report = buildOperationalHealth(bundle, readyDeploymentChecks(), "2026-06-28T00:30:00.000Z");
    expect(report.overallStatus).toBe("blocked");
    expect(report.categories.timeliness.blockers.join(" ")).toContain("expired");
    expect(report.categories.timeliness.actions.join(" ")).toContain("previously explained no-coverage");
  });
  it("distinguishes current available evidence from reachable but limited feeds", () => {
    const bundle = { ...emptyBundle(), incident: activeIncident(), sourceSnapshots: [
      source("nws", "online", "available"),
      source("wfigs-ytd", "online", "available", true),
      source("firms", "online", "not_available"),
      source("tiger-roads", "online", "partial"),
      source("3dhp-flowlines", "online", "error"),
    ] };
    const report = buildOperationalHealth(bundle, readyDeploymentChecks());
    expect(report.categories.timeliness.evidence).toContain("Current, available evidence: 1 of 5 source feeds.");
    expect(report.categories.timeliness.evidence.join(" ")).not.toMatch(/source feeds? online/);
    const expired = buildOperationalHealth(bundle, readyDeploymentChecks(), "2026-06-28T00:30:00Z");
    expect(expired.categories.timeliness.evidence.join(" ")).not.toContain("Current, available evidence:");
    expect(expired.categories.timeliness.status).toBe("blocked");
  });
  it("blocks operational use when no real incident or source data is loaded", () => {
    const report = buildOperationalHealth(emptyBundle(), {
      supabaseConfigured: true,
      supabaseSchemaReady: false,
      serverOwnedWritesVerified: true,
      atomicResponderActionWriteVerified: true,
      atomicBundlePersistenceWriteVerified: true,
      operatorAccountIssuanceAuditVerified: true,
      nasaFirmsConfigured: true,
      nwsUserAgentConfigured: true,
      cronSecretConfigured: true,
    });

    expect(report.overallStatus).toBe("blocked");
    expect(report.categories.timeliness.blockers).toContain(
      "No live source refresh has completed.",
    );
    expect(report.categories.coverage.blockers).toContain(
      "No source-backed assets or uploaded local assets are loaded.",
    );
    expect(report.deployment.blockers).toContain(
      "Supabase reality-upgrade migration has not been verified.",
    );
  });

  it("blocks deployment readiness until the server-owned-write migration is verified", () => {
    const report = buildOperationalHealth(readyBundle(), {
      ...readyDeploymentChecks(),
      serverOwnedWritesVerified: false,
    });

    expect(report.overallStatus).toBe("blocked");
    expect(report.deployment.blockers).toContain(
      "Server-owned operational-write migration has not been verified.",
    );
  });

  it("blocks deployment readiness until responder action and audit writes are atomic", () => {
    const report = buildOperationalHealth(readyBundle(), {
      ...readyDeploymentChecks(),
      atomicResponderActionWriteVerified: false,
      atomicBundlePersistenceWriteVerified: true,
    });

    expect(report.overallStatus).toBe("blocked");
    expect(report.deployment.blockers).toContain(
      "Atomic responder-action persistence migration has not been verified.",
    );
  });

  it("blocks partial integrations without verified linkage and keeps source-specific actions", () => {
    const report = buildOperationalHealth(
      {
        ...emptyBundle(),
        incident: activeIncident(),
        sourceSnapshots: [
          source("nws", "online", "available"),
          source("firms", "delayed", "stale", true, ["NASA FIRMS returned stale data."]),
        ],
        recommendations: [],
      },
      {
        supabaseConfigured: true,
        supabaseSchemaReady: true,
        serverOwnedWritesVerified: true,
        atomicResponderActionWriteVerified: true,
        atomicBundlePersistenceWriteVerified: true,
        operatorAccountIssuanceAuditVerified: true,
        nasaFirmsConfigured: false,
        nwsUserAgentConfigured: true,
        cronSecretConfigured: true,
      },
    );

    expect(report.overallStatus).toBe("blocked");
    expect(report.productPromise.find((gate) => gate.id === "basin_asset_linkage")?.status).toBe("gap");
    expect(report.categories.timeliness.score).toBeLessThan(4);
    expect(report.categories.coverage.actions).toContain(
      "Load source-backed road/hydro candidates, or upload county assets, before ranking recommendations.",
    );
    expect(report.categories.timeliness.actions).not.toContain(
      "Verify NWS forecast grid refresh before operational use.",
    );
    expect(report.deployment.actions).toContain(
      "Set NASA_FIRMS_MAP_KEY in Vercel and local env.",
    );
  });

  it("clears data coverage actions when canonical source keys, assets, and recommendations exist", () => {
    const report = buildOperationalHealth(
      {
        ...emptyBundle(),
        incident: activeIncident(),
        assets: [asset(), uploadedAsset()],
        sourceSnapshots: [
          source("nws", "online", "available"),
          source("nws-observations", "online", "available"),
          source("wfigs", "online", "available"),
          source("wfigs-ytd", "online", "available"),
          source("firms", "online", "available"),
          source("mtbs-burn-severity", "online", "not_available", false, [
            "No MTBS product published yet.",
          ]),
          source("tiger-roads", "online", "available"),
          source("3dhp-flowlines", "online", "available"),
          source("usgs-epqs", "online", "available"),
          source("fhwa-nbi-bridges", "online", "available"),
          source("tnm-structures", "online", "available"),
          source("usgs-pwfdf", "delayed", "not_available", true, [
            "No matching USGS PWFDF assessment was found.",
          ]),
        ],
        recommendations: [recommendation()],
      },
      {
        supabaseConfigured: true,
        supabaseSchemaReady: true,
        serverOwnedWritesVerified: true,
        atomicResponderActionWriteVerified: true,
        atomicBundlePersistenceWriteVerified: true,
        operatorAccountIssuanceAuditVerified: true,
        nasaFirmsConfigured: true,
        nwsUserAgentConfigured: true,
        cronSecretConfigured: true,
      },
    );

    expect(report.categories.coverage.actions).toEqual([]);
    expect(report.categories.coverage.score).toBeGreaterThanOrEqual(4.2);
    expect(report.categories.coverage.status).toBe("operational");
  });

  it("flags planned source categories that are still unavailable or upload-required", () => {
    const report = buildOperationalHealth(
      {
        ...emptyBundle(),
        incident: activeIncident(),
        assets: [asset()],
        sourceSnapshots: [
          source("nws", "online", "available"),
          source("wfigs", "online", "available"),
          source("firms", "online", "available"),
          source("tiger-roads", "online", "available"),
          source("3dhp-flowlines", "online", "available"),
        ],
        recommendations: [recommendation()],
      },
      readyDeploymentChecks(),
    );

    expect(report.categories.coverage.actions).toContain(
      "Resolve or explain unavailable planned data sources: NWS latest weather observations; USGS PWFDF combined-hazard basin polygons; DEM/elevation-derived slope proxy.",
    );
    expect(report.categories.coverage.actions).toContain(
      "Upload local agency data when available: County GIS/public works culverts and evacuation routes.",
    );
  });

  it("treats reachable no-coverage source results as visible evidence, not unresolved coverage work", () => {
    const report = buildOperationalHealth(
      {
        ...readyBundle(),
        sourceSnapshots: [
          ...readyBundle().sourceSnapshots.filter((source) => source.sourceKey !== "firms"),
          source("firms", "online", "not_available", true, [
            "FIRMS was reached and returned no recent hotspots for this county window.",
          ]),
        ],
      },
      readyDeploymentChecks(),
    );

    expect(report.categories.coverage.actions.join(" ")).not.toContain(
      "NASA FIRMS active fire/hotspot context",
    );
    expect(report.categories.coverage.evidence).toContain(
      "2 reachable sources returned no current coverage and remain visible.",
    );
  });

  it("does not count explicit no-coverage or fallback-age source results as stale feeds needing retry", () => {
    const report = buildOperationalHealth(
      {
        ...readyBundle(),
        sourceSnapshots: [
          source("nws", "online", "available"),
          source("wfigs", "delayed", "not_available", true, [
            "No current WFIGS fire perimeter intersects this county.",
          ]),
          source("firms", "online", "not_available", true, [
            "No FIRMS hotspots found in the county area over the last 3 days.",
          ]),
          source("usgs-pwfdf", "delayed", "not_available", true, [
            "No matching USGS PWFDF assessment was found for this fire/county.",
          ]),
          {
            ...source("wfigs-ytd", "online", "available", true),
            detail: "Goshen Canyon year-to-date perimeter fallback loaded from WFIGS (409 acres).",
            derivedSignals: {
              reasonCodes: ["Recent Fire Perimeter Fallback"],
            },
          },
        ],
      },
      readyDeploymentChecks(),
    );

    expect(report.categories.timeliness.actions).toEqual([]);
    expect(report.categories.timeliness.status).toBe("operational");
    expect(report.categories.timeliness.evidence).toContain(
      "3 source feeds returned explicit no-coverage results.",
    );
    expect(report.categories.timeliness.evidence).toContain(
      "1 fallback source feed refreshed successfully with aged source-dated evidence.",
    );
  });

  it("does not downgrade public readiness when audit evidence already proves write workflow", () => {
    const report = buildOperationalHealth(
      {
        ...readyBundle(),
        currentUser: null,
        actions: [action()],
        auditEvents: [auditEvent()],
      },
      readyDeploymentChecks(),
    );

    expect(report.categories.responsible.actions).not.toContain(
      "Sign in as an incident commander before writing audit records.",
    );
    expect(report.categories.responsible.evidence).toContain(
      "Public readiness view is read-only; signed-in write controls remain role-gated.",
    );
    expect(report.categories.responsible.status).toBe("operational");
  });

  it("requires an accepted or modified action with a matching audit event for operations readiness", () => {
    const report = buildOperationalHealth(
      {
        ...readyBundle(),
        actions: [action()],
        auditEvents: [auditEvent()],
      },
      readyDeploymentChecks(),
    );

    expect(report.categories.operations.actions).toEqual([]);
    expect(report.categories.operations.blockers).toEqual([]);
    expect(report.categories.operations.score).toBe(5);
    expect(report.categories.operations.status).toBe("operational");
    expect(report.categories.operations.evidence).toContain(
      "1 accepted/modified responder decision visible in History & Audit.",
    );
    expect(report.productPromise).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ranked_action_queue",
          status: "pass",
        }),
        expect.objectContaining({
          id: "auditability",
          status: "pass",
        }),
      ]),
    );
  });

  it("does not clear operations readiness for reject or annotate actions", () => {
    const rejected = action({ action: "reject" });
    const annotated = action({ action: "annotate" });
    const report = buildOperationalHealth(
      {
        ...readyBundle(),
        actions: [rejected, annotated],
        auditEvents: [rejected.auditEvent, annotated.auditEvent],
      },
      readyDeploymentChecks(),
    );

    expect(report.categories.operations.actions).toContain(
      "Accept or modify one action and confirm it appears in History & Audit.",
    );
    expect(report.categories.operations.status).toBe("needs_attention");
  });

  it("blocks operations readiness when an accepted action has no matching audit event", () => {
    const report = buildOperationalHealth(
      {
        ...readyBundle(),
        actions: [action()],
        auditEvents: [],
      },
      readyDeploymentChecks(),
    );

    expect(report.categories.operations.blockers).toContain(
      "Accepted/modified responder actions exist without matching audit events.",
    );
    expect(report.categories.operations.status).toBe("blocked");
  });

  it("does not declare operational health when legacy MTBS evidence claims unverified severity", () => {
    const report = buildOperationalHealth(
      {
        incident: activeIncident(),
        assets: [asset(), uploadedAsset()],
        sourceSnapshots: [
          source("nws", "online", "available"),
          source("nws-observations", "online", "available"),
          source("wfigs", "online", "available"),
          source("wfigs-ytd", "online", "available"),
          source("firms", "online", "available"),
          source("mtbs-burn-severity", "online", "not_available", false, [
            "No MTBS product published yet.",
          ]),
          source("usgs-pwfdf", "online", "not_available"),
          source("tigerweb-roads", "online", "available"),
          source("tiger-roads", "online", "available"),
          source("3dhp-flowlines", "online", "available"),
          source("usgs-epqs", "online", "available"),
          source("fhwa-nbi-bridges", "online", "available"),
          source("tnm-structures", "online", "available"),
        ],
        recommendations: [recommendation()],
        actions: [action()],
        auditEvents: [auditEvent()],
        currentUser: {
          id: "user-1",
          email: "commander@example.com",
          role: "incident_commander",
        },
      },
      {
        supabaseConfigured: true,
        supabaseSchemaReady: true,
        serverOwnedWritesVerified: true,
        atomicResponderActionWriteVerified: true,
        atomicBundlePersistenceWriteVerified: true,
        operatorAccountIssuanceAuditVerified: true,
        nasaFirmsConfigured: true,
        nwsUserAgentConfigured: true,
        cronSecretConfigured: true,
      },
    );

    expect(report.overallStatus).toBe("blocked");
    expect(report.productPromise.find((gate) => gate.id === "basin_asset_linkage")?.status).toBe("gap");
    expect(report.overallScore).toBeGreaterThanOrEqual(4.3);
    expect(report.categories.responsible.blockers).toEqual([]);
    expect(report.operatorChecklist).toEqual([
      "Search and open a real county.",
      "Run Refresh and inspect source freshness warnings.",
      "Open the top recommendation and review source evidence.",
      "Accept or modify one action as an authenticated responder.",
      "Open History & Audit and show the immutable action record.",
    ]);
  });
});

describe("deploymentChecksFromEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("accepts the current Supabase publishable key env as the public client key", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_real";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

    expect(deploymentChecksFromEnv().supabaseConfigured).toBe(true);
  });

  it("does not accept server-owned-write proof from process environment", () => {
    process.env.FIREAFTER_SERVER_WRITE_SECURITY_VERSION = "20260904053500";
    expect(deploymentChecksFromEnv().serverOwnedWritesVerified).toBe(false);
  });
});

function emptyBundle() {
  return {
    incident: {
      id: "no-incident-selected",
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
    } satisfies Incident,
    assets: [] as Asset[],
    sourceSnapshots: [] as SourceSnapshot[],
    recommendations: [] as Recommendation[],
    actions: [] as ResponderAction[],
    auditEvents: [] as AuditEvent[],
    currentUser: null,
  };
}

function readyBundle() {
  return {
    ...emptyBundle(),
    incident: activeIncident(),
    assets: [asset(), uploadedAsset()],
    sourceSnapshots: [
      source("nws", "online", "available"),
      source("nws-observations", "online", "available"),
      source("wfigs", "online", "available"),
      source("wfigs-ytd", "online", "available"),
      source("firms", "online", "available"),
      source("mtbs-burn-severity", "online", "not_available", false, [
        "No MTBS product published yet.",
      ]),
      source("usgs-pwfdf", "online", "not_available"),
      source("tigerweb-roads", "online", "available"),
      source("tiger-roads", "online", "available"),
      source("3dhp-flowlines", "online", "available"),
      source("usgs-epqs", "online", "available"),
      source("fhwa-nbi-bridges", "online", "available"),
      source("tnm-structures", "online", "available"),
    ],
    recommendations: [recommendation()],
    currentUser: {
      id: "user-1",
      email: "commander@example.com",
      role: "incident_commander" as const,
    },
  };
}

function readyDeploymentChecks() {
  return {
    serverOwnedReadsVerified: true,
    supabaseConfigured: true,
    supabaseSchemaReady: true,
    serverOwnedWritesVerified: true,
    atomicResponderActionWriteVerified: true,
    atomicBundlePersistenceWriteVerified: true,
    operatorAccountIssuanceAuditVerified: true,
    nasaFirmsConfigured: true,
    nwsUserAgentConfigured: true,
    cronSecretConfigured: true,
  };
}

function activeIncident(): Incident {
  return {
    ...emptyBundle().incident,
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
    selectedFire: {
      name: "No current WFIGS perimeter found",
      acres: 0,
      perimeterUpdated: "Not available",
      source: "NIFC WFIGS",
      sourceKey: "wfigs-current",
      coverageStatus: "not_available",
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
    },
    coverageStatus: "partial",
  };
}

function source(
  sourceKey: string,
  status: SourceSnapshot["status"],
  coverageStatus: NonNullable<SourceSnapshot["coverageStatus"]>,
  stale = false,
  warnings: string[] = [],
): SourceSnapshot {
  return {
    id: `source-${sourceKey}`,
    incidentId: "incident-ventura",
    sourceKey,
    sourceName: sourceKey,
    fetchedAt: "2026-06-28T00:00:00.000Z",
    sourceUpdatedAt: "2026-06-28T00:00:00.000Z",
    sourceTimeBasis: "provider",
    validUntil: "2026-06-29T00:00:00.000Z",
    status,
    stale,
    freshnessLabel: stale ? "Stale" : "Fresh",
    detail: warnings[0] ?? "Source returned data.",
    coverageStatus,
    warnings,
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
    source: "TIGERweb roads + USGS 3DHP flowline",
    confidence: "High",
    localOrUploaded: false,
    sourceKey: "tigerweb-roads",
    sourceFeatureIds: ["road-1", "flowline-1"],
    coverageStatus: "available",
    evidence: [
      {
        sourceKey: "tigerweb-roads",
        sourceName: "TIGERweb Roads",
        summary: "Road line matched nearby hydrography.",
      },
    ],
  };
}

function uploadedAsset(): Asset {
  return {
    ...asset(),
    id: "asset-upload-culvert",
    name: "County Culvert 12",
    type: "Culvert",
    source: "county-public-works.csv",
    confidence: "High",
    localOrUploaded: true,
    sourceKey: "local-upload",
    evidence: [
      {
        sourceKey: "local-upload",
        sourceName: "county-public-works.csv",
        summary: "County uploaded culvert inventory.",
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
    recommendedAction: "Inspect road crossing and clear debris. Monitor closely.",
    finalScore: 0.72,
    score100: 72,
    riskLevel: "High",
    confidenceLevel: "High",
    reasonCodes: ["Rainfall Forecast", "Road Crossing Exposure", "Downstream Exposure"],
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
    sourceSnapshotIds: ["source-nws-forecast", "source-tigerweb-roads"],
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}

function action(
  overrides: Partial<Pick<ResponderAction, "action" | "auditEvent">> = {},
): ResponderAction {
  const actionType = overrides.action ?? "accept";
  const event = auditEvent({
    eventType:
      actionType === "modify"
        ? "RecommendationModified"
        : actionType === "reject"
          ? "RecommendationRejected"
          : actionType === "annotate"
            ? "RecommendationAnnotated"
            : "RecommendationAccepted",
    action: actionType,
  });
  return {
    id: "action-1",
    recommendationId: "rec-1",
    action: actionType,
    note: "Inspect by 1600.",
    actorName: "Incident Commander",
    createdAt: "2026-06-28T00:05:00.000Z",
    recommendationSnapshot: recommendation(),
    auditEvent: overrides.auditEvent ?? event,
  };
}

function auditEvent(
  overrides: Partial<AuditEvent> & { action?: ResponderAction["action"] } = {},
): AuditEvent {
  return {
    id: "audit-1",
    incidentId: "incident-ventura",
    recommendationId: "rec-1",
    eventType: overrides.eventType ?? "RecommendationAccepted",
    actorName: "Incident Commander",
    createdAt: "2026-06-28T00:05:00.000Z",
    summary: "Accepted SR-33 @ Matilija Creek.",
    payload: {
      action: overrides.action ?? "accept",
      recommendationSnapshot: recommendation(),
    },
    ...overrides,
  };
}

