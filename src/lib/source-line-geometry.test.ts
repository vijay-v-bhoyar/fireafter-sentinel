import { describe, expect, it } from "vitest";
import {
  hasCurrentCrossingGeometry, parseLinePaths, projectSourceLineGeometry,
  readSourceLineGeometry, SOURCE_LINE_GEOMETRY_VERSION, SOURCE_LINE_GEOMETRY_WARNING, SOURCE_LINE_UNAVAILABLE_WARNING,
} from "./source-line-geometry";
import type { SourceSnapshot } from "./types";

const paths = [[[-119.4, 34.2], [-119.3, 34.3]], [[-119.2, 34.4], [-119.1, 34.5]]];
const feature = { id: "road-1", sourceKey: "tiger-roads", sourceName: "TIGERweb", paths };
const payload = { geometryVersion: SOURCE_LINE_GEOMETRY_VERSION, features: [feature] };

describe("source line geometry contract", () => {
  it("does not prescribe blind retries for capacity-limited geometry", () => {
    const result = readSourceLineGeometry({ available: false, status: "error", reason: "limit_exceeded", inventoryComplete: false }, "3dhp-flowlines");
    expect(result.features).toEqual([]);
    expect(result.warning).toContain("capacity requirements");
    expect(result.warning).not.toContain("and retry");
  });
  it.each(["provider_error", "capacity_exceeded", "upstream_unavailable"])("distinguishes failed acquisition from malformed geometry: %s", reason => {
    expect(readSourceLineGeometry({ available: false, status: "error", reason, inventoryComplete: false }, "3dhp-flowlines"))
      .toEqual({ features: [], warning: SOURCE_LINE_UNAVAILABLE_WARNING });
  });

  it.each([
    { available: false, status: "error", reason: "" },
    { available: false, status: "error", reason: "provider_error", inventoryComplete: true },
    { available: false, status: "error", reason: "provider_error", features: [] },
    { available: false, status: "error", reason: "provider_error", geometryVersion: "legacy" },
    { ...payload, available: false },
    { ...payload, status: "error" },
    { ...payload, available: false, status: "error", reason: "provider_error" },
  ])("does not allow failure metadata to admit contradictory or malformed geometry: %j", input => {
    expect(readSourceLineGeometry(input, "tiger-roads")).toEqual({ features: [], warning: SOURCE_LINE_GEOMETRY_WARNING });
  });

  it("preserves the real provider failure across repeated projections without mutating stored evidence", () => {
    const source: SourceSnapshot = {
      id: "hydro", incidentId: "incident", sourceKey: "3dhp-flowlines", sourceName: "USGS 3DHP",
      fetchedAt: "2026-09-12T00:00:00Z", sourceUpdatedAt: "2026-09-12T00:00:00Z",
      status: "offline", stale: true, coverageStatus: "error", freshnessLabel: "Source error",
      detail: "The provider could not supply the inventory.", warnings: ["No replacement values were used."],
      rawPayload: { available: false, status: "error", reason: "provider_error" },
    };
    const original = structuredClone(source);
    const projected = projectSourceLineGeometry(source);
    expect(projected).toMatchObject({ status: "offline", coverageStatus: "error", stale: true, detail: source.detail });
    expect(projected.warnings).toEqual([...source.warnings!, SOURCE_LINE_UNAVAILABLE_WARNING]);
    expect(projectSourceLineGeometry(projected)).toEqual(projected);
    expect(source).toEqual(original);
    expect(projectSourceLineGeometry({ ...source, detail: " ", status: "online", stale: false, coverageStatus: "available" }))
      .toMatchObject({ status: "offline", stale: true, coverageStatus: "error", detail: SOURCE_LINE_UNAVAILABLE_WARNING });
  });
  it("retains every vertex and part without sharing mutable input coordinates", () => {
    const result = parseLinePaths(paths)!;
    expect(result).toEqual(paths);
    result[0][0][0] = 0;
    expect(paths[0][0][0]).toBe(-119.4);
    const long = [Array.from({ length: 500 }, (_, i) => [-119 + i / 10000, 34])];
    expect(parseLinePaths(long)).toEqual(long);
  });

  it.each([
    undefined, [], [[]], [[[-119, 34]]],
    [[[-119, 34], [null, 34], [-118, 34]]],
    [[[-119, 34], ["-118", 34]]],
    [[[-119, 34], [Infinity, 34]]],
    [[[-119, 34], [-118, 91]]],
    [[[179, 34], [-179, 34]]],
  ])("rejects the complete invalid path instead of deleting vertices: %j", (value) => {
    expect(parseLinePaths(value)).toBeNull();
  });

  it("accepts explicitly split dateline parts", () => {
    const split = [[[179, 34], [180, 34]], [[-180, 34], [-179, 34]]];
    expect(parseLinePaths(split)).toEqual(split);
  });

  it("requires the versioned contract and rejects an entire mixed-validity collection", () => {
    expect(readSourceLineGeometry(payload, "tiger-roads").features).toEqual([feature]);
    for (const invalid of [
      { features: [feature] },
      { ...payload, geometryVersion: "legacy" },
      { ...payload, features: [feature, { ...feature, paths: [[]] }] },
      { ...payload, features: [{ ...feature, coordinates: paths.flat() }] },
      { ...payload, features: [{ ...feature, sourceKey: "3dhp-flowlines" }] },
    ]) {
      expect(readSourceLineGeometry(invalid, "tiger-roads")).toEqual({ features: [], warning: SOURCE_LINE_GEOMETRY_WARNING });
    }
  });

  it("projects legacy geometry as unavailable without changing stored evidence", () => {
    const source: SourceSnapshot = {
      id: "roads", incidentId: "incident", sourceKey: "tiger-roads", sourceName: "TIGERweb",
      fetchedAt: "2026-09-12T00:00:00Z", sourceUpdatedAt: "2026-09-12T00:00:00Z",
      status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Checked", detail: "Loaded",
      rawPayload: { features: [{ coordinates: paths.flat() }] },
    };
    const original = structuredClone(source);
    const projected = projectSourceLineGeometry(source);
    expect(projected).toMatchObject({ status: "delayed", stale: true, coverageStatus: "not_available", warnings: [SOURCE_LINE_GEOMETRY_WARNING] });
    expect(projectSourceLineGeometry(projected).warnings).toEqual([SOURCE_LINE_GEOMETRY_WARNING]);
    expect(source).toEqual(original);
  });

  it("requires a geometry version for inferred assets but preserves uploads and direct source assets", () => {
    const inferred = { localOrUploaded: false, origin: "inferred" as const, type: "Inferred Crossing" as const, metrics: {} };
    expect(hasCurrentCrossingGeometry(inferred)).toBe(false);
    expect(hasCurrentCrossingGeometry({ ...inferred, metrics: { inferenceGeometryVersion: SOURCE_LINE_GEOMETRY_VERSION } })).toBe(true);
    expect(hasCurrentCrossingGeometry({ ...inferred, localOrUploaded: true, origin: "uploaded" })).toBe(true);
    expect(hasCurrentCrossingGeometry({ ...inferred, origin: "source", type: "Bridge" })).toBe(true);
  });
});
