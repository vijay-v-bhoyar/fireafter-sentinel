import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mapStreamResponse } from "./map-stream-response";
import { fetchMapFeatures } from "./map-feature-client";
import { MAP_LAYERS, MAP_STREAM_BYTES, MAP_STREAM_ERROR, MAP_STREAM_TYPE, MAP_CAPACITY_CODE, MapCapacityError, MapStreamCollector, type MapFeaturesResponse } from "./map-stream-contract";

const empty = () => ({ type: "FeatureCollection", features: [] });
function fixture(): MapFeaturesResponse {
  return { incidentId: "county", county: empty(), roads: { ...empty(), geometryVersion: "current", sourceFeatureCount: 1,
    features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[-120, 33], [-119, 34]] }, properties: { id: "r", name: "Cañón 水" } }] },
  hydrography: { ...empty(), warning: "No provider coverage" }, pwfdfBasins: empty(), assets: empty(), recommendations: empty() };
}
const signal = () => new AbortController().signal;
const read = (response: Response, caller = signal()) => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response)); return fetchMapFeatures("county", caller); };
async function records() { return (await mapStreamResponse(fixture()).text()).trimEnd().split("\n").map(line => JSON.parse(line)); }
const wire = (rows: unknown[]) => new Response(rows.map(row => JSON.stringify(row)).join("\n") + "\n", { headers: { "Content-Type": MAP_STREAM_TYPE } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("rejects an oversized full map before committing success headers", () => {
  const data = fixture(), feature = { type: "Feature", geometry: { type: "Point", coordinates: [-119, 34] }, properties: { text: "x".repeat(1024 * 1024) } };
  data.assets.features = Array.from({ length: 65 }, () => feature);
  expect(() => mapStreamResponse(data)).toThrow(MapCapacityError);
});
it.each([503, 500])("only treats a known capacity header at 503 as actionable; status=%s", async status => {
  const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { status, headers: { "X-FireAfter-Map-Error": MAP_CAPACITY_CODE } });
  // Check the public error without reading or exposing the provider body.
  if (status === 503) await expect(read(response)).rejects.toBeInstanceOf(MapCapacityError);
  else await expect(read(response)).rejects.toThrow(MAP_STREAM_ERROR);
  expect(cancel).toHaveBeenCalled();
});

it("preserves every feature and metadata using the real stream writer and client", async () => {
  const data = fixture(), response = mapStreamResponse(data);
  expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie, Accept");
  expect(await read(response)).toEqual(data);
  expect(fetch).toHaveBeenCalledWith("/api/map/features?incidentId=county", expect.objectContaining({ credentials: "same-origin", cache: "no-store", headers: { Accept: MAP_STREAM_TYPE } }));
});
it("accepts UTF-8 characters split at every byte and genuinely empty layers", async () => {
  const bytes = new Uint8Array(await mapStreamResponse(fixture()).arrayBuffer()); let at = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (at === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(at, ++at)); } });
  expect(await read(new Response(stream, { headers: { "Content-Type": MAP_STREAM_TYPE } }))).toEqual(fixture());
});
it.each(["missing-final", "duplicate-header", "duplicate-batch", "wrong-start", "wrong-count", "wrong-incident", "extra-after-end", "unknown-layer", "skip-layer", "unknown-metadata", "wrong-version"])("rejects %s without returning a partial map", async kind => {
  const rows = await records();
  if (kind === "missing-final") rows.pop();
  if (kind === "duplicate-header") rows.splice(1, 0, rows[0]);
  if (kind === "duplicate-batch") rows.splice(2, 0, rows[1]);
  if (kind === "wrong-start") rows[1].start = 1;
  if (kind === "wrong-count") rows.at(-1).counts.roads = 2;
  if (kind === "wrong-incident") rows[0].incidentId = "other";
  if (kind === "extra-after-end") rows.push(rows.at(-1));
  if (kind === "unknown-layer") rows[1].layer = "other";
  if (kind === "skip-layer") rows[0].layers.county.count = 1;
  if (kind === "unknown-metadata") rows[0].layers.roads.metadata.features = [];
  if (kind === "wrong-version") rows[0].version = 2;
  await expect(read(wire(rows))).rejects.toThrow(MAP_STREAM_ERROR);
});
it("rejects a late transport error and cancels the source", async () => {
  const [header, batch] = await records(); let at = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (at++ === 0) controller.enqueue(new TextEncoder().encode(JSON.stringify(header) + "\n" + JSON.stringify(batch) + "\n"));
    else controller.error(new Error("private diagnostics"));
  } });
  await expect(read(new Response(body, { headers: { "Content-Type": MAP_STREAM_TYPE } }))).rejects.toThrow(MAP_STREAM_ERROR);
});
it("does not treat a complete footer as success before EOF", async () => {
  const text = await mapStreamResponse(fixture()).text(), cancel = vi.fn(), controller = new AbortController();
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); }, cancel }), { headers: { "Content-Type": MAP_STREAM_TYPE } });
  const result = read(response, controller.signal);
  await vi.waitFor(() => expect(response.body!.locked).toBe(true)); controller.abort();
  await expect(result).rejects.toThrow(MAP_STREAM_ERROR); expect(cancel).toHaveBeenCalled();
});
it("enforces its whole-body deadline even when the body stops producing data", async () => {
  const controller = new AbortController(); vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": MAP_STREAM_TYPE } });
  const result = read(response);
  await vi.waitFor(() => expect(response.body!.locked).toBe(true)); controller.abort(); await expect(result).rejects.toThrow(MAP_STREAM_ERROR);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(60_000); expect(cancel).toHaveBeenCalled();
});
it("cancels the server generator without producing a complete footer", async () => {
  const controller = new AbortController(), response = mapStreamResponse(fixture(), controller.signal), reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false); controller.abort();
  await expect(reader.read()).rejects.toThrow(MAP_STREAM_ERROR);
});
it("keeps the 64-MiB cumulative client limit even when a stream has no newline", async () => {
  const cancel = vi.fn(), yieldSpy = vi.spyOn(globalThis, "setTimeout"); let sent = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { sent += 1024 * 1024; c.enqueue(new Uint8Array(1024 * 1024).fill(32)); }, cancel });
  await expect(read(new Response(body, { headers: { "Content-Type": MAP_STREAM_TYPE } }))).rejects.toThrow(MAP_STREAM_ERROR);
  expect(sent).toBeLessThanOrEqual(MAP_STREAM_BYTES + 2 * 1024 * 1024); expect(cancel).toHaveBeenCalled();
  expect(yieldSpy.mock.calls.some(call => call[1] === 0)).toBe(true);
});
it("uses a single bounded legacy response during a rolling deployment", async () => {
  expect(await read(Response.json(fixture()))).toEqual(fixture()); expect(fetch).toHaveBeenCalledTimes(1);
  await expect(read(Response.json({ ...fixture(), incidentId: "other" }))).rejects.toThrow(MAP_STREAM_ERROR);
});
it.each(["text/html", "application/octet-stream"])("rejects unexpected content type %s", async type => {
  await expect(read(new Response("PRIVATE", { headers: { "Content-Type": type } }))).rejects.toThrow(MAP_STREAM_ERROR);
});
it("does not request data after the caller has already canceled", async () => {
  const controller = new AbortController(); controller.abort(); await expect(read(Response.json(fixture()), controller.signal)).rejects.toThrow(MAP_STREAM_ERROR);
  expect(fetch).not.toHaveBeenCalled();
});
it("retains batch order across layers and refuses a return to an earlier layer", async () => {
  const data = fixture(); data.hydrography = { ...data.roads, warning: undefined }; const rows = (await mapStreamResponse(data).text()).trimEnd().split("\n").map(row => JSON.parse(row));
  [rows[1], rows[2]] = [rows[2], rows[1]]; await expect(read(wire(rows))).rejects.toThrow(MAP_STREAM_ERROR);
});
it("yields while parsing already-buffered batches instead of draining them in one task", async () => {
  const data = fixture(); data.roads.features = Array.from({ length: 8000 }, () => fixture().roads.features[0]);
  const yieldSpy = vi.spyOn(globalThis, "setTimeout"), result = await read(mapStreamResponse(data));
  expect(result.roads.features).toHaveLength(8000); expect(yieldSpy.mock.calls.some(call => call[1] === 0)).toBe(true);
});
it("requires explicit completion even for a header with six empty layers", async () => {
  const collector = new MapStreamCollector("county"), rows = await records(); collector.accept(rows[0]); expect(() => collector.finish()).toThrow(MAP_STREAM_ERROR);
});
it.runIf(process.env.FIREAFTER_SAVED_MAP_FIXTURE === "true")("round-trips every captured Monterey feature and vertex through the real wire protocol", async () => {
  const captured = JSON.parse(gunzipSync(readFileSync("output/verification/monterey-public-lines-exact-county.json.gz")).toString());
  const data = fixture();
  for (const [layer, source] of [["roads", "roads"], ["hydrography", "hydro"]] as const) {
    data[layer] = { type: "FeatureCollection", features: captured[source].rawPayload.features.flatMap((f: { id: string; paths: number[][][] }) =>
      f.paths.map((coordinates, partIndex) => ({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: { id: f.id, partIndex } }))) };
  }
  const expected = createHash("sha256"); for (const layer of MAP_LAYERS) for (const feature of data[layer].features) expected.update(JSON.stringify(feature));
  const result = await read(mapStreamResponse(data)), actual = createHash("sha256"); let parts = 0, vertices = 0;
  for (const layer of MAP_LAYERS) for (const feature of result[layer].features) { actual.update(JSON.stringify(feature)); parts++; vertices += (feature.geometry!.coordinates as unknown[]).length; }
  expect(actual.digest("hex")).toBe(expected.digest("hex")); expect({ parts, vertices }).toEqual({ parts: 76273, vertices: 1115862 });
}, 30000);
