import type { Asset, SourceSnapshot } from "./types";

export const SOURCE_LINE_GEOMETRY_VERSION = "2026-09-12-multipart-v1";
export const SOURCE_LINE_GEOMETRY_WARNING = "Road/hydro geometry is legacy or invalid. Refresh source geometry before using the map or inferred crossings; disconnected parts cannot be reconstructed from flattened records.";
export const SOURCE_LINE_UNAVAILABLE_WARNING = "Road/hydro source retrieval did not complete. Review source status for recovery or capacity requirements; this source contributes no geometry or inferred crossings.";

export type SourceLineFeature = {
  id: string;
  name?: string;
  class?: string;
  paths: [number, number][][];
  sourceKey: string;
  sourceName: string;
  sourceUrl?: string;
};

export function parseLinePaths(value: unknown): [number, number][][] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const paths: [number, number][][] = [];
  for (const rawPath of value) {
    if (!Array.isArray(rawPath) || rawPath.length < 2) return null;
    const path: [number, number][] = [];
    for (const point of rawPath) {
      if (!Array.isArray(point) || point.length < 2) return null;
      const [lon, lat] = point;
      if (typeof lon !== "number" || typeof lat !== "number" ||
        !Number.isFinite(lon) || !Number.isFinite(lat) ||
        Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
      // Wrapped longitudes need explicit splitting, not a line across the world.
      if (path.length && Math.abs(lon - path[path.length - 1][0]) > 180) return null;
      path.push([lon, lat]);
    }
    paths.push(path);
  }
  return paths;
}

export function readSourceLineGeometry(payload: Record<string, unknown> | undefined, sourceKey: string) {
  const features: SourceLineFeature[] = [];
  const invalid = () => ({ features: [] as SourceLineFeature[], warning: SOURCE_LINE_GEOMETRY_WARNING });
  if (isFailedLineAcquisition(payload)) return { features, warning: SOURCE_LINE_UNAVAILABLE_WARNING };
  if (payload?.available === false || payload?.status === "error") return invalid();
  if (payload?.geometryVersion !== SOURCE_LINE_GEOMETRY_VERSION || !Array.isArray(payload.features)) return invalid();
  for (const raw of payload.features) {
    if (!raw || typeof raw !== "object") return invalid();
    const feature = raw as Record<string, unknown>;
    const paths = parseLinePaths(feature.paths);
    if (!paths || "coordinates" in feature || typeof feature.id !== "string" || !feature.id.trim() ||
      feature.sourceKey !== sourceKey || typeof feature.sourceName !== "string") return invalid();
    features.push({
      id: feature.id, paths, sourceKey, sourceName: feature.sourceName,
      name: typeof feature.name === "string" ? feature.name : undefined,
      class: typeof feature.class === "string" ? feature.class : undefined,
      sourceUrl: typeof feature.sourceUrl === "string" ? feature.sourceUrl : undefined,
    });
  }
  return { features, warning: undefined };
}

function isFailedLineAcquisition(payload: Record<string, unknown> | undefined) {
  return payload?.available === false && payload.status === "error" &&
    typeof payload.reason === "string" && Boolean(payload.reason.trim()) &&
    payload.inventoryComplete !== true &&
    !["geometryVersion", "features", "coordinates", "paths"].some(key => key in payload);
}

export function projectSourceLineGeometry(source: SourceSnapshot): SourceSnapshot {
  if (source.sourceKey !== "tiger-roads" && source.sourceKey !== "3dhp-flowlines") return source;
  const { warning } = readSourceLineGeometry(source.rawPayload, source.sourceKey);
  if (!warning) return source;
  if (warning === SOURCE_LINE_UNAVAILABLE_WARNING) return {
    ...source, coverageStatus: "error", stale: true, status: "offline",
    detail: source.detail.trim() ? source.detail : warning,
    warnings: [...new Set([...(source.warnings ?? []), warning])],
  };
  return {
    ...source, coverageStatus: "not_available", stale: true,
    status: source.status === "offline" ? "offline" : "delayed",
    detail: warning, warnings: [...new Set([...(source.warnings ?? []), warning])],
  };
}

export function hasCurrentCrossingGeometry(asset: Pick<Asset, "localOrUploaded" | "origin" | "type" | "sourceKey" | "metrics">) {
  const inferred = !asset.localOrUploaded && (asset.origin === "inferred" ||
    asset.type === "Inferred Crossing" || asset.sourceKey === "tiger-roads+3dhp-flowlines");
  return !inferred || asset.metrics?.inferenceGeometryVersion === SOURCE_LINE_GEOMETRY_VERSION;
}
