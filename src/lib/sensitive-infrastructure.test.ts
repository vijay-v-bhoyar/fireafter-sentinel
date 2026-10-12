import { describe, expect, it, vi } from "vitest";
import {
  canViewSensitiveInfrastructure,
  redactAssetForPublic,
  redactSensitiveBundleForPublic,
  redactRecommendationForPublic,
} from "./sensitive-infrastructure";
import type { Asset, Incident, Recommendation } from "./types";

describe("sensitive infrastructure DTO helpers", () => {
  it("FA18-ID1 cannot enumerate private facility IDs using the old public hash", () => {
    const asset = criticalFacility();
    let hash = 0x811c9dc5;
    for (const character of asset.id) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
    expect(redactAssetForPublic(asset, incident()).id).not.toBe(`asset-redacted-${hash.toString(16).padStart(8, "0")}`);
  });

  it("FA18-ID2 shares identifiers within a response but never across fresh deliveries", () => {
    const input = { incident: incident(), assets: [criticalFacility()], recommendations: [criticalRecommendation()], actions: [], auditEvents: [] };
    const first = redactSensitiveBundleForPublic(input);
    const second = redactSensitiveBundleForPublic(input);
    expect(first.recommendations[0].assetId).toBe(first.assets[0].id);
    expect(second.recommendations[0].assetId).toBe(second.assets[0].id);
    expect(second.assets[0].id).not.toBe(first.assets[0].id);
    expect(second.recommendations[0].id).not.toBe(first.recommendations[0].id);
    expect(input.assets[0].id).toBe(criticalFacility().id);
  });

  it("FA18-ID3 rekeys provider identifiers that imitate the public format", () => {
    const id = "asset-redacted-v2-11111111111141118111111111111111";
    const input = { incident: incident(), assets: [{ ...criticalFacility(), id }],
      recommendations: [{ ...criticalRecommendation(), assetId: id }], actions: [], auditEvents: [] };
    const projected = redactSensitiveBundleForPublic(input);
    expect(projected.assets[0].id).not.toBe(id);
    expect(projected.recommendations[0].assetId).toBe(projected.assets[0].id);
  });

  it("fails closed without secure randomness instead of reverting to a predictable ID", () => {
    const random = vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("secure randomness unavailable"); });
    try { expect(() => redactAssetForPublic(criticalFacility(), incident())).toThrow("secure randomness unavailable"); }
    finally { random.mockRestore(); }
  });

  it.each(["road", "facility"].flatMap(kind => [false, true].map(malformed => [kind, malformed] as const)))
  ("FA18-ID4 preserves %s audit joins with malformed snapshot=%s", (kind, malformed) => {
    const rec = kind === "road" ? roadRecommendation() : criticalRecommendation();
    const event = { id: "audit-missing-snapshot", incidentId: incident().id, recommendationId: rec.id,
      eventType: "RecommendationAccepted" as const, actorName: "Private operator", createdAt: rec.createdAt,
      summary: "Private details", payload: malformed ? { recommendationSnapshot: { assetType: rec.assetType } } : {} };
    const action = { id: "action-missing-snapshot", recommendationId: rec.id, action: "accept" as const,
      actorName: "Private operator", note: "Private note", createdAt: rec.createdAt, recommendationSnapshot: rec, auditEvent: event };
    const result = redactSensitiveBundleForPublic({ incident: incident(), assets: [], recommendations: [rec],
      actions: [action], auditEvents: [event] });
    expect(result.auditEvents[0].recommendationId).toBe(result.recommendations[0].id);
    expect(result.actions[0].auditEvent.recommendationId).toBe(result.recommendations[0].id);
    expect(result.actions[0].auditEvent.id).toBe(result.auditEvents[0].id);
    expect(JSON.stringify(result)).not.toContain("Private operator");
  });

  it.each(["Road Crossing", "malformed-classification"])("FA18-ID5 rejects public classification from conflicting %s history", assetType => {
    const rec = criticalRecommendation({ id: "private-coordinate-bearing-recommendation" });
    const event = { id: "conflicting-audit", incidentId: incident().id, recommendationId: rec.id,
      eventType: "RecommendationAccepted" as const, actorName: "Private operator", createdAt: rec.createdAt,
      summary: "Private history", payload: { recommendationSnapshot: { ...roadRecommendation(), id: rec.id, assetType } } };
    const input = { incident: incident(), assets: [criticalFacility()], recommendations: [rec], actions: [], auditEvents: [event] };
    const result = redactSensitiveBundleForPublic(input);
    expect(result.recommendations[0].id).not.toBe(rec.id);
    expect(JSON.stringify(result)).not.toContain(rec.id);
  });

  it.each(["Road Crossing", "malformed-classification"])("FA18-ID6 keeps conflicting %s action history redacted", assetType => {
    const rec = criticalRecommendation({ id: "private-coordinate-bearing-recommendation" });
    const snapshot = { ...roadRecommendation(), id: rec.id, assetType } as unknown as Recommendation;
    const event = { id: "conflicting-action-audit", incidentId: incident().id, recommendationId: rec.id,
      eventType: "RecommendationAccepted" as const, actorName: "Private operator", createdAt: rec.createdAt,
      summary: "Private action history", payload: { recommendationSnapshot: snapshot } };
    const action = { id: "conflicting-action", recommendationId: rec.id, action: "accept" as const,
      actorName: "Private operator", note: "Private note", createdAt: rec.createdAt,
      recommendationSnapshot: snapshot, auditEvent: event };
    const result = redactSensitiveBundleForPublic({ incident: incident(), assets: [criticalFacility()],
      recommendations: [rec], actions: [action], auditEvents: [event] });
    expect(result.actions[0].recommendationId).toBe(result.recommendations[0].id);
    expect(result.actions[0].recommendationSnapshot.assetName).toBe("Critical facility response context");
    expect(result.auditEvents[0].recommendationId).toBe(result.recommendations[0].id);
    expect(JSON.stringify(result)).not.toContain(rec.id);
  });

  it("FA18-C1 allowlists facility metadata and recommendation free text without changing originals", () => {
    const marker = "FA18_PRIVATE_FACILITY";
    const asset = { ...criticalFacility(), source: `${marker}.csv`, sourceKey: marker,
      sourceUrl: `https://example.com/${marker}`, road: marker, stream: marker,
      confidenceReason: marker, metrics: { roadClass: marker }, futureField: marker };
    const rec = { ...criticalRecommendation(), recommendedAction: marker,
      reasonCodes: [marker], limitations: [marker], changedSinceLastRefresh: marker,
      sourcesUpdatedLabel: marker, sourceSnapshotIds: [marker], futureField: marker,
      scoreBreakdown: { ...criticalRecommendation().scoreBreakdown, futureField: marker } };
    const before = JSON.stringify({ asset, rec });
    const result = { asset: redactAssetForPublic(asset, incident()),
      rec: redactRecommendationForPublic(rec, incident()) };
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result.asset.source).toBe("Sensitive infrastructure context");
    expect(result.rec.score100).toBe(rec.score100);
    expect(result.rec.riskLevel).toBe(rec.riskLevel);
    expect(JSON.stringify({ asset, rec })).toBe(before);
    expect(redactAssetForPublic(result.asset, incident())).toEqual(result.asset);
    expect(redactRecommendationForPublic(result.rec, incident())).toEqual(result.rec);
  });

  it("FA18-C2 removes metadata from actions and audits including missing snapshot summaries", () => {
    const marker = "FA18_PRIVATE_HISTORY";
    const event = { id: "audit-import-1", incidentId: incident().id,
      eventType: "AssetsImported" as const, actorName: marker, createdAt: "2026-09-13T12:00:00Z",
      summary: `Imported records from ${marker}.csv`, payload: { fileName: marker }, futureField: marker };
    const action = { id: "action-1", recommendationId: "rec-critical-1", action: "annotate" as const,
      actorName: marker, note: marker, createdAt: event.createdAt, futureField: marker,
      recommendationSnapshot: criticalRecommendation(), auditEvent: event };
    const input = { incident: incident(), assets: [], recommendations: [],
      actions: [action], auditEvents: [event, { ...event, id: "audit-partial",
        recommendationId: marker, payload: { recommendationSnapshot: { assetType: "Critical Facility" } } }] };
    const before = JSON.stringify(input);
    const result = redactSensitiveBundleForPublic(input);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(input)).toBe(before);
    const again = redactSensitiveBundleForPublic(result);
    expect(again.actions[0].id).not.toBe(result.actions[0].id);
    expect(JSON.stringify(again)).not.toContain(marker);
  });

  it("allows full sensitive context only for same-organization commanders and analysts", () => {
    expect(canViewSensitiveInfrastructure(null, "org-1")).toBe(false);
    expect(
      canViewSensitiveInfrastructure(
        { organizationId: "org-1", role: "viewer" },
        "org-1",
      ),
    ).toBe(false);
    expect(
      canViewSensitiveInfrastructure(
        { organizationId: "org-1", role: "incident_commander" },
        "org-1",
      ),
    ).toBe(true);
    expect(
      canViewSensitiveInfrastructure(
        { organizationId: "org-1", role: "analyst" },
        "org-1",
      ),
    ).toBe(true);
    expect(
      canViewSensitiveInfrastructure(
        { organizationId: "org-2", role: "incident_commander" },
        "org-1",
      ),
    ).toBe(false);
    expect(
      canViewSensitiveInfrastructure(
        { organizationId: null, role: "incident_commander" },
        "org-1",
      ),
    ).toBe(false);
  });

  it("redacts critical-facility asset name, precise coordinates, and source feature ids for public views", () => {
    const redacted = redactAssetForPublic(criticalFacility(), incident());

    expect(redacted.name).toBe("Critical facility response context");
    expect(redacted.locationLabel).toBe("Ventura County response area");
    expect(redacted.coordinates).toEqual([-119.1391, 34.3705]);
    expect(redacted.sourceFeatureIds).toBeUndefined();
    expect(redacted.evidence?.[0]?.summary).toBe(
      "Sensitive facility details are available to signed-in response users.",
    );
  });

  it("redacts critical-facility recommendations while preserving score, action, confidence, and limitations", () => {
    const redacted = redactRecommendationForPublic(criticalRecommendation(), incident());

    expect(redacted.assetName).toBe("Critical facility response context");
    expect(redacted.locationLabel).toBe("Ventura County response area");
    expect(redacted.coordinates).toEqual([-119.1391, 34.3705]);
    expect(redacted.score100).toBe(64);
    expect(redacted.recommendedAction).toMatch(/review/i);
    expect(redacted.limitations).toContain(
      "Sensitive infrastructure details are limited to authenticated response users.",
    );
    expect(redacted.evidence?.[0]?.summary).toBe(
      "Sensitive facility evidence is available to signed-in response users.",
    );
  });

  it("replaces coordinate-bearing source ids with opaque public ids", () => {
    const leakyId =
      "asset-incident-ventura-tnm-structures-hospital-point-https-carto-nationalmap-gov-arcgis-rest-services-structures-mapserver-51-query-119-25200034857434-34-278720031710375";
    const asset = { ...criticalFacility(), id: leakyId };
    const recommendation = {
      ...criticalRecommendation(),
      id: `rec-incident-ventura-${leakyId}`,
      assetId: leakyId,
    };

    const projected = redactSensitiveBundleForPublic({ incident: incident(), assets: [asset],
      recommendations: [recommendation], actions: [], auditEvents: [] });
    const redactedAsset = projected.assets[0];
    const redactedRecommendation = projected.recommendations[0];

    expect(redactedAsset.id).toMatch(/^asset-redacted-v2-[0-9a-f]{32}$/);
    expect(redactedAsset.id).not.toContain("25200034857434");
    expect(redactedRecommendation.id).toMatch(/^rec-redacted-v2-[0-9a-f]{32}$/);
    expect(redactedRecommendation.assetId).toBe(redactedAsset.id);
    expect(JSON.stringify(redactedAsset)).not.toContain("hospital");
    expect(JSON.stringify(redactedRecommendation)).not.toContain("hospital");

    const again = redactAssetForPublic(asset, incident());
    expect(again.id).not.toBe(redactedAsset.id);
  });

  it("fails closed to a non-revealing coordinate when the incident has no location context", () => {
    const bareIncident = { ...incident(), locationContext: undefined };

    const redacted = redactAssetForPublic(criticalFacility(), bareIncident);

    expect(redacted.coordinates).toEqual([0, 0]);
    expect(redacted.coordinates).not.toEqual(criticalFacility().coordinates);
  });

  it("does not redact non-sensitive road assets", () => {
    const road = {
      ...criticalFacility(),
      type: "Road Crossing" as const,
      name: "SR-33 @ Matilija Creek",
    };

    expect(redactAssetForPublic(road, incident())).toEqual(road);
  });

  it("redacts sensitive assets, recommendations, responder notes, and audit snapshots before public bundle delivery", () => {
    const action = {
      id: "action-critical-1",
      recommendationId: "rec-critical-1",
      action: "accept" as const,
      note: "Coordinate with Ventura County Medical Center access team.",
      actorName: "J. Smith",
      createdAt: "2026-06-28T00:10:00.000Z",
      recommendationSnapshot: criticalRecommendation(),
      auditEvent: {
        id: "audit-critical-1",
        incidentId: "incident-ventura",
        recommendationId: "rec-critical-1",
        eventType: "RecommendationAccepted" as const,
        actorName: "J. Smith",
        createdAt: "2026-06-28T00:10:00.000Z",
        summary: "J. Smith accepted Ventura County Medical Center.",
        payload: {
          action: "accept",
          note: "Coordinate with Ventura County Medical Center access team.",
          recommendationSnapshot: criticalRecommendation(),
        },
      },
    };

    const redacted = redactSensitiveBundleForPublic({
      incident: incident(),
      assets: [criticalFacility()],
      recommendations: [criticalRecommendation()],
      actions: [action],
      auditEvents: [action.auditEvent],
    });

    expect(redacted.assets[0].name).toBe("Critical facility response context");
    expect(redacted.recommendations[0].assetName).toBe(
      "Critical facility response context",
    );
    expect(redacted.actions[0].note).toBe(
      "Responder note is available to signed-in response users.",
    );
    expect(redacted.actions[0].recommendationId).toBe(redacted.recommendations[0].id);
    expect(redacted.actions[0].recommendationSnapshot.id).toBe(redacted.recommendations[0].id);
    expect(redacted.actions[0].auditEvent.id).toBe(redacted.auditEvents[0].id);
    expect(redacted.auditEvents[0].recommendationId).toBe(redacted.recommendations[0].id);
    expect(redacted.actions[0].actorName).toBe("Response user");
    expect(redacted.actions[0].recommendationSnapshot.assetName).toBe(
      "Critical facility response context",
    );
    expect(redacted.auditEvents[0].actorName).toBe("Response user");
    expect(redacted.auditEvents[0].summary).toBe(
      "Audit event recorded for critical facility response context.",
    );
    expect(
      (
        redacted.auditEvents[0].payload
          .recommendationSnapshot as Recommendation
      ).assetName,
    ).toBe("Critical facility response context");
    expect(JSON.stringify(redacted)).not.toContain("J. Smith");
    expect(JSON.stringify(redacted)).not.toContain("Ventura County Medical Center access");
  });

  it("redacts public responder identity and notes for non-sensitive history", () => {
    const action = {
      id: "action-road-1",
      recommendationId: "rec-road-1",
      action: "accept" as const,
      note: "Call Sam at public works before 1600.",
      actorName: "sam.responder@example.gov",
      createdAt: "2026-06-28T00:10:00.000Z",
      recommendationSnapshot: roadRecommendation(),
      auditEvent: {
        id: "audit-road-1",
        incidentId: "incident-ventura",
        recommendationId: "rec-road-1",
        eventType: "RecommendationAccepted" as const,
        actorName: "sam.responder@example.gov",
        createdAt: "2026-06-28T00:10:00.000Z",
        summary: "sam.responder@example.gov accepted SR-33 @ Matilija Creek.",
        payload: {
          action: "accept",
          note: "Call Sam at public works before 1600.",
          recommendationSnapshot: roadRecommendation(),
        },
      },
    };

    const redacted = redactSensitiveBundleForPublic({
      incident: incident(),
      assets: [roadCrossing()],
      recommendations: [roadRecommendation()],
      actions: [action],
      auditEvents: [action.auditEvent],
    });

    expect(redacted.actions[0]).toMatchObject({
      actorName: "Response user",
      note: "Responder note is available to signed-in response users.",
      recommendationSnapshot: { assetName: "SR-33 @ Matilija Creek" },
    });
    expect(redacted.auditEvents[0]).toMatchObject({
      actorName: "Response user",
      summary: "Responder action recorded for public action queue item.",
      payload: {
        action: "accept",
        note: "Responder note is available to signed-in response users.",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("sam.responder@example.gov");
    expect(JSON.stringify(redacted)).not.toContain("Call Sam");
  });

  it("keeps redacted critical facilities behind public road and crossing recommendations", () => {
    const redacted = redactSensitiveBundleForPublic({
      incident: incident(),
      assets: [criticalFacility(), roadCrossing()],
      recommendations: [
        criticalRecommendation({ score100: 92, finalScore: 0.92 }),
        roadRecommendation({ score100: 51, finalScore: 0.51 }),
      ],
      actions: [],
      auditEvents: [],
    });

    expect(redacted.recommendations.map((item) => item.assetType)).toEqual([
      "Road Crossing",
      "Critical Facility",
    ]);
    expect(redacted.recommendations[0].assetName).toBe("SR-33 @ Matilija Creek");
    expect(redacted.recommendations[1].assetName).toBe(
      "Critical facility response context",
    );
  });

  it("rekeys each delivery while client presentation retains its delivered identifiers", () => {
    const input = {
      incident: incident(),
      assets: [criticalFacility()],
      recommendations: [criticalRecommendation()],
      actions: [],
      auditEvents: [],
    };

    const once = redactSensitiveBundleForPublic(input);
    const twice = redactSensitiveBundleForPublic(once);

    expect(twice.assets[0].id).not.toBe(once.assets[0].id);
    expect(twice.recommendations[0].assetId).toBe(twice.assets[0].id);
    expect(redactAssetForPublic(once.assets[0], once.incident)).toEqual(once.assets[0]);
    expect(redactRecommendationForPublic(once.recommendations[0], once.incident)).toEqual(once.recommendations[0]);
  });
});

function incident(): Incident {
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
    },
    coverageStatus: "available",
  };
}

function criticalFacility(): Asset {
  return {
    id: "asset-hospital-1",
    incidentId: "incident-ventura",
    name: "Ventura County Medical Center",
    type: "Critical Facility",
    locationLabel: "3291 Loma Vista Rd",
    coordinates: [-119.252, 34.278],
    source: "USGS TNM Structures",
    confidence: "Medium",
    localOrUploaded: false,
    sourceKey: "tnm-structures",
    sourceFeatureId: "tnm-123",
    sourceFeatureIds: ["tnm-123"],
    coverageStatus: "available",
    evidence: [
      {
        sourceKey: "tnm-structures",
        sourceName: "USGS TNM Structures",
        sourceFeatureId: "tnm-123",
        summary: "Hospital from The National Map Structures dataset.",
      },
    ],
  };
}

function criticalRecommendation(
  overrides: Partial<Recommendation> = {},
): Recommendation {
  const base: Recommendation = {
    id: "rec-critical-1",
    incidentId: "incident-ventura",
    assetId: "asset-hospital-1",
    assetName: "Ventura County Medical Center",
    assetType: "Critical Facility",
    locationLabel: "3291 Loma Vista Rd",
    coordinates: [-119.252, 34.278],
    recommendedAction: "Review response access and monitor nearby drainage.",
    finalScore: 0.64,
    score100: 64,
    riskLevel: "High",
    confidenceLevel: "Medium",
    reasonCodes: ["Critical Facility Exposure", "Downstream Exposure"],
    limitations: ["Facility exposure is screening context only."],
    changedSinceLastRefresh: "Source-Backed Candidate",
    sourcesUpdatedLabel: "Fresh",
    dataFreshnessHours: 1,
    scoreBreakdown: {
      rainfallThreat: 0.6,
      burnSeverity: 0.5,
      slopeTerrain: 0.5,
      downstreamExposure: 0.8,
      dataFreshness: 1,
      confidenceMultiplier: 0.8,
      baseScore: 0.8,
      finalScore: 0.64,
    },
    evidence: criticalFacility().evidence,
    sourceSnapshotIds: ["source-tnm-structures"],
    createdAt: "2026-06-28T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

function roadCrossing(): Asset {
  return {
    id: "asset-road-1",
    incidentId: "incident-ventura",
    name: "SR-33 @ Matilija Creek",
    type: "Road Crossing",
    locationLabel: "SR-33 near Matilija Creek",
    coordinates: [-119.302, 34.49],
    source: "TIGERweb roads + USGS 3DHP",
    confidence: "Medium",
    localOrUploaded: false,
    sourceKey: "tiger-roads",
    sourceFeatureId: "road-123",
    sourceFeatureIds: ["road-123", "flowline-123"],
    coverageStatus: "available",
    evidence: [
      {
        sourceKey: "tiger-roads",
        sourceName: "Census TIGERweb Transportation Roads",
        sourceFeatureId: "road-123",
        summary: "Road candidate from TIGERweb transportation geometry.",
      },
    ],
  };
}

function roadRecommendation(
  overrides: Partial<Recommendation> = {},
): Recommendation {
  const base: Recommendation = {
    ...criticalRecommendation(),
    id: "rec-road-1",
    assetId: "asset-road-1",
    assetName: "SR-33 @ Matilija Creek",
    assetType: "Road Crossing",
    locationLabel: "SR-33 near Matilija Creek",
    coordinates: [-119.302, 34.49],
    recommendedAction: "Review road crossing for inspection and monitoring.",
    score100: 51,
    finalScore: 0.51,
    riskLevel: "Medium",
    reasonCodes: ["Road Crossing Exposure", "Downstream Exposure"],
    evidence: roadCrossing().evidence,
  };
  return { ...base, ...overrides };
}
