import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { enrichAssetsWithElevation, fetchNbiBridgeSource } from "./live-sources";
import { withRefreshOperation } from "./refresh-operation";
import { TERRAIN_CHUNK_SIZE } from "./ingestion-contract";
import type { Asset, LocationCandidate } from "./types";

// Explicit opt-in public-provider probe; no Supabase writes or credentials.
it.skipIf(process.env.FIREAFTER_VERIFY_INGESTION_LIVE !== "1")("enriches one real, bounded bridge batch without a county-wide elevation sweep", async () => {
  const location: LocationCandidate = { id: "eaton-study-area", county: "Los Angeles County", state: "CA",
    label: "Eaton assessment extent; not full-county coverage", centroid: [-118.087687, 34.199152],
    bbox: [-118.19546180258274, 34.133777442782545, -117.97991276370482, 34.26452656518773],
    fips: "06037", fireWeatherZone: "", population: 0, wildfireContext: "Public provider diagnostic" };
  const source = await fetchNbiBridgeSource(location);
  expect(source.coverageStatus).toBe("available");
  const assets = (source.rawPayload.assets as Asset[]).slice(0, TERRAIN_CHUNK_SIZE);
  expect(assets).toHaveLength(TERRAIN_CHUNK_SIZE);
  const started = performance.now();
  const result = await withRefreshOperation("refresh", () => enrichAssetsWithElevation(assets, fetch));
  const report = { checkedAt: new Date().toISOString(), scope: location.label, assetCount: result.assets.length,
    elapsedMs: Math.round(performance.now() - started), unavailable: result.batchElevationUnavailable,
    terrainKnown: result.assets.filter(asset => Number.isFinite(asset.metrics?.slopeTerrain)).length };
  writeFileSync("output/verification/ingestion-live.json", JSON.stringify(report, null, 2));
  console.info(report);
  expect(result.assets).toHaveLength(assets.length);
  expect(report.unavailable).toBe(false);
  expect(report.terrainKnown).toBeGreaterThan(0);
}, 120_000);
