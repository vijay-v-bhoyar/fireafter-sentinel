import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parsePwfdfBasins, pwfdfBasinsFromSnapshot, linkPwfdfHazardsToAssets } from "./pwfdf";
import { geometryBudget, parseArcgisBasinGeometry, prepareBasinContainment, type Position, type BasinGeometry } from "./pwfdf-geometry";
import type { Asset, SourceSnapshot } from "./types";

const raw = gunzipSync(readFileSync(new URL("../test/fixtures/plaskett-pwfdf-20261002.json.gz", import.meta.url)));
const capture = JSON.parse(raw.toString()) as { features: { attributes: { OBJECTID: number }; geometry: { rings: Position[][] } }[] };
const provenance = JSON.parse(readFileSync(new URL("../test/fixtures/plaskett-pwfdf-20261002.provenance.json", import.meta.url), "utf8"));
const assessment = { fireName: "Plaskett", fireId: "Plaskett_2026-08-26_v1.0", assessmentDate: "2026-09-24T00:00:00.000Z" };
const flattened = (geometry: BasinGeometry) => geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
const edges = (rings: Position[][]) => rings.flatMap(ring => ring.slice(0, -1)
  .map((point, i) => [JSON.stringify(point), JSON.stringify(ring[i + 1])].sort().join("|"))).sort();

// Independent even-odd ray casting on the original Esri rings, for non-boundary probes.
function originalContains(point: Position, rings: Position[][]) {
  let inside = false;
  for (const ring of rings) for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

describe("captured full-resolution public Plaskett assessment", () => {
  it("preserves every provider feature and edge within the shared validation budget", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(provenance.sha256);
    expect(capture.features).toHaveLength(provenance.featureCount);
    const budget = geometryBudget();
    let vertices = 0;
    for (const feature of capture.features) {
      const rings = feature.geometry.rings;
      vertices += rings.reduce((count, ring) => count + ring.length, 0);
      const geometry = parseArcgisBasinGeometry(rings, budget);
      expect(edges(flattened(geometry))).toEqual(edges(rings));
      const contains = prepareBasinContainment(geometry, budget);
      const points = rings.flat();
      const west = Math.min(...points.map(p => p[0])), east = Math.max(...points.map(p => p[0]));
      const south = Math.min(...points.map(p => p[1])), north = Math.max(...points.map(p => p[1]));
      for (const x of [0.163, 0.513, 0.827]) for (const y of [0.163, 0.513, 0.827]) {
        const point: Position = [west + (east - west) * x, south + (north - south) * y];
        expect(contains(point)).toBe(originalContains(point, rings));
      }
      expect(contains(rings[0][0])).toBe(false);
    }
    expect(vertices).toBe(provenance.inputVertices);
    expect(budget.work).toBeLessThan(1_000_000);
  });

  // Full-resolution serialization and containment run on shared CI CPUs; this is
  // a correctness fixture, not a latency SLA. Production geometry budgets remain unchanged.
  it("round-trips the complete basin collection and links a large inventory without budget truncation", () => {
    const basins = parsePwfdfBasins(capture, assessment);
    const snapshot: SourceSnapshot = { id: "source", incidentId: "test", sourceKey: "usgs-pwfdf", sourceName: "USGS",
      status: "online", stale: false, coverageStatus: "available", fetchedAt: assessment.assessmentDate,
      sourceUpdatedAt: assessment.assessmentDate, detail: "Offline public capture", freshnessLabel: "Captured",
      rawPayload: { analysisGeometryVersion: "2026-09-14-provider-resolution-v1", assessment, basinCount: 197, basins } };
    expect(pwfdfBasinsFromSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(basins);
    const outside = Array.from({ length: 1000 }, (_, i) => ({ id: `test-${i}`, coordinates: [-120, 37],
      evidence: [], metrics: {} } as unknown as Asset));
    const linked = linkPwfdfHazardsToAssets(outside, assessment, basins);
    expect(linked).toHaveLength(1000);
    expect(linked.every(asset => asset.evidence?.length === 0)).toBe(true);
  }, 30_000);

  it("links an independently located interior probe in every real basin after snapshot reload", () => {
    const basins = parsePwfdfBasins(capture, assessment);
    const probes = capture.features.map((feature, index) => {
      const points = feature.geometry.rings.flat();
      const west = Math.min(...points.map(p => p[0])), east = Math.max(...points.map(p => p[0]));
      const south = Math.min(...points.map(p => p[1])), north = Math.max(...points.map(p => p[1]));
      let interior: Position | undefined;
      for (let x = 0; x < 31 && !interior; x++) for (let y = 0; y < 31 && !interior; y++) {
        const point: Position = [west + (east - west) * (x + 0.413) / 31, south + (north - south) * (y + 0.413) / 31];
        if (originalContains(point, feature.geometry.rings)) interior = point;
      }
      expect(interior, `Interior for provider feature ${feature.attributes.OBJECTID}`).toBeDefined();
      return { id: `interior-probe-${index}`, coordinates: interior!, evidence: [], metrics: {} } as unknown as Asset;
    });
    // These are offline test probes, not real assets and never persisted or shipped as a fallback.
    const linked = linkPwfdfHazardsToAssets(probes, assessment, JSON.parse(JSON.stringify(basins)));
    expect(linked).toHaveLength(197);
    linked.forEach((asset, index) => {
      const evidence = asset.evidence?.find(item => item.sourceKey === "usgs-pwfdf");
      expect(evidence).toBeDefined();
      const linkedIndex = basins.findIndex(basin => basin.id === evidence!.sourceFeatureId);
      expect(linkedIndex).toBeGreaterThanOrEqual(0);
      expect(originalContains(probes[index].coordinates, capture.features[linkedIndex].geometry.rings)).toBe(true);
      expect(asset.metrics?.pwfdfCombinedHazard).toBe(basins[linkedIndex].combinedHazard);
    });
  });
});
