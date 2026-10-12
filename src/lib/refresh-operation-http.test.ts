import { createServer, type Server } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fetchArcgisInventory } from "./arcgis-inventory";
import { createResponseBudget } from "./bounded-response";
import { fetchOperationResponse, withRefreshOperation } from "./refresh-operation";
import { getSupabaseAdminClient } from "./supabase";

let server: Server;
let origin: string;
let requests = 0;
let writes = 0;
let closed = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/arcgis") {
      res.end(JSON.stringify(url.searchParams.get("returnIdsOnly") === "true"
        ? { objectIdFieldName: "FID", objectIds: [1] }
        : { features: [{ attributes: { FID: 1, NAME: "Test-only feature" } }] }));
    } else if (url.pathname === "/stall") {
      res.write("{");
      res.on("close", () => { closed++; });
    } else if (url.pathname === "/chunked") {
      res.write("x".repeat(300)); res.end("y".repeat(300));
    } else if (req.method === "HEAD") {
      res.setHeader("Content-Range", "*/1"); res.end();
    } else if (req.method === "POST") {
      req.resume();
      req.on("end", () => {
        writes++;
        res.end(url.pathname.endsWith("large_write") ? JSON.stringify({ value: "x".repeat(2048) }) : '{"ok":true}');
      });
    } else {
      res.setHeader("Content-Range", "0-0/1");
      res.end('[{"id":"test-only-row"}]');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned loopback server did not start");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  requests = 0; writes = 0;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", origin);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", origin);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-not-a-secret");
  vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "5000");
  vi.stubEnv("FIREAFTER_REFRESH_MAX_REQUESTS", "512");
  vi.stubEnv("FIREAFTER_REFRESH_MAX_BYTES", "67108864");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

// Only the ArcGIS test transport maps its fixed HTTPS identity to our owned HTTP server.
const inventory = () => fetchArcgisInventory("https://test.invalid/arcgis", [-120, 34, -119, 35], {
  outFields: "NAME",
  fetchImpl: (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://test.invalid") throw new Error("Unexpected test destination");
    return fetch(origin + "/arcgis" + url.search, init);
  },
});
const read = (path: string) => fetchOperationResponse(origin + path, undefined, createResponseBudget(8192, 5000));
// The test server has its own RPC schema, not the application's generated schema.
const sdk = () => getSupabaseAdminClient()! as SupabaseClient;

it("installed SDK reads, HEAD, RPC writes and complete ArcGIS acquisition share one scope", async () => {
  await withRefreshOperation("asset_import", async () => {
    const client = sdk();
    const rows = await client.from("assets").select("*", { count: "exact" }).retry(false);
    expect(rows.data).toEqual([{ id: "test-only-row" }]); expect(rows.count).toBe(1);
    const head = await client.from("assets").select("id", { count: "exact", head: true }).retry(false);
    expect(head.count).toBe(1); expect(head.error).toBeNull();
    const result = await client.rpc("test_write", { value: "test-only" }).retry(false);
    expect(result.data).toEqual({ ok: true }); expect(result.error).toBeNull();
    const acquired = await withRefreshOperation("refresh", inventory);
    expect(acquired.inventory).toMatchObject({ complete: true, expectedCount: 1, receivedCount: 1 });
  });
  expect(requests).toBe(6); expect(writes).toBe(1);
});

it("SDK and ArcGIS phases cannot each reset the request budget", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_MAX_REQUESTS", "3");
  await expect(withRefreshOperation("refresh", async () => {
    await sdk().from("assets").select("*").retry(false);
    await inventory();
  })).rejects.toMatchObject({ code: "refresh_requests" });
  expect(requests).toBe(3);
});

it("a received write with an oversized result is unconfirmed, never reported as rollback", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_MAX_BYTES", "1024");
  await expect(withRefreshOperation("asset_import", async () => {
    await sdk().rpc("large_write", { value: "test-only" }).retry(false);
  })).rejects.toMatchObject({ code: "refresh_bytes", message: expect.stringContaining("may have committed") });
  expect(writes).toBe(1); expect(requests).toBe(1);
});

it("two individually permitted chunked responses exceed the shared decoded-byte ceiling", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_MAX_BYTES", "1024");
  await expect(withRefreshOperation("refresh", async () => { await read("/chunked"); await read("/chunked"); }))
    .rejects.toMatchObject({ code: "refresh_bytes" });
  expect(requests).toBe(2);
});

it("operation deadline closes a real stalled HTTP connection", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "250");
  const before = closed;
  await expect(withRefreshOperation("refresh", () => read("/stall"))).rejects.toMatchObject({ code: "refresh_deadline" });
  await vi.waitFor(() => expect(closed).toBeGreaterThan(before));
});
