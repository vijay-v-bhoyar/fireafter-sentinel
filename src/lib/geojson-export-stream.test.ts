import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createCompleteGeoJsonResponse, GEOJSON_EXPORT_LIMITS as limits, type GeoJsonExportSource, type GeoJsonExportPage } from "./geojson-export-stream";
import { dashboardBundleToGeoJson, recommendationsToGeoJson } from "./geojson-export";
import { queueBundle, queuePage } from "../test/queue-page-fixture";

const revision = "10000000-0000-4000-8000-000000000003";
function feature(position: number) {
  const item = queuePage(position - 1, 1, position).items[0];
  if (item.status !== "available") throw new Error("Invalid fixture");
  return recommendationsToGeoJson([{ ...item.recommendation, riskLevel: "Unknown" }])[0];
}
function page(start: number, total: number, count = Math.min(limits.pageRows, total - start)): GeoJsonExportPage {
  return { revision, state: "expired", start, totalStored: total,
    items: Array.from({ length: count }, (_, offset) => ({ position: start + offset + 1, status: "available", feature: feature(start + offset + 1) })) };
}
function source(total = 3, pages: GeoJsonExportPage[] = [page(0, total)]): GeoJsonExportSource {
  const bundle = queueBundle();
  const { features: _features, ...metadata } = dashboardBundleToGeoJson({ ...bundle, recommendations: [], generatedAt: "2026-10-08T20:00:00.000Z" });
  void _features;
  return { metadata, revision, state: "expired", totalStored: total, fileName: "fireafter-test-ca-action-queue.geojson",
    pages: async function* () { yield* pages; }, verifyComplete: vi.fn(async () => {}) };
}
afterEach(() => { vi.restoreAllMocks(); });

it("preserves every field, unicode and explicit withheld counts in valid GeoJSON", async () => {
  const first = page(0, 4, 2), second = page(2, 4, 2);
  first.items[1] = { position: 2, status: "withheld", reason: "outside-county" };
  second.items[1] = { position: 4, status: "withheld", reason: "unverified-geometry" };
  if (first.items[0].status === "available") first.items[0].feature.properties.assetName = "Cañón creek";
  const input = source(4, [first, second]);
  const response = await createCompleteGeoJsonResponse(input);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("content-type")).toContain("application/geo+json");
  expect(response.headers.get("content-length")).toBeNull();
  const body = await response.json();
  expect(body.features).toEqual([first.items[0], second.items[0]].flatMap(item => item.status === "available" ? [item.feature] : []));
  expect(body.fireafterExport).toMatchObject({ complete: true, totalStored: 4, scanned: 4, exported: 2,
    withheld: { "non-operational": 0, "outside-county": 1, "unverified-geometry": 1 } });
  expect(body.fireafter).toEqual(input.metadata.fireafter);
  expect(input.verifyComplete).toHaveBeenCalledTimes(1);
});

it("supports a verified empty inventory without requesting a fake empty page", async () => {
  const input = source(0, []), result = await (await createCompleteGeoJsonResponse(input)).json();
  expect(result.features).toEqual([]); expect(result.fireafterExport).toMatchObject({ scanned: 0, exported: 0, complete: true });
  expect(input.verifyComplete).toHaveBeenCalledTimes(1);
});

it.each(["row-count", "file-name", "metadata-size", "page-size", "initial-abort"])("rejects %s admission safely", async defect => {
  const input = source(1), caller = new AbortController();
  if (defect === "row-count") input.totalStored = limits.rows + 1;
  if (defect === "file-name") input.fileName = "county.geojson\r\nSet-Cookie: invalid";
  if (defect === "metadata-size") input.metadata.name = "x".repeat(limits.metadataBytes);
  if (defect === "page-size") {
    input.totalStored = limits.pageRows + 1;
    input.pages = async function* () { yield page(0, input.totalStored, input.totalStored); };
  }
  if (defect === "initial-abort") caller.abort();
  await expect(createCompleteGeoJsonResponse(input, caller.signal)).rejects.toMatchObject({
    code: defect === "initial-abort" ? "canceled" : defect === "metadata-size" ? "capacity" : "invalid",
  });
  expect(input.verifyComplete).not.toHaveBeenCalled();
});

it("hides synchronous reader initialization errors and cancels its signal", async () => {
  const input = source(1);
  let readSignal: AbortSignal | undefined;
  input.pages = signal => { readSignal = signal; throw new Error("PRIVATE_READER_DETAIL"); };
  await expect(createCompleteGeoJsonResponse(input)).rejects.toMatchObject({
    code: "unavailable",
    message: "The complete GeoJSON export could not be verified. Discard incomplete downloads and start again.",
  });
  expect(readSignal!.aborted).toBe(true);
  expect(input.verifyComplete).not.toHaveBeenCalled();
});

it("accounts for an entirely withheld inventory without inventing point features", async () => {
  const withheld = page(0, 3);
  withheld.items = ["non-operational", "unverified-geometry", "outside-county"].map((reason, index) => ({
    position: index + 1, status: "withheld", reason: reason as "non-operational" | "unverified-geometry" | "outside-county",
  }));
  const input = source(3, [withheld]), body = await (await createCompleteGeoJsonResponse(input)).json();
  expect(body.features).toEqual([]);
  expect(body.fireafterExport).toMatchObject({ complete: true, scanned: 3, exported: 0,
    withheld: { "non-operational": 1, "unverified-geometry": 1, "outside-county": 1 } });
  expect(input.verifyComplete).toHaveBeenCalledTimes(1);
});

it("bounds the cumulative duplicate-detection identity text across pages", async () => {
  const input = source(129, []), padding = "x".repeat(128 * 1024);
  input.pages = async function* () {
    for (let start = 0; start < input.totalStored; start += 16) {
      const next = page(start, input.totalStored, Math.min(16, input.totalStored - start));
      for (const item of next.items) if (item.status === "available") item.feature.properties.id += padding;
      yield next;
    }
  };
  const reader = (await createCompleteGeoJsonResponse(input)).body!.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Unexpected successful close");
      bytes += chunk.value.byteLength;
    }
  } catch (error) { expect(error).toMatchObject({ code: "capacity" }); }
  expect(bytes).toBeGreaterThan(limits.pageBytes);
  expect(bytes).toBeLessThan(limits.outputBytes);
  expect(input.verifyComplete).not.toHaveBeenCalled();
});

it.each(["missing-first", "wrong-revision", "wrong-state", "wrong-count", "wrong-start", "gap", "bad-point", "foreign", "risk", "duplicate", "page-bytes"])(
  "rejects %s before issuing response headers", async defect => {
    const first = page(0, 2), input = source(2, [first]);
    if (defect === "missing-first") input.pages = async function* () {};
    if (defect === "wrong-revision") first.revision = "10000000-0000-4000-8000-000000000004";
    if (defect === "wrong-state") first.state = "current";
    if (defect === "wrong-count") first.totalStored++;
    if (defect === "wrong-start") first.start++;
    if (defect === "gap") first.items[1].position++;
    const item = first.items[0]; if (item.status !== "available") throw new Error();
    if (defect === "bad-point") item.feature.geometry.coordinates[0] = NaN;
    if (defect === "foreign") item.feature.properties.incidentId = "another-county";
    if (defect === "risk") item.feature.properties.riskLevel = "High";
    if (defect === "duplicate") first.items[1] = { ...item, position: 2 };
    if (defect === "page-bytes") item.feature.properties.evidence = ["x".repeat(limits.pageBytes)];
    await expect(createCompleteGeoJsonResponse(input)).rejects.toMatchObject({ code: defect === "page-bytes" ? "capacity" : "invalid" });
    expect(input.verifyComplete).not.toHaveBeenCalled();
  },
);

it.each(["missing-tail", "duplicate-tail", "changed-revision", "reader-error", "final-fence"])("aborts rather than closes valid JSON after %s", async defect => {
  const first = page(0, 2, 1), second = page(1, 2, 1), input = source(2, [first, second]);
  if (defect === "missing-tail") input.pages = async function* () { yield first; };
  if (defect === "duplicate-tail" && first.items[0].status === "available") second.items[0] = { ...first.items[0], position: 2 };
  if (defect === "changed-revision") second.revision = "10000000-0000-4000-8000-000000000004";
  if (defect === "reader-error") input.pages = async function* () { yield first; throw new Error("PRIVATE_DATABASE_DETAIL"); };
  if (defect === "final-fence") input.verifyComplete = async () => { throw new Error("PRIVATE_AUTHORITY_DETAIL"); };
  const response = await createCompleteGeoJsonResponse(input), reader = response.body!.getReader();
  let partial = "";
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) throw new Error("Unexpected successful close"); partial += new TextDecoder().decode(chunk.value); }
  } catch (error) { expect(String(error)).toMatch(/complete GeoJSON export could not be verified/); }
  expect(partial).not.toContain('"complete":true');
  expect(partial).not.toMatch(/PRIVATE_DATABASE_DETAIL|PRIVATE_AUTHORITY_DETAIL/);
  expect(() => JSON.parse(partial)).toThrow();
});

it("does not fetch later pages until consumption, and cancels the reader on disconnect", async () => {
  const input = source(2), loaded: number[] = [];
  let closed = false, readSignal: AbortSignal | undefined;
  input.pages = async function* (signal) {
    readSignal = signal;
    try { loaded.push(1); yield page(0, 2, 1); loaded.push(2); yield page(1, 2, 1); } finally { closed = true; }
  };
  const response = await createCompleteGeoJsonResponse(input);
  expect(loaded).toEqual([1]);
  const reader = response.body!.getReader();
  await reader.read(); expect(loaded).toEqual([1]);
  await reader.cancel();
  expect(readSignal!.aborted).toBe(true);
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(loaded).toEqual([1]); expect(input.verifyComplete).not.toHaveBeenCalled();
});

it.each(["caller", "deadline"])("ends a pending page when %s cancellation occurs, even if its iterator ignores abort", async kind => {
  const input = source(1), caller = new AbortController(), returned = vi.fn(async () => ({ done: true as const, value: undefined }));
  input.pages = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: returned }) });
  if (kind === "deadline") {
    const native = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => native(ms === limits.durationMs ? 25 : ms));
  }
  const rejected = expect(createCompleteGeoJsonResponse(input, caller.signal)).rejects.toMatchObject({ code: kind === "caller" ? "canceled" : "deadline" });
  if (kind === "caller") caller.abort();
  await rejected; expect(returned).toHaveBeenCalledTimes(1);
});

it("cancels a stalled final check without writing a successful footer", async () => {
  const input = source(1), caller = new AbortController();
  let checking = false;
  input.verifyComplete = async () => { checking = true; await new Promise(() => {}); };
  const response = await createCompleteGeoJsonResponse(input, caller.signal);
  const result = expect(response.text()).rejects.toMatchObject({ code: "canceled" });
  await vi.waitFor(() => expect(checking).toBe(true));
  caller.abort(); await result;
});

it("enforces the real total transfer limit with bounded chunks and no valid partial file", async () => {
  const input = source(20000, []), padding = "x".repeat(30000);
  let generated = 0;
  input.pages = async function* () {
    for (let start = 0; start < input.totalStored; start += 100) {
      const next = page(start, input.totalStored, Math.min(100, input.totalStored - start));
      for (const item of next.items) if (item.status === "available") item.feature.properties.evidence = [padding];
      generated += next.items.length; yield next;
    }
  };
  const response = await createCompleteGeoJsonResponse(input), reader = response.body!.getReader();
  let received = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Unexpected successful close");
      expect(chunk.value.byteLength).toBeLessThanOrEqual(limits.chunkBytes);
      received += chunk.value.byteLength;
    }
  } catch (error) { expect(error).toMatchObject({ code: "capacity" }); }
  expect(received).toBeGreaterThan(limits.outputBytes - limits.pageBytes);
  expect(received).toBeLessThanOrEqual(limits.outputBytes);
  expect(generated).toBeLessThan(input.totalStored);
  expect(input.verifyComplete).not.toHaveBeenCalled();
}, 30000);

it("streams all 91511 synthetic records through native HTTP without whole-file accumulation", async () => {
  const total = 91511, input = source(total, []), expected = createHash("sha256"), actual = createHash("sha256");
  let pageCount = 0, maxPageBytes = 0, generated = 0;
  const padding = "Evidence retained unchanged. ".repeat(50);
  input.pages = async function* () {
    for (let start = 0; start < total; start += limits.pageRows) {
      const next = page(start, total);
      for (const item of next.items) if (item.status === "available") {
        item.feature.properties.evidence = [padding];
        expected.update(JSON.stringify(item.feature)); generated++;
      }
      maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(next)));
      pageCount++; yield next;
    }
  };
  const errors: unknown[] = [];
  const server = createServer(async (_request, outgoing) => {
    try {
      const response = await createCompleteGeoJsonResponse(input);
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
      body.on("error", error => { errors.push(error); outgoing.destroy(); });
      outgoing.on("close", () => { if (!outgoing.writableEnded) body.destroy(); });
      body.pipe(outgoing);
    } catch (error) { errors.push(error); outgoing.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    const response = await fetch(`http://127.0.0.1:${address.port}/export`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let tail = "", counted = 0, bytes = 0, footer = "";
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; tail += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = tail.indexOf("\n")) >= 0) {
        const line = tail.slice(0, newline); tail = tail.slice(newline + 1);
        if (line.startsWith('{"type":"FeatureCollection"')) continue;
        const record = JSON.parse(line.replace(/^,/, ""));
        expect(record.properties.id).toBe(`rec-${counted}`);
        actual.update(JSON.stringify(record)); counted++;
      }
      expect(tail.length).toBeLessThan(limits.chunkBytes + 8192);
    }
    footer = tail + decoder.decode();
    const receipt = JSON.parse(footer.slice('],"fireafterExport":'.length, -1));
    expect(receipt).toMatchObject({ totalStored: total, scanned: total, exported: total, complete: true });
    expect(counted).toBe(total); expect(generated).toBe(total); expect(pageCount).toBe(Math.ceil(total / limits.pageRows));
    expect(maxPageBytes).toBeLessThan(limits.pageBytes);
    expect(bytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(bytes).toBeLessThan(limits.outputBytes);
    expect(actual.digest("hex")).toBe(expected.digest("hex"));
    expect(errors).toEqual([]); expect(input.verifyComplete).toHaveBeenCalledTimes(1);
    console.info("GeoJSON synthetic streaming receipt", { records: counted, pages: pageCount, outputBytes: bytes, maxPageBytes });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60000);
