import { describe, expect, it } from "vitest";
import { buildSourceCoverageMatrix } from "./source-coverage";
import type {
  Asset,
  AuditEvent,
  Incident,
  Recommendation,
  ResponderAction,
  SourceSnapshot,
} from "./types";

describe("buildSourceCoverageMatrix", () => {
  function coverage(sources: SourceSnapshot[], assets: Asset[] = []) {
    return buildSourceCoverageMatrix({ incident: activeIncident(), assets,
      sourceSnapshots: sources, recommendations: [], actions: [], auditEvents: [] });
  }

  it("keeps saved inventory distinct from expired evidence", () => {
    const matrix = coverage([
      source("fhwa-nbi-bridges", "delayed", "available", "Retrieval has expired.", true, { featureCount: 605 }),
    ], [asset("bridge", "Bridge", false, "fhwa-nbi-bridges")]);
    const bridges = matrix.find((item) => item.sourceKeys[0] === "fhwa-nbi-bridges")!;
    expect(bridges.status).toBe("Delayed");
    expect(bridges.evidence).toContain("605 features");
    expect(bridges.limitation).toContain("Retrieval has expired.");
    expect(bridges.limitation).not.toContain("not loaded");
  });

  it("does not mark combined road/hydro coverage live when a dependency is missing", () => {
    const road = source("tiger-roads", "online", "available", "Roads loaded.");
    for (const others of [[], [source("3dhp-flowlines", "delayed", "not_available", "Hydro retrieval failed.", true)]]) {
      const matrix = coverage([road, ...others], [asset("crossing", "Inferred Crossing", false, "tiger-roads+3dhp-flowlines")]);
      expect(statusFor(matrix, "Roads and inferred road/stream crossings")).toBe("Partial / Proxy");
    }
  });

  it("does not promote stale or partial online inventory to Live", () => {
    expect(statusFor(coverage([source("fhwa-nbi-bridges", "online", "available", "Old inventory.", true)]),
      "FHWA/BTS National Bridge Inventory bridges")).toBe("Delayed");
    expect(statusFor(coverage([source("fhwa-nbi-bridges", "online", "partial", "Partial inventory.")],
      [asset("bridge", "Bridge", false, "fhwa-nbi-bridges")]),
      "FHWA/BTS National Bridge Inventory bridges")).toBe("Partial / Proxy");
  });

  it("distinguishes a failed source from a successful query with no coverage", () => {
    const matrix = coverage([source("usgs-pwfdf", "offline", "not_available", "Provider unavailable.")]);
    const hazard = matrix.find((item) => item.sourceKeys[0] === "usgs-pwfdf")!;
    expect(hazard.limitation).not.toContain("was reached");
    expect(hazard.limitation).toContain("Provider unavailable.");
    expect(hazard.nextAction).toContain("run Refresh");
  });

  it("directs capacity failures to an operator, including partial road/hydro coverage", () => {
    const hydro = source("3dhp-flowlines", "offline", "error", "Inventory limit exceeded.", true, { reason: "limit_exceeded" });
    const matrix = coverage([hydro, source("tiger-roads", "online", "available", "Roads loaded.")]);
    for (const item of matrix.filter(item => item.sourceKeys.includes("3dhp-flowlines"))) {
      expect(item.status).not.toBe("Live");
      expect(item.limitation).toContain("No partial inventory was accepted");
      expect(item.limitation).toContain("missing geometry does not mean no hazard");
      expect(item.nextAction).toContain("Repeating Refresh will not reduce the inventory");
    }
  });

  it("classifies every planned data-source category without inventing coverage", () => {
    const matrix = buildSourceCoverageMatrix({
      incident: activeIncident(),
      assets: [
        asset("asset-crossing", "Inferred Crossing", false, "tiger-roads+3dhp-flowlines"),
        asset("asset-bridge", "Bridge", false, "fhwa-nbi-bridges"),
        asset("asset-hospital", "Critical Facility", false, "tnm-structures"),
      ],
      sourceSnapshots: [
        source("nws", "online", "available", "NWS forecast and alerts loaded."),
        source("nws-observations", "online", "available", "Latest observation loaded."),
        source("wfigs", "online", "available", "Current perimeter loaded."),
        source("wfigs-ytd", "online", "available", "Year-to-date perimeter fallback loaded."),
        source("firms", "online", "available", "FIRMS hotspots loaded."),
        source("mtbs-burn-severity", "delayed", "not_available", "No MTBS product published yet.", true),
        source("usgs-pwfdf", "online", "available", "PWFDF basin layer loaded.", false, { basinCount: 2 }),
        source("3dhp-flowlines", "online", "available", "Flowlines loaded."),
        source("usgs-epqs", "online", "available", "Elevation sample loaded."),
        source("tiger-roads", "online", "available", "Roads loaded."),
        source("fhwa-nbi-bridges", "online", "available", "Bridge candidates loaded."),
        source("tnm-structures", "online", "available", "Critical facilities loaded."),
      ],
      recommendations: [recommendation()],
      actions: [action()],
      auditEvents: [action().auditEvent],
    });

    expect(matrix.map((item) => item.item)).toEqual([
      "NOAA/NWS rainfall forecasts, alerts, and warnings",
      "NWS latest weather observations",
      "Current fire perimeter and burn-area context",
      "Recent fire perimeter fallback",
      "NASA FIRMS active fire/hotspot context",
      "MTBS NBR/dNBR burn-severity products",
      "USGS PWFDF combined-hazard basin polygons",
      "DEM/elevation-derived slope proxy",
      "Drainage, flowlines, and watershed context",
      "Roads and inferred road/stream crossings",
      "FHWA/BTS National Bridge Inventory bridges",
      "Hospitals, fire/EMS stations, and critical facilities",
      "County GIS/public works culverts and evacuation routes",
      "Responder decisions and audit feedback",
    ]);
    expect(statusFor(matrix, "MTBS NBR/dNBR burn-severity products")).toBe("Delayed");
    expect(statusFor(matrix, "USGS PWFDF combined-hazard basin polygons")).toBe("Live");
    expect(matrix.find((item) => item.item === "USGS PWFDF combined-hazard basin polygons")).toMatchObject({
      category: "Post-Wildfire Hazard",
      evidence: "usgs-pwfdf: 2 basin polygons",
      limitation:
        "PWFDF classes are screening-level estimates for published design rainfall; basin-to-asset linkage still requires exact point containment and field validation.",
    });
    expect(statusFor(matrix, "County GIS/public works culverts and evacuation routes")).toBe(
      "Upload Required",
    );
    expect(statusFor(matrix, "Responder decisions and audit feedback")).toBe("Live");
  });

  it("marks local agency data live only when uploaded local assets are present", () => {
    const matrix = buildSourceCoverageMatrix({
      incident: activeIncident(),
      assets: [asset("asset-upload", "Culvert", true, "local-upload")],
      sourceSnapshots: [],
      recommendations: [],
      actions: [],
      auditEvents: [],
    });

    expect(statusFor(matrix, "County GIS/public works culverts and evacuation routes")).toBe(
      "Live",
    );
    const uploads = matrix.find(item => item.category === "Local Agency Data")!;
    expect(uploads.limitation).toContain("unverified with Low confidence");
    expect(uploads.limitation).toContain("Format checks do not establish field accuracy");
    expect(uploads.limitation).not.toContain("high-confidence");
  });

  it("distinguishes reachable no-coverage sources from delayed or misconfigured sources", () => {
    const matrix = buildSourceCoverageMatrix({
      incident: activeIncident(),
      assets: [],
      sourceSnapshots: [
        source(
          "firms",
          "online",
          "not_available",
          "No FIRMS hotspots found in the county area over the last 3 days.",
          true,
        ),
      ],
      recommendations: [],
      actions: [],
      auditEvents: [],
    });

    const firms = matrix.find(
      (item) => item.item === "NASA FIRMS active fire/hotspot context",
    );

    expect(firms).toMatchObject({
      status: "Not Available",
      limitation:
        "FIRMS was reached and returned no recent hotspots for this county window.",
      nextAction:
        "Monitor FIRMS on the next refresh and keep the no-hotspot finding visible in source evidence.",
    });
    expect(firms?.limitation).not.toContain("MAP_KEY");
    expect(firms?.nextAction).not.toContain("MAP_KEY");
  });

  it("keeps missing PWFDF coverage explicit instead of implying basin evidence", () => {
    const matrix = buildSourceCoverageMatrix({
      incident: activeIncident(),
      assets: [],
      sourceSnapshots: [
        source(
          "usgs-pwfdf",
          "online",
          "not_available",
          "No matching PWFDF assessment was found.",
        ),
      ],
      recommendations: [],
      actions: [],
      auditEvents: [],
    });

    expect(matrix.find((item) => item.item === "USGS PWFDF combined-hazard basin polygons")).toMatchObject({
      status: "Not Available",
      limitation:
        "USGS PWFDF was reached but returned no validated combined-hazard basins for the selected fire.",
      nextAction: "Select a published fire with a matching PWFDF assessment, then run Refresh.",
    });
  });
});

function statusFor(
  matrix: ReturnType<typeof buildSourceCoverageMatrix>,
  item: string,
) {
  return matrix.find((entry) => entry.item === item)?.status;
}

function activeIncident(): Incident {
  return {
    id: "incident-ventura",
    locationId: "ventura-ca",
    county: "Ventura County",
    state: "CA",
    title: "Ventura County Storm Watch",
    code: "CA-FA-06111-001",
    status: "Storm Watch",
    stormWindow: "Next 48-72 hrs",
    rainfallForecast: "0.75 in forecast total rainfall",
    lastRefresh: "10:24 AM PDT",
    dataFreshness: "High",
    activeAlerts: 1,
    selectedFire: {
      name: "Canyon Fire",
      acres: 1200,
      perimeterUpdated: "Jun 28, 2026 10:00 AM PDT",
      source: "NIFC WFIGS",
      sourceKey: "wfigs",
      coverageStatus: "available",
    },
    coverageStatus: "available",
  };
}

function source(
  sourceKey: string,
  status: SourceSnapshot["status"],
  coverageStatus: NonNullable<SourceSnapshot["coverageStatus"]>,
  detail: string,
  stale = false,
  rawPayload: Record<string, unknown> = {},
): SourceSnapshot {
  return {
    id: `source-${sourceKey}`,
    incidentId: "incident-ventura",
    sourceKey,
    sourceName: sourceKey,
    fetchedAt: "2026-06-28T14:00:00.000Z",
    sourceUpdatedAt: "2026-06-28T14:00:00.000Z",
    status,
    stale,
    freshnessLabel: stale ? "Stale" : "Just now",
    detail,
    coverageStatus,
    warnings: stale ? [detail] : [],
    rawPayload,
  };
}

function asset(
  id: string,
  type: Asset["type"],
  localOrUploaded: boolean,
  sourceKey: string,
): Asset {
  return {
    id,
    incidentId: "incident-ventura",
    name: id,
    type,
    locationLabel: "Ventura County",
    coordinates: [-119.2, 34.4],
    source: sourceKey,
    confidence: localOrUploaded ? "High" : "Medium",
    localOrUploaded,
    sourceKey,
    coverageStatus: "available",
  };
}

function recommendation(): Recommendation {
  return {
    id: "rec-1",
    incidentId: "incident-ventura",
    assetId: "asset-crossing",
    assetName: "SR-33 @ Matilija Creek",
    assetType: "Inferred Crossing",
    locationLabel: "Matilija Creek",
    coordinates: [-119.3, 34.48],
    recommendedAction: "Inspect inferred crossing and upstream channel.",
    finalScore: 0.72,
    score100: 72,
    riskLevel: "High",
    confidenceLevel: "Medium",
    reasonCodes: ["Road Crossing Exposure"],
    limitations: [],
    changedSinceLastRefresh: "Source-Backed Candidate",
    sourcesUpdatedLabel: "Just now",
    dataFreshnessHours: 1,
    scoreBreakdown: {
      rainfallThreat: 0.6,
      burnSeverity: 0.5,
      slopeTerrain: 0.4,
      downstreamExposure: 0.8,
      dataFreshness: 0.9,
      confidenceMultiplier: 0.85,
      baseScore: 0.62,
      finalScore: 0.72,
    },
    createdAt: "2026-06-28T14:00:00.000Z",
  };
}

function action(): ResponderAction {
  const auditEvent: AuditEvent = {
    id: "audit-1",
    incidentId: "incident-ventura",
    recommendationId: "rec-1",
    eventType: "RecommendationAccepted",
    actorName: "commander@example.com",
    createdAt: "2026-06-28T14:05:00.000Z",
    summary: "Accepted SR-33 @ Matilija Creek.",
    payload: { action: "accept", recommendationSnapshot: recommendation() },
  };
  return {
    id: "action-1",
    recommendationId: "rec-1",
    action: "accept",
    note: "Inspect by 1600.",
    actorName: "commander@example.com",
    createdAt: "2026-06-28T14:05:00.000Z",
    recommendationSnapshot: recommendation(),
    auditEvent,
  };
}
