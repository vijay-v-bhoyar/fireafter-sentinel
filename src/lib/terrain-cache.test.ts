import { expect, it } from "vitest";
import { reuseTerrainSamples } from "./terrain-cache";
import type { Asset } from "./types";
const now = Date.parse("2026-10-07T12:00:00Z");
const asset = { id: "bridge", sourceKey: "fhwa-nbi-bridges", origin: "source", localOrUploaded: false, coordinates: [-118, 34] } as Asset;
const cached: Asset = { ...asset, metrics: { slopeTerrain: 0.4, elevationChangeMeters: 28, elevationSampleMeters: [100, 128], elevationSampledAt: "2026-10-07T11:00:00Z" },
  evidence: [{ sourceKey: "usgs-epqs", sourceName: "USGS 3DEP batch elevation", summary: "Screening terrain sample" }] };
it("reuses matching recent terrain without changing retrieval time or copying hazard bindings", () => {
  const [result] = reuseTerrainSamples([asset], [{ ...cached, metrics: { ...cached.metrics, pwfdfCombinedHazard: "High" } }], now);
  expect(result.metrics?.slopeTerrain).toBe(0.4);
  expect(result.metrics?.elevationSampledAt).toBe(cached.metrics?.elevationSampledAt);
  expect(result.metrics?.pwfdfCombinedHazard).toBeUndefined();
});
it("rejects moved, stale, future, unproven and uploaded terrain", () => {
  for (const prior of [{ ...cached, coordinates: [-117, 34] },
    { ...cached, metrics: { ...cached.metrics, elevationSampledAt: "2026-10-01T12:00:00Z" } },
    { ...cached, metrics: { ...cached.metrics, elevationSampledAt: "2026-10-08T12:00:00Z" } },
    { ...cached, evidence: [] }, { ...cached, localOrUploaded: true }]) {
    expect(reuseTerrainSamples([asset], [prior as Asset], now)[0].metrics).toBeUndefined();
  }
});
