import "server-only";
import { MAP_LAYERS, MAP_STREAM_BATCH_BYTES, MAP_STREAM_BYTES, MAP_STREAM_TYPE, MapCapacityError, MapStreamCollector, mapStreamFailure,
  type MapFeaturesResponse, type MapLayer, type MapStreamHeader } from "./map-stream-contract";

/** Bounded serialization after the existing reader has authorized and projected all layers. */
export function mapStreamResponse(value: MapFeaturesResponse, signal?: AbortSignal) {
  const header: MapStreamHeader = { kind: "header", version: 1, incidentId: value.incidentId, layers: {} as MapStreamHeader["layers"] };
  for (const layer of MAP_LAYERS) {
    const { features, ...metadata } = value[layer];
    header.layers[layer] = { count: features.length, metadata };
  }
  // Check the small metadata before committing success headers.
  new MapStreamCollector(value.incidentId).accept(header);
  const encoder = new TextEncoder();
  function* records() {
    yield JSON.stringify(header) + "\n";
    for (const layer of MAP_LAYERS) {
      let start = 0, parts: string[] = [], size = 0;
      const batch = () => `{"kind":"features","layer":${JSON.stringify(layer)},"start":${start},"features":[${parts.join(",")}]}\n`;
      for (const feature of value[layer].features) {
        if (signal?.aborted) throw mapStreamFailure();
        const json = JSON.stringify(feature), bytes = encoder.encode(json).byteLength;
        if (parts.length && (size + bytes > MAP_STREAM_BATCH_BYTES || parts.length === 256)) {
          yield batch(); start += parts.length; parts = []; size = 0;
        }
        if (bytes > MAP_STREAM_BYTES) throw new MapCapacityError();
        parts.push(json); size += bytes;
      }
      if (parts.length) yield batch();
    }
    yield JSON.stringify({ kind: "complete", counts: Object.fromEntries(MAP_LAYERS.map(layer => [layer, header.layers[layer].count])) as Record<MapLayer, number> }) + "\n";
  }
  // All layers are already in memory. Check the exact wire encoding without
  // building one giant JSON string or sending a doomed successful response.
  let projectedBytes = 0;
  for (const record of records()) {
    projectedBytes += encoder.encode(record).byteLength;
    if (projectedBytes > MAP_STREAM_BYTES) throw new MapCapacityError();
  }
  const iterator = records(); let sent = 0, pending: Uint8Array | undefined, offset = 0;
  const stop = () => { iterator.return(); pending = undefined; };
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        if (signal?.aborted) throw mapStreamFailure();
        if (!pending) {
          const next = iterator.next();
          if (next.done) { stop(); controller.close(); return; }
          pending = encoder.encode(next.value); offset = 0; sent += pending.byteLength;
          if (sent > MAP_STREAM_BYTES) throw mapStreamFailure();
        }
        const end = Math.min(offset + MAP_STREAM_BATCH_BYTES, pending.byteLength);
        controller.enqueue(pending.subarray(offset, end)); offset = end;
        if (offset === pending.byteLength) pending = undefined;
      } catch { stop(); controller.error(mapStreamFailure()); }
    }, cancel: stop,
  }), { headers: { "Content-Type": `${MAP_STREAM_TYPE}; charset=utf-8`, "Cache-Control": "private, no-store", Vary: "Cookie, Accept" } });
}
