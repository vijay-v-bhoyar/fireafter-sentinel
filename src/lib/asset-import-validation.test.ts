import { describe, expect, it } from "vitest";
import { createIncident, prepareAssetImport } from "./fireafter-store";
import { IMPORT_LIMITS, parseAssetUpload, projectUploadedAsset, validateImportGeometry } from "./asset-import-validation";
import type { Asset } from "./types";

const incident = createIncident("ventura-ca");
const ring = [[-119.3, 34.3], [-119.1, 34.3], [-119.1, 34.6], [-119.3, 34.6], [-119.3, 34.3]];
const hole = [[-119.25, 34.4], [-119.2, 34.5], [-119.15, 34.4], [-119.25, 34.4]];
function imported(): Asset {
  return prepareAssetImport({ incidentId: incident.id, fileName: "assets.csv", content: "name,lat,lon\nA,34.4,-119.2" }, incident).assets[0];
}

describe("FA12 bounded topology and retained-data contract", () => {
  it("rejects an uploaded primary location outside the county but inside its envelope", () => {
    const scoped = { ...incident, locationContext: { ...incident.locationContext!,
      boundary: { type: "Polygon" as const, coordinates: [ring as [number, number][]] } } };
    const result = parseAssetUpload({ fileName: "assets.csv", content: "name,lat,lon\nInside,34.4,-119.2\nNeighbor,34.4,-119.4" }, scoped);
    expect(result.assets).toHaveLength(1);
    expect(result.errors.join(" ")).toContain("outside the county boundary");
  });

  it("reuses a matching retained asset identity when reimporting after an upgrade", () => {
    const existing = { ...imported(), id: "historical-domain-asset-id" };
    const result = prepareAssetImport({ incidentId: incident.id, fileName: "assets.csv", content: "name,lat,lon\nA,34.4,-119.2" }, incident, [existing]);
    expect(result.assets[0].id).toBe(existing.id);
    expect(existing.confidence).toBe("Low");
  });
  it("preserves distinct same-start paths and asset types instead of silently merging them", () => {
    const content = JSON.stringify({ type: "FeatureCollection", features: [
      { type: "Feature", properties: { name: "County route", type: "road crossing" }, geometry: { type: "LineString", coordinates: [[-119.2, 34.4], [-119.3, 34.5]] } },
      { type: "Feature", properties: { name: "County route", type: "road crossing" }, geometry: { type: "LineString", coordinates: [[-119.2, 34.4], [-119.1, 34.5]] } },
      { type: "Feature", properties: { name: "County route", type: "evacuation route" }, geometry: { type: "LineString", coordinates: [[-119.2, 34.4], [-119.1, 34.5]] } },
    ] });
    const result = prepareAssetImport({ incidentId: incident.id, fileName: "routes.geojson", content }, incident);
    expect(result.assets).toHaveLength(3);
    expect(new Set(result.assets.map((asset) => asset.id)).size).toBe(3);
    expect(result.assets.map((asset) => asset.geometry)).toEqual(JSON.parse(content).features.map((feature: { geometry: unknown }) => feature.geometry));
    expect(result.importErrors).toEqual([]);
  });
  it.each([
    [ring, hole, hole],
    [ring, hole, [[-119.22, 34.42], [-119.2, 34.46], [-119.18, 34.42], [-119.22, 34.42]]],
    [[[-119.3, 34.3], [-119.1, 34.3], [-119.2, 34.3], [-119.2, 34.6], [-119.3, 34.3]]],
  ].map((coordinates) => ({ coordinates })))("rejects overlapping, nested holes or adjacent backtracking %#", ({ coordinates }) => {
    expect(() => validateImportGeometry({ type: "Polygon", coordinates }, incident)).toThrow();
  });

  it("accepts reversed winding without changing it", () => {
    const geometry = { type: "Polygon", coordinates: [ring.toReversed(), hole.toReversed()] };
    expect(validateImportGeometry(geometry, incident)).toEqual(geometry);
  });

  it("rejects global bounds even if a malformed incident envelope includes them", () => {
    expect(() => validateImportGeometry({ type: "Point", coordinates: [181, 91] }, { ...incident, locationContext: { ...incident.locationContext!, bbox: [-200, -100, 200, 100] } })).toThrow(/WGS84/);
  });

  it("rejects an entire over-budget upload instead of accepting its prefix", () => {
    const content = "name,lat,lon\n" + Array.from({ length: IMPORT_LIMITS.records + 1 }, (_, i) => `${i},34.4,-119.2`).join("\n");
    const result = parseAssetUpload({ content, fileName: "assets.csv" }, incident);
    expect(result.assets).toEqual([]);
    expect(result.errors).toEqual([expect.stringMatching(/record limit/)]);
  });

  it("bounds aggregate vertex and polygon work across retained assets", () => {
    const asset = imported();
    expect(() => projectUploadedAsset(asset, incident, { vertices: IMPORT_LIMITS.vertices, comparisons: 0 })).toThrow(/validation limits/);
    expect(() => validateImportGeometry({ type: "Polygon", coordinates: [ring] }, incident, { vertices: 0, comparisons: IMPORT_LIMITS.comparisons })).toThrow(/budget exceeded/);
  });

  it("preserves valid legacy geometry but removes unearned confidence without mutating history input", () => {
    const asset = { ...imported(), confidence: "High" as const, confidenceReason: "Verified by filename" };
    const before = structuredClone(asset);
    expect(projectUploadedAsset(asset, incident)).toMatchObject({ confidence: "Low", confidenceReason: expect.stringMatching(/unverified/) });
    expect(asset).toEqual(before);
  });

  it.each([
    { geometry: undefined },
    { coordinates: [-119.3, 34.4] },
    { coordinates: ["-119.2", 34.4] },
    { coordinates: [-119.2, 34.4, 0] },
    { geometry: { type: "LineString", coordinates: [[-119.2, 34.4], [999, 34.5]] } },
  ])("fails visibly for invalid retained upload %#", (change) => {
    expect(() => projectUploadedAsset({ ...imported(), ...change } as Asset, incident)).toThrow(/correct and reimport/);
  });

  it("uses any persisted upload marker, not only the legacy boolean", () => {
    expect(projectUploadedAsset({ ...imported(), localOrUploaded: false, origin: undefined, sourceKey: "local-upload", confidence: "High" }, incident).confidence).toBe("Low");
  });

  it("rejects unsupported asset types instead of classifying them as roads", () => {
    const result = prepareAssetImport({ incidentId: incident.id, fileName: "assets.csv", content: "name,type,lat,lon\nA,unknown-facility,34.4,-119.2" }, incident);
    expect(result.assets).toEqual([]);
    expect(result.auditEvent).toBeNull();
    expect(result.importErrors).toEqual([expect.stringMatching(/unsupported asset type/)]);
  });
});
