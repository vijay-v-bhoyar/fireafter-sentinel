import "server-only";
import { readSourceLineGeometry } from "./source-line-geometry";
import { pwfdfBasinsFromSnapshot } from "./pwfdf";
import { packSpatialSourcePayload, type SpatialBounds } from "./source-spatial-storage";
import type { SourceSnapshot } from "./types";

function boundsOfPaths(paths: number[][][]): SpatialBounds {
  const bounds: SpatialBounds = [180, 90, -180, -90];
  for (const path of paths) for (const [lon, lat] of path) {
    bounds[0] = Math.min(bounds[0], lon); bounds[1] = Math.min(bounds[1], lat);
    bounds[2] = Math.max(bounds[2], lon); bounds[3] = Math.max(bounds[3], lat);
  }
  return bounds;
}

/** Caller must first apply persisted-row provenance gates. Invalid layers retain their original evidence, not an empty spatial index. */
export function packValidatedSourceGeometryPayload(source: SourceSnapshot | null) {
  if (!source || !source.rawPayload || source.coverageStatus !== "available") return undefined;
  const payload = source.rawPayload;
  if (source.sourceKey === "tiger-roads" || source.sourceKey === "3dhp-flowlines") {
    const { features, warning } = readSourceLineGeometry(payload, source.sourceKey);
    if (warning || payload.inventoryComplete !== true || payload.featureCount !== features.length ||
      new Set(features.map(feature => JSON.stringify([feature.sourceUrl ?? null, feature.id]))).size !== features.length) return undefined;
    return packSpatialSourcePayload(payload, "features", features.map(feature => boundsOfPaths(feature.paths)));
  }
  if (source.sourceKey === "usgs-pwfdf") {
    const basins = pwfdfBasinsFromSnapshot(source);
    if (!basins.length) return undefined;
    return packSpatialSourcePayload(payload, "basins", basins.map(basin => boundsOfPaths(
      basin.geometry.type === "Polygon" ? basin.geometry.coordinates : basin.geometry.coordinates.flat())));
  }
  return undefined;
}
