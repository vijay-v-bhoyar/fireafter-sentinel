import { isUploadedAsset } from "./asset-import-validation";
import type { Asset } from "./types";
import type { PreviousTerrain } from "./refresh-history";

// Terrain is reusable; weather and assessment bindings are not copied with it.
// Keep the original retrieval time and source evidence on every reused sample.
export function reuseTerrainSamples<T extends PreviousTerrain>(assets: Asset[], previous: T[], now = Date.now()): Asset[] {
  const byId = new Map(previous.filter(asset => !isUploadedAsset(asset)).map(asset => [asset.id, asset]));
  return assets.map(asset => {
    if (isUploadedAsset(asset) || asset.metrics?.slopeTerrain !== undefined) return asset;
    const old = byId.get(asset.id);
    const metrics = old?.metrics;
    const age = now - Date.parse(metrics?.elevationSampledAt ?? "");
    if (!old || old.sourceKey !== asset.sourceKey || old.coordinates[0] !== asset.coordinates[0] || old.coordinates[1] !== asset.coordinates[1] ||
      !Number.isFinite(age) || age < 0 || age > 24 * 3600_000 || !Number.isFinite(metrics?.slopeTerrain) ||
      metrics!.slopeTerrain! < 0 || metrics!.slopeTerrain! > 1 || !Number.isFinite(metrics?.elevationChangeMeters) ||
      metrics!.elevationChangeMeters! < 0 || metrics?.elevationSampleMeters?.length !== 2 ||
      !metrics.elevationSampleMeters.every(value => Number.isFinite(value) && value >= -12000 && value <= 10000)) return asset;
    const evidence = old.evidence?.filter(item => item.sourceKey === "usgs-epqs" && item.sourceName.startsWith("USGS"));
    if (!evidence?.length) return asset;
    return { ...asset, metrics: { ...asset.metrics, slopeTerrain: metrics.slopeTerrain,
      elevationChangeMeters: metrics.elevationChangeMeters, elevationSampleMeters: metrics.elevationSampleMeters,
      elevationSampledAt: metrics.elevationSampledAt },
    evidence: [...(asset.evidence ?? []), ...evidence.map(item => ({ ...item,
      summary: `${item.summary} Cached terrain samples retrieved ${metrics.elevationSampledAt}; not current weather evidence.` }))] };
  });
}
