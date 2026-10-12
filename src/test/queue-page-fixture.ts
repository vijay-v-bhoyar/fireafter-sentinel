import { SCORING_VERSION } from "@/lib/scoring";
import type { QueuePage } from "@/lib/queue-page-contract";
import type { Bundle } from "@/components/fireafter-dashboard";
import { inventoryUser } from "./asset-page-fixture";

export function queuePage(start = 0, limit = 10, total = 26): QueuePage {
  return { incidentId: "county", canonicalIncidentId: "county", revision: "10000000-0000-4000-8000-000000000003",
    state: "current", evaluatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString(),
    start, limit, totalStored: total, nextStart: start + limit < total ? start + limit : null,
    items: Array.from({ length: Math.min(limit, total - start) }, (_, index) => ({ position: start + index + 1, status: "available", recommendation: {
      inventoryRevision: "10000000-0000-4000-8000-000000000003", id: `rec-${start + index}`, incidentId: "county", assetId: `asset-${start + index}`,
      assetName: `Bridge ${start + index + 1}`, assetType: "Bridge", locationLabel: "County creek", coordinates: [-119.2, 34.4],
      recommendedAction: "Review source evidence before taking action.", finalScore: 0.6, score100: 60, riskLevel: "High", confidenceLevel: "Medium",
      reasonCodes: ["Source evidence available"], limitations: ["Screening only"], changedSinceLastRefresh: "New record", sourcesUpdatedLabel: "Source checks current",
      dataFreshnessHours: 0, scoreBreakdown: { scoringVersion: SCORING_VERSION, rainfallThreat: 0.5, burnSeverity: 0.5, slopeTerrain: 0.5,
        downstreamExposure: 0.5, dataFreshness: 1, confidenceMultiplier: 0.8, baseScore: 0.5, finalScore: 0.6,
        metricStatus: { rainfallThreat: "available", burnSeverity: "available", slopeTerrain: "available", downstreamExposure: "available", dataFreshness: "available" } }, createdAt: new Date().toISOString(),
    } })),
  };
}
export function queueBundle(page = queuePage()): Bundle {
  return { queuePage: page, incident: { id: "county", recoveryScopeId: "10000000-0000-4000-8000-000000000004", locationId: "county", county: "Ventura County", state: "CA",
    title: "Saved county", code: "CA-TEST", status: "Monitoring", stormWindow: "Next 48-72 hrs", rainfallForecast: "Source evidence required", lastRefresh: "Saved", dataFreshness: "Low",
    activeAlerts: 0, alertCoverageStatus: "unavailable", selectedFire: { name: "Not selected", acres: 0, perimeterUpdated: "Unknown", source: "None" } },
    locations: [], assets: [], actions: [], auditEvents: [], currentUser: inventoryUser, sensitiveInfrastructureAccess: true,
    recommendations: page.items.flatMap(item => item.status === "available" ? [item.recommendation] : []),
    sourceSnapshots: [{ id: "source", incidentId: "county", sourceKey: "nbi", sourceName: "Bridge Inventory", fetchedAt: page.evaluatedAt, sourceUpdatedAt: page.evaluatedAt,
      sourceTimeBasis: "provider", status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Checked", detail: "Source checked",
      freshness: { state: "current", evaluatedAt: page.evaluatedAt, expiresAt: page.expiresAt, maxAgeMinutes: 30 } }],
  };
}
