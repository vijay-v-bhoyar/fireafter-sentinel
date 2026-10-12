import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync } from "node:zlib";
import { runLiveSourceRefresh, searchLocationsLive } from "./live-sources";
import { createIncidentFromLocation } from "./fireafter-store";

// Opt-in read-only provider probe. No credentials, database writes, or fixture data.
it.skipIf(process.env.FIREAFTER_LIVE_COUNTY_DIAGNOSTIC !== "1")("measures real Okanogan source payloads", async () => {
  const started = performance.now();
  const candidates = await searchLocationsLive("Okanogan WA");
  const location = candidates.find(candidate => candidate.id === "okanogan-county-wa");
  expect(location).toBeDefined();
  const result = await runLiveSourceRefresh({
    incident: createIncidentFromLocation(location!), assets: [], previousRecommendations: [], previousSourceSnapshots: [],
  });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const measurements = {
    elapsedMs: Math.round(performance.now() - started),
    assets: result.assets.length, recommendations: result.recommendations.length,
    incidentBytes: bytes(result.incident), assetBytes: bytes(result.assets), recommendationBytes: bytes(result.recommendations),
    snapshots: result.sourceSnapshots.map(source => {
      const raw = Buffer.from(JSON.stringify(source.rawPayload));
      const compressed = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
      expect(brotliDecompressSync(compressed).equals(raw)).toBe(true);
      return { sourceKey: source.sourceKey, status: source.status, bytes: bytes(source),
        gzipBase64Bytes: gzipSync(raw).toString("base64").length,
        brotliBase64Bytes: compressed.toString("base64").length };
    }),
  };
  mkdirSync("output", { recursive: true });
  writeFileSync("output/live-county-diagnostic.json", JSON.stringify(measurements, null, 2));
  console.info("Live county payload measurements", measurements);
  expect(result.assets.length).toBeGreaterThan(0);
}, 150_000);
