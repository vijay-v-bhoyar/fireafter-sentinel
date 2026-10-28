import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CountyScopeError, countyQueryGeometry, normalizeCountyBoundary, prepareCountyScope, prepareCountyScopeFactory } from "./county-scope";
import { containsBasinPoint } from "./pwfdf-geometry";
import type { Incident } from "./types";

const shell: [number, number][] = [[0, 0], [8, 0], [8, 8], [0, 8], [0, 0]];
const hole: [number, number][] = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
const island: [number, number][] = [[10, 0], [12, 0], [12, 2], [10, 2], [10, 0]];
function incident(): Pick<Incident, "locationContext"> {
  return { locationContext: { id: "test", county: "Test County", label: "Test County", state: "CA", fips: "06001",
    centroid: [1, 1], bbox: [0, 0, 12, 8], population: 0, fireWeatherZone: "auto", wildfireContext: "Test only",
    sourceKey: "tigerweb-counties", boundary: { type: "Polygon", coordinates: [hole, island, shell] } } };
}

describe("county scope", () => {
  it("preserves all holes/islands and vertices with Esri query winding without mutating input", () => {
    const input = incident().locationContext!.boundary;
    const before = structuredClone(input);
    const output = countyQueryGeometry(input, [0, 0, 12, 8]);
    expect(output.spatialReference).toEqual({ wkid: 4326 });
    expect(output.rings.flat().toSorted()).toEqual([shell, hole, island].flat().toSorted());
    const area = (ring: [number, number][]) => ring.slice(1).reduce((sum, point, index) => sum + ring[index][0] * point[1] - point[0] * ring[index][1], 0);
    expect(output.rings.map(area).toSorted((a, b) => a - b)).toEqual([-128, -8, 8]);
    expect(input).toEqual(before);
    const roundTrip = normalizeCountyBoundary({ type: "Polygon", coordinates: output.rings });
    expect(containsBasinPoint([1, 1], roundTrip)).toBe(true);
    expect(containsBasinPoint([3, 3], roundTrip)).toBe(false);
    expect(containsBasinPoint([11, 1], roundTrip)).toBe(true);
    expect(containsBasinPoint([9, 1], roundTrip)).toBe(false);
  });

  it("rejects a query extent that would misrepresent the supplied county geometry", () => {
    expect(() => countyQueryGeometry(incident().locationContext!.boundary, [0, 0, 8, 8])).toThrow(CountyScopeError);
  });

  it("preserves islands and holes regardless of Esri ring order or winding", () => {
    const { boundary, contains } = prepareCountyScope(incident());
    expect(boundary?.type).toBe("MultiPolygon");
    expect(contains([1, 1])).toBe(true);
    expect(contains([11, 1])).toBe(true);
    expect(contains([3, 3])).toBe(false);
    expect(contains([9, 1])).toBe(false);
    expect(contains([12.01, 1])).toBe(false);
    expect(contains([NaN, 1])).toBe(false);
    if (boundary?.type === "MultiPolygon") boundary.coordinates[0][0][0] = [99, 99];
    expect(contains([1.1, 1])).toBe(true);
  });

  it("includes a county boundary point without changing strict hazard linkage", () => {
    const scope = prepareCountyScope(incident());
    expect(scope.contains([0, 1])).toBe(true);
    expect(scope.contains([2, 3])).toBe(true);
    expect(containsBasinPoint([0, 1], { type: "Polygon", coordinates: [shell] })).toBe(false);
  });

  it("uses a private snapshot without mutating or retaining caller geometry", () => {
    const input = incident();
    const before = structuredClone(input);
    const scope = prepareCountyScope(input);
    expect(input).toEqual(before);
    input.locationContext!.boundary = { type: "Polygon", coordinates: [island] };
    expect(scope.contains([1, 1])).toBe(true);
    expect(prepareCountyScope(input).contains([1, 1])).toBe(false);
  });

  it("rejects invalid or missing live county geometry instead of using a rectangle", () => {
    const input = incident();
    input.locationContext!.boundary = undefined;
    expect(() => prepareCountyScope(input)).toThrow(CountyScopeError);
    expect(() => normalizeCountyBoundary({ type: "Polygon", coordinates: [shell.slice(1)] })).toThrow(CountyScopeError);
    expect(() => normalizeCountyBoundary({ type: "Point", coordinates: [1, 1] })).toThrow(CountyScopeError);
    expect(() => normalizeCountyBoundary({ type: "Polygon", coordinates: [shell], crs: "unverified" })).toThrow(CountyScopeError);
    expect(prepareCountyScope({}).contains([1, 1])).toBe(false);
  });

  it("bounds processing without returning a partial geographic inventory", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const scope = prepareCountyScope(incident());
      expect(scope.contains([1, 1])).toBe(true);
      clock.mockReturnValue(5001);
      expect(() => scope.contains([1.5, 1])).toThrow(CountyScopeError);
    } finally { clock.mockRestore(); }
  });

  it("reuses a private topology snapshot with independent page deadlines and isolated result geometry", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const input = incident(), nextPage = prepareCountyScopeFactory(input);
      const first = nextPage();
      expect(first.contains([1, 1])).toBe(true);
      input.locationContext!.boundary = { type: "Polygon", coordinates: [island] };
      input.locationContext!.bbox = [10, 0, 12, 2];
      if (first.boundary?.type === "MultiPolygon") first.boundary.coordinates[0][0][0] = [99, 99];
      clock.mockReturnValue(5001);
      expect(() => first.contains([1.5, 1])).toThrow(CountyScopeError);
      const second = nextPage();
      expect(second.contains([1.5, 1])).toBe(true);
      expect(second.contains([3, 3])).toBe(false);
      expect(second.contains([11, 1])).toBe(true);
      expect(second.boundary).not.toEqual(first.boundary);
      clock.mockReturnValue(10002);
      expect(() => second.contains([1.6, 1])).toThrow(CountyScopeError);
    } finally { clock.mockRestore(); }
  });

  it("keeps the original uncached query ceiling in every factory window after cache eviction", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const nextPage = prepareCountyScopeFactory(incident()), first = nextPage();
      for (let index = 0; index < 100_000; index++) expect(first.contains([1 + index / 1_000_000, 1])).toBe(true);
      expect(() => first.contains([1.2, 1])).toThrow(CountyScopeError);
      expect(nextPage().contains([1.2, 1])).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it("checks a full large inventory with bounded cache eviction and an independent query ceiling", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const scope = prepareCountyScope(incident());
      for (let i = 0; i < 100_000; i++) expect(scope.contains([1 + i / 200_000, 1])).toBe(true);
      expect(scope.contains([1 + 99_999 / 200_000, 1])).toBe(true);
      // This first point was evicted; recomputation still consumes the hard budget.
      expect(() => scope.contains([1, 1])).toThrow(CountyScopeError);
      expect(scope.contains([9, 9])).toBe(false);
    } finally { clock.mockRestore(); }
  });

  it.runIf(process.env.FIREAFTER_COUNTY_FIXTURE === "true")("matches the real Monterey PostGIS oracle without dropping any in-county bridge", () => {
    const fixture = JSON.parse(readFileSync("output/verification/monterey-geography-fixture.json", "utf8"));
    const input = incident();
    input.locationContext!.bbox = [-180, -90, 180, 90];
    input.locationContext!.boundary = fixture.county;
    const scope = prepareCountyScope(input);
    const matches = fixture.bridges.filter((bridge: { coordinates: [number, number] }) => scope.contains(bridge.coordinates));
    expect(fixture.bridges).toHaveLength(605);
    expect(matches).toHaveLength(372);
    expect(fixture.bridges.length - matches.length).toBe(233);
  });
});
