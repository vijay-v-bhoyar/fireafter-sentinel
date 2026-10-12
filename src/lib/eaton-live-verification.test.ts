import { mkdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fetchNbiBridgeSource, fetchPwfdfSource } from "./live-sources";
import { buildPwfdfLocationsUrl, selectPwfdfAssessment } from "./pwfdf";
import { projectPublishedHazards, rankPublishedHazards } from "./published-hazard";
import type { Asset, Incident, LocationCandidate, SourceSnapshot } from "./types";

// Public-provider-only diagnostic. No database writes, credentials, or fabricated asset points.
it.skipIf(process.env.FIREAFTER_VERIFY_EATON !== "1")("links real Eaton assessment basins to real bridge inventory", async () => {
  const now = new Date();
  const location: LocationCandidate = { id: "eaton-study-area", county: "Los Angeles County", state: "CA",
    label: "Eaton assessment extent (not the whole county)", centroid: [-118.087687, 34.199152],
    bbox: [-118.19546180258274, 34.133777442782545, -117.97991276370482, 34.26452656518773],
    fips: "06037", fireWeatherZone: "", population: 0, wildfireContext: "USGS Eaton assessment extent" };
  const response = await fetch(buildPwfdfLocationsUrl(location.bbox!), { signal: AbortSignal.timeout(30_000) });
  expect(response.ok).toBe(true);
  const assessment = selectPwfdfAssessment(await response.json(), "Eaton");
  expect(assessment, "USGS must return an Eaton assessment; no substitute fire is allowed").not.toBeNull();
  // Select the actual USGS assessment for this isolated diagnostic, not an invented WFIGS crosswalk.
  const incident = { id: "eaton-public-provider-verification", selectedFire: { name: assessment!.fireName,
    sourceKey: "usgs-pwfdf", sourceFeatureId: assessment!.fireId, coverageStatus: "available" } } as Incident;
  const hazardSource = await fetchPwfdfSource(location, incident, { now });
  const bridgeSource = await fetchNbiBridgeSource(location, { now });
  expect(hazardSource.coverageStatus).toBe("available");
  expect(bridgeSource.coverageStatus).toBe("available");
  const assets = (bridgeSource.rawPayload.assets as Asset[]).map(asset => ({ ...asset,
    id: `fhwa-${asset.sourceFeatureId}`, incidentId: incident.id }));
  const snapshot = { ...hazardSource, id: "eaton-verification", incidentId: incident.id } as SourceSnapshot;
  const ranked = rankPublishedHazards(projectPublishedHazards(incident, assets, [snapshot], now));
  const report = { checkedAt: now.toISOString(), scope: location.label, assessment,
    bridgeCount: assets.length, linkedBridgeCount: ranked.length,
    classes: ranked.map(asset => ({ name: asset.name, sourceFeatureId: asset.sourceFeatureId, publishedHazard: asset.publishedHazard })),
    limitations: ["Read-only public-provider test, not a production incident or WFIGS identity verification.",
      "Published design-storm classes are not current-event predictions. No synthetic points were used."] };
  mkdirSync("output/verification", { recursive: true });
  writeFileSync("output/verification/eaton-published-hazard.json", JSON.stringify(report, null, 2));
  console.info(JSON.stringify({ assessment: assessment!.fireId, bridges: assets.length, linkedBridges: ranked.length,
    classes: [...new Set(ranked.map(asset => asset.publishedHazard!.combinedHazard))] }));
  expect(ranked.length, "Do not advertise a usable bridge demo without at least one real spatial match").toBeGreaterThan(0);
}, 150_000);
