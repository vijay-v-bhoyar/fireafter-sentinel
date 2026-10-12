import { describe, expect, it } from "vitest";
import { inventoryEvidenceGaps, projectPublishedHazards, rankPublishedHazards } from "./published-hazard";
import { ARCGIS_INVENTORY_VERSION } from "./arcgis-inventory-contract";
import { PWFDF_LINKAGE_VERSION } from "./pwfdf";
import { PWFDF_ANALYSIS_GEOMETRY_VERSION } from "./pwfdf-geometry";
import type { Asset, Incident, SourceSnapshot } from "./types";

const now = new Date("2026-10-06T12:00:00Z");
const incident = { id: "test", selectedFire: { name: "Test Fire", sourceKey: "wfigs", sourceFeatureId: "fire-1", coverageStatus: "available" } } as Incident;
const asset = (id = "bridge", x = 0.5): Asset => ({ id, incidentId: "test", name: id, type: "Bridge",
  locationLabel: "Test", coordinates: [x, 0.5], source: "FHWA", sourceKey: "fhwa-nbi-bridges", sourceFeatureId: id,
  coverageStatus: "available", confidence: "High", localOrUploaded: false, origin: "source" });
const source = (): SourceSnapshot => ({ id: "snapshot", incidentId: "test", sourceKey: "usgs-pwfdf", sourceName: "USGS",
  sourceUrl: "https://www.sciencebase.gov/catalog/item/test", fetchedAt: now.toISOString(), sourceUpdatedAt: "2026-09-01T00:00:00Z",
  sourceTimeBasis: "provider", status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Current", detail: "Test only",
  rawPayload: { available: true, linkageVersion: PWFDF_LINKAGE_VERSION, analysisGeometryVersion: PWFDF_ANALYSIS_GEOMETRY_VERSION,
    selectedFire: { name: "Test Fire", sourceKey: "wfigs", sourceFeatureId: "fire-1" },
    assessmentDiscovery: { version: ARCGIS_INVENTORY_VERSION, complete: true, expectedCount: 1, receivedCount: 1 },
    assessment: { fireName: "Test", fireId: "test-v1", assessmentDate: "2026-09-01T00:00:00Z", rainfallScenario: "24 mm/h" },
    basinCount: 2, basins: ["Low", "High"].map((combinedHazard, i) => ({ id: `basin-${i}`, fireId: "test-v1",
      assessmentDate: "2026-09-01T00:00:00Z", probabilityClass: "40-60%", volumeClass: "1,000-10,000", combinedHazard,
      geometry: { type: "Polygon", coordinates: [[[i * 2, 0], [i * 2 + 1, 0], [i * 2 + 1, 1], [i * 2, 1], [i * 2, 0]]] } })) } });

describe("separate published design-storm hazard ranking", () => {
  it("recomputes containment, orders published classes, and preserves the original assets", () => {
    const inputs = [asset("low"), asset("high", 2.5), asset("outside", 10)];
    const result = projectPublishedHazards(incident, inputs, [source()], now);
    expect(rankPublishedHazards(result).map(item => item.id)).toEqual(["high", "low"]);
    expect(result[1].publishedHazard).toMatchObject({ combinedHazard: "High", rainfallScenario: "24 mm/h", fireIdentity: "candidate" });
    expect(result[2].publishedHazard).toBeUndefined();
    expect(inputs.every(item => !item.publishedHazard)).toBe(true);
  });
  it.each(["expired", "future", "wrong-fire", "partial", "malformed", "wrong-incident"])("fails closed for %s evidence", mode => {
    const input = source();
    if (mode === "expired") input.fetchedAt = "2026-10-05T12:00:00Z";
    if (mode === "future") input.sourceUpdatedAt = "2027-01-01T00:00:00Z";
    if (mode === "wrong-fire") input.rawPayload!.selectedFire = { name: "Other", sourceKey: "wfigs", sourceFeatureId: "other" };
    if (mode === "partial") input.rawPayload!.basinCount = 3;
    if (mode === "malformed") input.rawPayload!.basins = [{}];
    if (mode === "wrong-incident") input.incidentId = "other";
    const previouslyLinked = projectPublishedHazards(incident, [asset()], [source()], now);
    expect(projectPublishedHazards(incident, previouslyLinked, [input], now)[0].publishedHazard).toBeUndefined();
  });
  it("does not reinterpret redacted facility centroids as asset coordinates", () => {
    const redacted = { ...asset(), type: "Critical Facility" as const, sourceKey: "critical-facility" };
    expect(projectPublishedHazards(incident, [redacted], [source()], now)[0].publishedHazard).toBeUndefined();
  });
  it("does not invent culvert verification requirements for official bridge points", () => {
    expect(inventoryEvidenceGaps(asset())).toEqual([]);
    expect(inventoryEvidenceGaps({ ...asset(), sourceFeatureId: undefined })).toEqual(["verified asset inventory"]);
    expect(inventoryEvidenceGaps({ ...asset(), origin: "uploaded" })).toEqual(["verified uploaded asset inventory"]);
    expect(inventoryEvidenceGaps({ ...asset(), type: "Inferred Crossing" })).toEqual(["verified culvert inventory"]);
  });
});
