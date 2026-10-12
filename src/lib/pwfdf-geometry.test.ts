import { describe, expect, it } from "vitest";
import { parsePwfdfBasins, pwfdfBasinsFromSnapshot } from "./pwfdf";
import { coordinateInPolygon } from "./geo";
import type { SourceSnapshot } from "./types";
import { classifyRing, geometryBudget, parseArcgisBasinGeometry, prepareBasinContainment, validateBasinGeometry, PWFDF_GEOMETRY_LIMITS, PwfdfGeometryError } from "./pwfdf-geometry";

const assessment = { fireName: "Test", fireId: "test", assessmentDate: "2026-09-14T00:00:00.000Z" };
const square = (x = 0, y = 0, size = 4) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
function feature(rings: unknown, id = 1) {
  return { attributes: { OBJECTID: id, fire_id: "test", assessment_date: assessment.assessmentDate, BP_Legend: "20-40%", BV_Legend: "100-1000", BCH_Legend: "High" }, geometry: { rings } };
}
function snapshot(basins: unknown[]): SourceSnapshot {
  return { id: "test", incidentId: "test", sourceName: "USGS", sourceKey: "usgs-pwfdf", status: "online",
    coverageStatus: "available", fetchedAt: assessment.assessmentDate, sourceUpdatedAt: assessment.assessmentDate,
    stale: false, freshnessLabel: "Test", detail: "Test", rawPayload: { analysisGeometryVersion: "2026-09-14-provider-resolution-v1", assessment, basins } };
}

describe("FA08 basin topology", () => {
  it.each([
    ["coerced null", [[[null, 0], [4, 0], [4, 4], [0, 4], [null, 0]]]],
    ["coerced string", [[["0", 0], [4, 0], [4, 4], [0, 4], ["0", 0]]]],
    ["extra ordinate", [square().map(p => [...p, 3])]],
    ["zero area", [[[0, 0], [1, 1], [2, 2], [0, 0]]]],
    ["bow tie", [[[0, 0], [4, 4], [0, 4], [4, 0], [0, 0]]]],
    ["adjacent retrace", [[[0, 0], [4, 0], [2, 0], [4, 4], [0, 4], [0, 0]]]],
    ["crossing rings", [square(), square(2, 2)]],
    ["shared segment", [square(), square(4, 1)]],
  ])("rejects %s instead of claiming a valid basin", (_name, rings) => {
    expect(() => parsePwfdfBasins({ features: [feature(rings)] }, assessment)).toThrow();
  });

  it("preserves separated exteriors, holes and islands regardless of ArcGIS ring order", () => {
    const rings = [square(1.5, 1.5, 0.5), square(10, 0), square(1, 1, 2).reverse(), square()];
    const before = structuredClone(rings);
    const [basin] = parsePwfdfBasins({ features: [feature(rings)] }, assessment);
    expect(basin.geometry.type).toBe("MultiPolygon");
    expect(rings).toEqual(before);
    for (const [point, inside] of [[[0.5, 0.5], true], [[1.2, 1.2], false], [[1.7, 1.7], true], [[11, 1], true], [[7, 1], false]] as const) {
      expect(coordinateInPolygon([...point], basin.geometry)).toBe(inside);
    }
    const persisted = pwfdfBasinsFromSnapshot(snapshot(JSON.parse(JSON.stringify([basin]))));
    expect(persisted).toEqual([basin]);
  });

  it("rejects the entire persisted collection, rather than silently dropping one malformed basin", () => {
    const [valid] = parsePwfdfBasins({ features: [feature([square()])] }, assessment);
    const invalid = { ...valid, id: "bad", geometry: { type: "Polygon", coordinates: [[[0, 0], [4, 4], [0, 4], [4, 0], [0, 0]]] } };
    expect(pwfdfBasinsFromSnapshot(snapshot([valid, invalid]))).toEqual([]);
  });

  it("rejects an outside or nested GeoJSON hole and a forged geometry discriminator", () => {
    const [valid] = parsePwfdfBasins({ features: [feature([square()])] }, assessment);
    for (const geometry of [
      { type: "Polygon", coordinates: [square(), square(10, 0)] },
      { type: "Polygon", coordinates: [square(), square(1, 1, 2), square(1.5, 1.5, 0.5)] },
      { type: "LineString", coordinates: [square()] },
    ]) expect(pwfdfBasinsFromSnapshot(snapshot([{ ...valid, geometry }]))).toEqual([]);
  });

  it("does not claim containment on any shell or hole boundary, regardless of winding", () => {
    for (const reverse of [false, true]) {
      const rings = [square(), square(1, 1, 2)].map(r => reverse ? r.reverse() : r);
      const geometry = parseArcgisBasinGeometry(rings);
      for (const p of [[0, 0], [4, 4], [0, 2], [4, 2], [2, 0], [2, 4], [1, 2], [3, 2], [2, 1], [2, 3]]) {
        expect(coordinateInPolygon(p as [number, number], geometry)).toBe(false);
      }
      expect(coordinateInPolygon([0.5, 0.5], geometry)).toBe(true);
    }
  });

  it("uses exact original coordinates when floating point determinants underflow", () => {
    const size = Number.MIN_VALUE * 8;
    const geometry = parseArcgisBasinGeometry([square(0, 0, size)]);
    expect(coordinateInPolygon([size / 2, size / 2], geometry)).toBe(true);
    expect(coordinateInPolygon([size, size / 2], geometry)).toBe(false);
    expect(validateBasinGeometry(geometry)).toEqual(geometry);
  });

  it("rejects wraparound, duplicate rings and overlapping filled MultiPolygon components", () => {
    expect(() => parseArcgisBasinGeometry([[[179, 0], [-179, 0], [-179, 2], [179, 2], [179, 0]]])).toThrow(PwfdfGeometryError);
    expect(() => parseArcgisBasinGeometry([square(), square().reverse()])).toThrow(PwfdfGeometryError);
    expect(() => validateBasinGeometry({ type: "MultiPolygon", coordinates: [[square()], [square(1, 1, 2)]] })).toThrow(PwfdfGeometryError);
  });

  it("preserves neighboring basin features even when their boundaries coincide", () => {
    expect(parsePwfdfBasins({ features: [feature([square()], 1), feature([square(4, 0)], 2)] }, assessment)).toHaveLength(2);
    expect(() => parsePwfdfBasins({ features: [feature([square()], 1), feature([square()], 1)] }, assessment)).toThrow();
  });

  it("shares vertex and work limits across geometry calls, with exact-limit acceptance", () => {
    const budget = { vertices: PWFDF_GEOMETRY_LIMITS.vertices - 5, work: 0 };
    parseArcgisBasinGeometry([square()], budget);
    expect(budget.vertices).toBe(PWFDF_GEOMETRY_LIMITS.vertices);
    expect(() => parseArcgisBasinGeometry([square()], budget)).toThrow(expect.objectContaining({ code: "pwfdf_geometry_budget" }));
    const measured = geometryBudget();
    parseArcgisBasinGeometry([square()], measured);
    const exact = { vertices: 0, work: PWFDF_GEOMETRY_LIMITS.work - measured.work };
    parseArcgisBasinGeometry([square()], exact);
    expect(exact.work).toBe(PWFDF_GEOMETRY_LIMITS.work);
    expect(() => parseArcgisBasinGeometry([square()], { vertices: 0, work: PWFDF_GEOMETRY_LIMITS.work - measured.work + 1 }))
      .toThrow(expect.objectContaining({ code: "pwfdf_geometry_budget" }));
  });

  it("does not reset the collection vertex budget between many valid basin features", () => {
    const count = Math.ceil(PWFDF_GEOMETRY_LIMITS.vertices / 400);
    const ring = Array.from({ length: count }, (_, i) => [Math.cos(i * Math.PI * 2 / count), Math.sin(i * Math.PI * 2 / count)]);
    ring.push([...ring[0]]);
    expect(() => parsePwfdfBasins({ features: Array.from({ length: 400 }, (_, i) => feature([ring], i + 1)) }, assessment))
      .toThrow(expect.objectContaining({ code: "pwfdf_geometry_budget" }));
  });

  it("splits an ArcGIS vertex-touch walk into disjoint shells without changing its edges", () => {
    const ring = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0], [-2, 0], [-2, -2], [0, -2], [0, 0]];
    const original = structuredClone(ring);
    const geometry = parseArcgisBasinGeometry([ring]);
    expect(geometry.type).toBe("MultiPolygon");
    const contains = prepareBasinContainment(geometry);
    expect(contains([1, 1])).toBe(true);
    expect(contains([-1, -1])).toBe(true);
    expect(contains([0, 0])).toBe(false);
    expect(contains([-1, 1])).toBe(false);
    expect(validateBasinGeometry(JSON.parse(JSON.stringify(geometry)))).toEqual(geometry);
    expect(ring).toEqual(original);
    expect(() => validateBasinGeometry({ type: "Polygon", coordinates: [ring] })).toThrow();
  });

  it("accepts vertex-touching shells and holes, including holes whose every vertex touches a shell", () => {
    const shell = [[0, 1], [1, 0], [3, 0], [4, 1], [3, 3], [1, 3], [0, 1]];
    const hole = [[0, 1], [3, 0], [3, 3], [0, 1]];
    for (const scale of [1, Number.MIN_VALUE]) {
      const rings = [shell, hole].map(ring => ring.map(([x, y]) => [x * scale, y * scale]));
      const geometry = parseArcgisBasinGeometry(rings);
      expect(geometry.type).toBe("Polygon");
      expect(geometry.coordinates).toHaveLength(2);
      expect(validateBasinGeometry(geometry)).toEqual(geometry);
    }
    const touching = parseArcgisBasinGeometry([square(), square(4, 4)]);
    expect(touching.type).toBe("MultiPolygon");
    expect(coordinateInPolygon([4, 4], touching)).toBe(false);
  });

  it("rejects rings crossing at explicit shared vertices, not just between vertices", () => {
    const shell = [[0, 0], [4, 0], [4, 1], [4, 3], [4, 4], [0, 4], [0, 3], [0, 1], [0, 0]];
    const crossing = [[-1, 1], [0, 1], [4, 1], [5, 1], [5, 3], [4, 3], [0, 3], [-1, 3], [-1, 1]];
    expect(() => parseArcgisBasinGeometry([shell, crossing])).toThrow(PwfdfGeometryError);
  });

  it("keeps containment preparation private to its snapshot instead of caching mutable geometry", () => {
    const geometry = parseArcgisBasinGeometry([square()]);
    const contains = prepareBasinContainment(geometry);
    geometry.coordinates.splice(0);
    expect(contains([1, 1])).toBe(true);
    expect(contains([0, 0])).toBe(false);
    expect(contains([NaN, 1])).toBe(false);
  });

  it("agrees with an independent integer-triangle oracle across underflow, translation and reversal", () => {
    const vertices = [[0, 0], [8, 6], [4, 4]];
    for (const base of [0, 1024, 2 ** 50]) for (const power of [-48, -500, -520, -530, -1070]) {
      const scale = 2 ** power;
      const ring = [...vertices, vertices[0]].map(([x, y]) => [(base + x) * scale, (base + y) * scale] as [number, number]);
      for (const [x, y] of [[0, 0], [8, 6], [4, 3], [4, 4], [5, 4], [5, 5], [3, 2], [-1, 0], [9, 7]]) {
        const sides = vertices.map(([ax, ay], i) => {
          const [bx, by] = vertices[(i + 1) % 3];
          const determinant = BigInt(bx - ax) * BigInt(y - ay) - BigInt(by - ay) * BigInt(x - ax);
          return determinant > BigInt(0) ? 1 : determinant < BigInt(0) ? -1 : 0;
        });
        const within = sides.every(side => side >= 0) || sides.every(side => side <= 0);
        const expected = within ? sides.includes(0) ? 0 : 1 : -1;
        const point: [number, number] = [(base + x) * scale, (base + y) * scale];
        expect(classifyRing(point, ring)).toBe(expected);
        expect(classifyRing(point, [...ring].reverse())).toBe(expected);
      }
    }
  });
});
