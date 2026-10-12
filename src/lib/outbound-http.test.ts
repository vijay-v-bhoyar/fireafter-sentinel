import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createResponseBudget, fetchBoundedResponse } from "./bounded-response";

// Real loopback transport and installed SDK; the server data is explicitly test-only.
let server: Server;
let origin: string;
let stalledConnectionsClosed = 0;
const compressedText = "x".repeat(4096);
const compressedBytes = gzipSync(compressedText);
const wrapper: typeof fetch = (input, init) => fetchBoundedResponse(input, init, createResponseBudget(1024, 150));
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/stall") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      response.on("close", () => { stalledConnectionsClosed++; });
    } else if (path === "/compressed") {
      response.writeHead(200, { "content-encoding": "gzip", "content-length": compressedBytes.length });
      response.end(compressedBytes);
    } else if (path === "/chunked") {
      response.writeHead(200, { "transfer-encoding": "chunked" });
      response.write("x".repeat(600)); response.end("y".repeat(600));
    } else if (request.method === "HEAD") {
      response.writeHead(200, { "content-range": "*/123", "content-length": "1000000" }); response.end();
    } else if (path === "/rest/v1/denied") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "42501", message: "Test-only access denial", details: null, hint: null }));
    } else if (path === "/rest/v1/empty") {
      response.writeHead(204); response.end();
    } else {
      response.writeHead(200, { "content-type": "application/json", "content-range": "0-0/1" });
      response.end('[{"id":"test-only-asset"}]');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback HTTP did not start");
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe("FA13-OUT3 actual HTTP and SDK response consumption", () => {
  it("bounds chunked and decoded compressed bodies", async () => {
    expect(compressedBytes.byteLength).toBeLessThan(1024);
    expect(Buffer.byteLength(compressedText)).toBeGreaterThan(1024);
    for (const path of ["/chunked", "/compressed"]) {
      // Isolate byte enforcement from the separate 150 ms stalled-body deadline oracle.
      await expect(fetchBoundedResponse(origin + path, undefined, createResponseBudget(1024, 5000)))
        .rejects.toMatchObject({ code: "too_large" });
    }
  });
  it("terminates an actual stalled body and closes its connection", async () => {
    const before = stalledConnectionsClosed;
    const start = performance.now();
    await expect(wrapper(origin + "/stall")).rejects.toMatchObject({ code: "timeout" });
    expect(performance.now() - start).toBeLessThan(2000);
    await vi.waitFor(() => expect(stalledConnectionsClosed).toBeGreaterThan(before));
  });
  it("installed Supabase SDK preserves rows, exact HEAD counts, 204 and permission errors", async () => {
    const sdk = createClient(origin, "test-only-public-key", { global: { fetch: wrapper }, auth: { persistSession: false, autoRefreshToken: false } });
    const rows = await sdk.from("assets").select("*", { count: "exact" });
    expect(rows.error).toBeNull(); expect(rows.data).toEqual([{ id: "test-only-asset" }]); expect(rows.count).toBe(1);
    const head = await sdk.from("assets").select("*", { count: "exact", head: true });
    expect(head.error).toBeNull(); expect(head.count).toBe(123); expect(head.data).toBeNull();
    const denied = await sdk.from("denied").select("*");
    expect(denied.status).toBe(403); expect(denied.error).toMatchObject({ code: "42501" });
    const empty = await sdk.from("empty").select("*");
    expect(empty.status).toBe(204); expect(empty.error).toBeNull();
  });
});
