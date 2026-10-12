import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { drawMapLineCollection, type MapBounds, type MapLineCollection, type MapLineState } from "./map-line-renderer";

const bounds: MapBounds = [-120, 33, -118, 35];
const collection = (paths: unknown[][]): MapLineCollection => ({ features: paths.map(coordinates => ({ geometry: { type: "LineString", coordinates } })) });
function harness(data: MapLineCollection, box = bounds) {
  const frames = new Map<number, FrameRequestCallback>(); let id = 0, time = 0;
  const pen = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), clearRect: vi.fn() };
  const states: MapLineState[] = [];
  const stop = drawMapLineCollection({ collection: data, bounds: box, width: 100, height: 100, pen, onState: state => states.push(state),
    schedule: step => { frames.set(++id, step); return id; }, cancel: key => { frames.delete(key); }, now: () => time });
  const next = () => { const tasks = [...frames.values()]; frames.clear(); time += 16; tasks.forEach(step => step(time)); };
  const finish = () => { for (let count = 0; frames.size && count < 1000; count++) next(); expect(frames.size).toBe(0); };
  return { pen, states, frames, stop, next, finish };
}
it("preserves every coordinate and part without clamping, connecting or modifying source arrays", () => {
  const data = collection([[[-121, 32], [-120, 33], [-118, 35]], [[-119, 34], [-117, 36]]]);
  const before = JSON.stringify(data), h = harness(data); h.finish();
  expect(h.pen.moveTo.mock.calls).toEqual([[-50, 150], [50, 50]]);
  expect(h.pen.lineTo.mock.calls).toEqual([[0, 100], [100, 0], [150, -50]]);
  expect(h.pen.beginPath).toHaveBeenCalledTimes(2); expect(h.pen.stroke).toHaveBeenCalledTimes(2);
  expect(h.states.at(-1)).toEqual({ status: "ready", parts: 2, vertices: 5 }); expect(JSON.stringify(data)).toBe(before);
});
it("yields within a long path and completes every vertex with one final stroke", () => {
  const h = harness(collection([Array.from({ length: 10000 }, (_, i) => [-119 + i / 100000, 34])]));
  h.next(); expect(h.pen.moveTo.mock.calls.length + h.pen.lineTo.mock.calls.length).toBe(4096);
  expect(h.pen.stroke).not.toHaveBeenCalled(); expect(h.states.at(-1)?.status).toBe("drawing");
  h.finish(); expect(h.pen.lineTo).toHaveBeenCalledTimes(9999); expect(h.pen.stroke).toHaveBeenCalledOnce();
  expect(h.states.at(-1)).toMatchObject({ status: "ready", vertices: 10000 });
});
it("cancels active work and clears incomplete geometry", () => {
  const h = harness(collection([Array.from({ length: 10000 }, () => [-119, 34])]));
  h.next(); h.stop(); h.finish(); expect(h.pen.lineTo).toHaveBeenCalledTimes(4095);
  expect(h.pen.clearRect).toHaveBeenCalledTimes(2); expect(h.states.some(state => state.status === "ready")).toBe(false);
});
it("yields at the cooperative time boundary before reaching the vertex ceiling", () => {
  let count = 0; const frames: FrameRequestCallback[] = [];
  const pen = { beginPath() {}, moveTo() { count++; }, lineTo() { count++; }, stroke() {}, clearRect() {} };
  drawMapLineCollection({ collection: collection([Array.from({ length: 10000 }, () => [-119, 34])]), bounds,
    width: 100, height: 100, pen, onState: () => {}, now: () => count / 10,
    schedule: next => { frames.push(next); return frames.length; }, cancel: () => {} });
  frames.shift()!(0); expect(count).toBe(64); expect(frames).toHaveLength(1);
});
it.each([null, [0], [null, 34], [NaN, 34], [181, 34], [-119, 91], ["-119", 34]].map(point => [point]))("rejects an invalid late vertex without showing a partial layer: %j", point => {
  const h = harness(collection([[[-120, 33], [-119, 34]], [[-119, 34], point as never]])); h.finish();
  expect(h.states.at(-1)).toEqual({ status: "unavailable", parts: 0, vertices: 0 }); expect(h.pen.clearRect).toHaveBeenCalledTimes(2);
});
it("rejects a dateline jump instead of drawing across the county", () => {
  const h = harness(collection([[[179, 34], [-179, 34]]])); h.finish(); expect(h.states.at(-1)?.status).toBe("unavailable");
});
it.each([
  { features: [{ geometry: { type: "Point", coordinates: [0, 0] } }] },
  { features: [{ geometry: { type: "LineString", coordinates: [[0, 0]] } }] },
  { features: [], warning: "Unavailable provider geometry" },
])("rejects malformed or warned collections", data => {
  const h = harness(data); h.finish(); expect(h.states.at(-1)?.status).toBe("unavailable");
});
it.each([[0, 0, 0, 1], [-181, 0, 180, 1], [-120, 33, -118, Infinity]])("rejects invalid extents: %j", (...box) => {
  const h = harness(collection([]), box as MapBounds); h.finish(); expect(h.states.at(-1)?.status).toBe("unavailable");
});
it("verifies a genuinely empty collection", () => {
  const h = harness(collection([])); h.finish(); expect(h.states.at(-1)).toEqual({ status: "ready", parts: 0, vertices: 0 });
});
it("handles a failed canvas operation without accepting partially drawn geometry", () => {
  const h = harness(collection([[[-120, 33], [-119, 34]]])); h.pen.stroke.mockImplementation(() => { throw new Error(); });
  h.finish(); expect(h.states.at(-1)?.status).toBe("unavailable");
});
it.runIf(process.env.FIREAFTER_SAVED_MAP_FIXTURE === "true")("draws all captured Monterey road/hydro parts with independent coordinate hash parity", () => {
  const input = JSON.parse(gunzipSync(readFileSync("output/verification/monterey-public-lines-exact-county.json.gz")).toString());
  let parts = 0, vertices = 0;
  for (const name of ["roads", "hydro"]) {
    const paths = input[name].rawPayload.features.flatMap((feature: { paths: unknown[][] }) => feature.paths);
    const data = collection(paths), h = harness(data, input.location.bbox);
    const expected = createHash("sha256"), actual = createHash("sha256");
    const [west, south, east, north] = input.location.bbox;
    for (const path of paths) for (let i = 0; i < path.length; i++) {
      const [lon, lat] = path[i]; expected.update(JSON.stringify([i === 0 ? "move" : "line", (lon - west) / (east - west) * 100, (1 - (lat - south) / (north - south)) * 100]));
    }
    h.pen.moveTo.mockImplementation((x, y) => { actual.update(JSON.stringify(["move", x, y])); });
    h.pen.lineTo.mockImplementation((x, y) => { actual.update(JSON.stringify(["line", x, y])); });
    h.finish(); expect(actual.digest("hex")).toBe(expected.digest("hex")); expect(h.pen.stroke).toHaveBeenCalledTimes(paths.length);
    const result = h.states.at(-1)!; expect(result.status).toBe("ready"); parts += result.parts; vertices += result.vertices;
  }
  expect({ parts, vertices }).toEqual({ parts: 76273, vertices: 1115862 });
}, 30000);
