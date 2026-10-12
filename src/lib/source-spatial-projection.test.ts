import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { packValidatedSourceGeometryPayload } from "./source-spatial-projection";
import { decodeSourceSpatialChunk, readSourceSpatialIndex, spatialBoundsOverlap, type SpatialBounds } from "./source-spatial-storage";
import { unpackSourcePayload } from "./source-payload-storage";
import { SOURCE_LINE_GEOMETRY_VERSION } from "./source-line-geometry";
import { PWFDF_ANALYSIS_GEOMETRY_VERSION } from "./pwfdf-geometry";
import type { SourceSnapshot } from "./types";

function source(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return { id: "source-test", incidentId: "incident-test", sourceKey: "tiger-roads", sourceName: "Census",
    fetchedAt: "2026-10-01T00:00:00.000Z", sourceUpdatedAt: "2026-09-30T00:00:00.000Z", sourceTimeBasis: "provider",
    status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Saved source", detail: "Saved source",
    rawPayload: { geometryVersion: SOURCE_LINE_GEOMETRY_VERSION, inventoryComplete: true, featureCount: 1,
      features: [{ id: "road-1", sourceKey: "tiger-roads", sourceName: "Census", paths: [[[-121, 35], [-120.9, 35.1]], [[-120, 36], [-119.9, 36.1]]] }] },
    ...overrides };
}

describe("validated spatial source projection", () => {
  it("indexes all disconnected parts while retaining original records and source time", () => {
    const snapshot = source(), before = structuredClone(snapshot);
    const stored = packValidatedSourceGeometryPayload(snapshot)!;
    expect(stored.rawPayloadSpatial.chunks[0].bounds).toEqual([-121, 35, -119.9, 36.1]);
    expect(unpackSourcePayload(stored)).toEqual(snapshot.rawPayload);
    expect(snapshot).toEqual(before);
  });
  it.each(["version", "count", "incomplete", "duplicate", "coordinate", "legacy", "coverage", "source"])("withholds %s-invalid layers instead of publishing partial coverage", kind => {
    const snapshot = source(), payload = snapshot.rawPayload!;
    const features = payload.features as Record<string, unknown>[];
    if (kind === "version") payload.geometryVersion = "legacy";
    if (kind === "count") payload.featureCount = 20;
    if (kind === "incomplete") payload.inventoryComplete = false;
    if (kind === "duplicate") { features.push(structuredClone(features[0])); payload.featureCount = 2; }
    if (kind === "coordinate") features[0].paths = [[[-121, 35], [Infinity, 35]]];
    if (kind === "legacy") features[0].coordinates = [[-121, 35], [-120, 35]];
    if (kind === "coverage") snapshot.coverageStatus = "partial";
    if (kind === "source") snapshot.sourceKey = "unrecognized";
    expect(packValidatedSourceGeometryPayload(snapshot)).toBeUndefined();
  });
  it("does not turn a missing or failed provider response into an empty available layer", () => {
    expect(packValidatedSourceGeometryPayload(null)).toBeUndefined();
    expect(packValidatedSourceGeometryPayload(source({ rawPayload: undefined }))).toBeUndefined();
    expect(packValidatedSourceGeometryPayload(source({ coverageStatus: "error", rawPayload: { available: false, status: "error", reason: "provider_error" } }))).toBeUndefined();
    expect(packValidatedSourceGeometryPayload(source({ rawPayload: { geometryVersion: SOURCE_LINE_GEOMETRY_VERSION, features: [], featureCount: 0, inventoryComplete: true } }))?.rawPayloadSpatial.count).toBe(0);
  });
  it("preserves repeated feature IDs scoped to different provider layers", () => {
    const snapshot = source(), features = snapshot.rawPayload!.features as Record<string, unknown>[];
    features[0].sourceUrl = "https://example.gov/MapServer/6/query";
    features.push({ ...features[0], sourceUrl: "https://example.gov/MapServer/8/query" });
    snapshot.rawPayload!.featureCount = 2;
    const stored = packValidatedSourceGeometryPayload(snapshot)!;
    expect(stored.rawPayloadSpatial.count).toBe(2);
    expect(unpackSourcePayload(stored)).toEqual(snapshot.rawPayload);
  });
  it("uses the complete basin topology and assessment validator, retaining holes", () => {
    const snapshot = source({ sourceKey: "usgs-pwfdf", rawPayload: {
      analysisGeometryVersion: PWFDF_ANALYSIS_GEOMETRY_VERSION,
      assessment: { fireId: "fire-a", fireName: "Fire A", assessmentDate: "2026-09-01" }, basinCount: 1,
      basins: [{ id: "basin-a", fireId: "fire-a", assessmentDate: "2026-09-01", probabilityClass: "60-80%", volumeClass: "1000-10000", combinedHazard: "High",
        geometry: { type: "Polygon", coordinates: [
          [[-122, 35], [-121, 35], [-121, 36], [-122, 36], [-122, 35]],
          [[-121.8, 35.2], [-121.8, 35.4], [-121.6, 35.4], [-121.6, 35.2], [-121.8, 35.2]],
        ] } }],
    } });
    const stored = packValidatedSourceGeometryPayload(snapshot)!;
    expect(stored).toBeDefined();
    expect(stored.rawPayloadSpatial.chunks[0].bounds).toEqual([-122, 35, -121, 36]);
    expect(unpackSourcePayload(stored)).toEqual(snapshot.rawPayload);
    snapshot.rawPayload!.basinCount = 2;
    expect(packValidatedSourceGeometryPayload(snapshot)).toBeUndefined();
    snapshot.rawPayload!.basinCount = 1;
    const basin = (snapshot.rawPayload!.basins as { geometry: { coordinates: number[][][] } }[])[0];
    basin.geometry.coordinates[1][0] = [-120, 34];
    expect(packValidatedSourceGeometryPayload(snapshot)).toBeUndefined();
  });
});

it.skipIf(process.env.FIREAFTER_SPATIAL_SOURCE_CAPACITY !== "true")("preserves every captured Monterey line and bounds only nearby chunk decoding", async () => {
  const input = await readFile("output/verification/monterey-public-lines-exact-county.json.gz");
  const captured = JSON.parse(gunzipSync(input).toString("utf8")) as { roads: Partial<SourceSnapshot>; hydro: Partial<SourceSnapshot> };
  const report: Record<string, unknown>[] = [];
  const viewport: SpatialBounds = [-121.58, 36.27, -121.51, 36.34];
  const budget = { remaining: 64 * 1024 * 1024 };
  for (const key of ["roads", "hydro"] as const) {
    const snapshot = source(captured[key]), original = JSON.stringify(snapshot.rawPayload);
    const start = performance.now(), stored = packValidatedSourceGeometryPayload(snapshot)!;
    expect(stored).toBeDefined();
    const packedMs = performance.now() - start;
    const index = readSourceSpatialIndex(stored);
    expect(index.count).toBe(key === "roads" ? 17_591 : 58_682);
    expect(JSON.stringify(unpackSourcePayload(stored, budget))).toBe(original);
    const selected = index.chunks.filter(chunk => spatialBoundsOverlap(chunk.bounds, viewport));
    const started = performance.now();
    const candidates = selected.flatMap(chunk => decodeSourceSpatialChunk(chunk, index.count));
    const inView = candidates.filter(entry => spatialBoundsOverlap(entry.bounds, viewport));
    const decodedMs = performance.now() - started;
    // Compare against a complete independently selected set; no missing candidate can hide behind a small response.
    const all = index.chunks.flatMap(chunk => decodeSourceSpatialChunk(chunk, index.count));
    const expected = all.filter(entry => spatialBoundsOverlap(entry.bounds, viewport)).map(entry => entry.position).sort((a, b) => a - b);
    expect(inView.map(entry => entry.position).sort((a, b) => a - b)).toEqual(expected);
    expect(inView.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(index.chunks.length);
    const selectedWireBytes = Buffer.byteLength(JSON.stringify(selected));
    expect(selectedWireBytes).toBeLessThan(2 * 1024 * 1024);
    report.push({ layer: key, records: index.count, originalBytes: stored.rawPayloadBytes, storedBytes: Buffer.byteLength(JSON.stringify(stored)),
      chunks: index.chunks.length, packedMs: Math.round(packedMs), viewport, selectedChunks: selected.length, selectedWireBytes,
      selectedExpandedBytes: selected.reduce((sum, chunk) => sum + chunk.bytes, 0), candidateRecords: candidates.length,
      bboxOverlappingRecords: inView.length, decodedMs: Math.round(decodedMs), originalHash: stored.rawPayloadHash });
  }
  await writeFile("output/verification/source-spatial-capacity-receipt.json", JSON.stringify({ verifiedAt: new Date().toISOString(),
    evidence: "Previously captured public source geometry; local codec/selection only, not a hosted RPC or fresh provider test.",
    fixtureSha256: createHash("sha256").update(input).digest("hex"), report }, null, 2));
  process.stdout.write(JSON.stringify({ event: "source-spatial-capacity", report }) + "\n");
}, 60_000);
