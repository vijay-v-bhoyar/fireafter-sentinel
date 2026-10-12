export const MAP_STREAM_TYPE = "application/x-ndjson";
export const MAP_STREAM_VERSION = 1;
export const MAP_STREAM_BYTES = 64 * 1024 * 1024;
export const MAP_STREAM_BATCH_BYTES = 64 * 1024;
export const MAP_STREAM_ERROR = "The complete map could not be verified. Retry loading the map; no partial response was accepted.";
export const MAP_CAPACITY_CODE = "MAP_CAPACITY_UNAVAILABLE";
export const MAP_CAPACITY_MESSAGE = "The complete county map exceeds the current delivery limit. Use the Action Queue while an operator checks map capacity. Retrying unchanged data will not resolve this limit.";
export class MapCapacityError extends Error {
  constructor() { super(MAP_CAPACITY_MESSAGE); }
}
export const MAP_LAYERS = ["county", "roads", "hydrography", "pwfdfBasins", "assets", "recommendations"] as const;
export type MapLayer = typeof MAP_LAYERS[number];
export type MapFeature = { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown>; type?: string };
export type MapFeatureCollection = { features: MapFeature[]; warning?: string; type?: string; geometryVersion?: string | null; sourceFeatureCount?: number };
export type MapFeaturesResponse = { incidentId: string } & Record<MapLayer, MapFeatureCollection>;
type LayerHeader = { count: number; metadata: Omit<MapFeatureCollection, "features"> };
export type MapStreamHeader = { kind: "header"; version: 1; incidentId: string; layers: Record<MapLayer, LayerHeader> };
export type MapStreamBatch = { kind: "features"; layer: MapLayer; start: number; features: MapFeature[] };
export type MapStreamEnd = { kind: "complete"; counts: Record<MapLayer, number> };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
export const mapStreamFailure = () => new Error(MAP_STREAM_ERROR);

/** Transport completeness only. Geometry interpretation stays in the existing layer validators. */
export class MapStreamCollector {
  private result?: MapFeaturesResponse;
  private counts?: Record<MapLayer, number>;
  private ended = false;
  private layerIndex = 0;
  constructor(private readonly incidentId: string) {}
  accept(value: unknown) {
    if (!object(value) || this.ended) throw mapStreamFailure();
    if (!this.result) {
      if (!exact(value, ["kind", "version", "incidentId", "layers"]) || value.kind !== "header" || value.version !== MAP_STREAM_VERSION ||
        value.incidentId !== this.incidentId || !object(value.layers) || !exact(value.layers, MAP_LAYERS)) throw mapStreamFailure();
      const result = { incidentId: this.incidentId } as MapFeaturesResponse, counts = {} as Record<MapLayer, number>;
      for (const layer of MAP_LAYERS) {
        const header = value.layers[layer];
        if (!object(header) || !exact(header, ["count", "metadata"]) || !count(header.count) || !object(header.metadata)) throw mapStreamFailure();
        const metadata = header.metadata;
        if (Object.keys(metadata).some(key => !["type", "warning", "geometryVersion", "sourceFeatureCount"].includes(key)) ||
          (metadata.type !== undefined && metadata.type !== "FeatureCollection") ||
          (metadata.warning !== undefined && typeof metadata.warning !== "string") ||
          (metadata.geometryVersion !== undefined && metadata.geometryVersion !== null && typeof metadata.geometryVersion !== "string") ||
          (metadata.sourceFeatureCount !== undefined && !count(metadata.sourceFeatureCount))) throw mapStreamFailure();
        result[layer] = { ...metadata, features: [] }; counts[layer] = header.count;
      }
      this.result = result; this.counts = counts; return;
    }
    if (value.kind === "complete") {
      if (!exact(value, ["kind", "counts"]) || !object(value.counts) || !exact(value.counts, MAP_LAYERS)) throw mapStreamFailure();
      const counts = value.counts;
      if (MAP_LAYERS.some(layer => counts[layer] !== this.counts![layer] || this.result![layer].features.length !== this.counts![layer])) throw mapStreamFailure();
      this.ended = true; return;
    }
    if (!exact(value, ["kind", "layer", "start", "features"]) || value.kind !== "features" || !MAP_LAYERS.includes(value.layer as MapLayer) ||
      !Array.isArray(value.features) || !value.features.length || value.features.length > 256) throw mapStreamFailure();
    const layer = value.layer as MapLayer, index = MAP_LAYERS.indexOf(layer), target = this.result[layer].features;
    if (index < this.layerIndex || MAP_LAYERS.slice(this.layerIndex, index).some(key => this.result![key].features.length !== this.counts![key]) ||
      value.start !== target.length || target.length + value.features.length > this.counts![layer] ||
      value.features.some(feature => !object(feature) || (feature.geometry !== undefined && !object(feature.geometry)) ||
        (feature.properties !== undefined && !object(feature.properties)))) throw mapStreamFailure();
    this.layerIndex = index;
    target.push(...value.features);
  }
  finish() {
    if (!this.ended || !this.result) throw mapStreamFailure();
    return this.result;
  }
}
