import { operationId, importReceipt } from "../test/import-operation-fixture";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProductionLoopbackDatabase } from "../test/sentinel-loopback-proxy";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const incidentId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000002";
const domainId = "inventory-deadline-incident";
const assetId = (index: number) => `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000003`;
const incident = {
  id: incidentId, organization_id: organizationId, county: "Ventura County", state: "CA",
  title: "Test-only inventory", status: "Storm Watch", storm_window: "Next 48 hours",
  selected_fire: { domainIncidentId: domainId }, last_refresh: "2026-09-14T00:00:00Z",
  location_context: { id: "ventura-ca", county: "Ventura County", state: "CA", label: "Ventura County, CA",
    centroid: [-119.1, 34.3], bbox: [-119.6, 34, -118.6, 34.7], fips: "06111", fireWeatherZone: "auto",
    population: 1, wildfireContext: "Test-only context", coverageStatus: "available" },
};
type Stage = "first-page" | "later-page" | "final-count" | "body";

// The real client factory and bounded transport talk only to this isolated server.
async function fixture(options: { stall?: Stage; releaseMs?: number; failPage?: number } = {}) {
  const calls: { table: string; method: string; after: string | null }[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let pages = 0;
  let stalled = false;
  let canceled = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const table = url.pathname.split("/").at(-1)!;
    const method = request.method!;
    calls.push({ table, method, after: url.searchParams.get("id") });
    const send = (body: unknown, count?: number, status = 200) => {
      response.writeHead(status, { "content-type": "application/json", ...(count === undefined ? {} : { "content-range": `0-0/${count}` }) });
      response.end(method === "HEAD" ? undefined : JSON.stringify(body));
    };
    if (table === "fireafter_read_import_receipt") { send(null); return; }
    if (table === "incidents") {
      send([incident]);
      return;
    }
    if (table !== "assets") { send([], 0); return; }
    if (method !== "HEAD") pages++;
    if (pages === options.failPage && method !== "HEAD") {
      send({ code: "42501", message: "test-only private denial" }, undefined, 503);
      return;
    }
    const after = url.searchParams.get("id")?.replace(/^gt\./, "");
    const index = after ? Number.parseInt(after.slice(0, 8), 16) + 1 : 1;
    const body = [{ id: assetId(index), incident_id: incidentId, properties: {}, local_or_uploaded: false }];
    const shouldStall = options.stall === "first-page" && pages === 1 && method !== "HEAD" ||
      options.stall === "later-page" && pages === 2 && method !== "HEAD" ||
      options.stall === "final-count" && method === "HEAD" ||
      options.stall === "body" && pages === 1 && method !== "HEAD";
    if (shouldStall) {
      stalled = true;
      response.once("close", () => { if (!response.writableEnded) canceled = true; });
      if (options.stall === "body") {
        response.writeHead(200, { "content-type": "application/json", "content-range": "0-0/3" });
        response.write("[");
      }
      // Release the old implementation too: failures never leave hanging tests.
      timers.push(setTimeout(() => {
        if (response.destroyed) return;
        if (options.stall === "body") response.end(JSON.stringify(body).slice(1));
        else send(body, method === "HEAD" ? 3 : 4 - index);
      }, options.releaseMs ?? 1500));
      return;
    }
    send(body, method === "HEAD" ? 3 : 4 - index);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-service-key");
  vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "60000");
  vi.stubEnv("FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES", "8388608");
  if (process.env.NODE_ENV === "production") registerProductionLoopbackDatabase(`http://127.0.0.1:${address.port}`);
  return {
    calls, state: () => ({ stalled, canceled }),
    close: async () => {
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

beforeEach(() => { vi.resetModules(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("FA13-I inventory acquisition deadline", () => {
  it.each(["first-page", "later-page", "final-count", "body"] as const)("cancels real HTTP at %s before returning a partial bundle", async stall => {
    const server = await fixture({ stall });
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => nativeTimeout(ms === 30_000 ? 300 : ms));
    try {
      const { getSupabaseIncidentBundle } = await import("./fireafter-supabase");
      await expect(getSupabaseIncidentBundle(domainId)).rejects.toMatchObject({ code: "read_budget", status: 503 });
      // One shared bundle deadline plus one per inventory, never one per page.
      expect(timer.mock.calls).toEqual([[30_000], [30_000], [30_000], [30_000]]);
      await vi.waitFor(() => expect(server.state()).toEqual({ stalled: true, canceled: true }));
      expect(server.calls.filter(c => c.table === "incidents")).toHaveLength(1);
      expect(server.calls.every(c => c.method === "GET" || c.method === "HEAD")).toBe(true);
    } finally { await server.close(); }
  });

  it("enforces the unscaled 30-second budget under the 60-second transport configuration", async () => {
    const server = await fixture({ stall: "first-page", releaseMs: 35_000 });
    try {
      const { getSupabaseIncidentBundle } = await import("./fireafter-supabase");
      const start = performance.now();
      await expect(getSupabaseIncidentBundle(domainId)).rejects.toMatchObject({ code: "read_budget" });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(29_000);
      expect(elapsed).toBeLessThan(33_000);
      await vi.waitFor(() => expect(server.state().canceled).toBe(true));
    } finally { await server.close(); }
  }, 40_000);

  it("accepts all remaining-count pages despite a server one-row cap", async () => {
    const server = await fixture();
    try {
      const { getSupabaseIncidentBundle } = await import("./fireafter-supabase");
      const bundle = await getSupabaseIncidentBundle(domainId);
      expect(bundle?.persistence.databaseIncidentId).toBe(incidentId);
      expect(Object.keys(bundle!.persistence.rowIds.asset)).toHaveLength(3);
      expect(server.calls.filter(c => c.table === "assets")).toEqual([
        { table: "assets", method: "GET", after: null },
        { table: "assets", method: "GET", after: `gt.${assetId(1)}` },
        { table: "assets", method: "GET", after: `gt.${assetId(2)}` },
        { table: "assets", method: "HEAD", after: null },
      ]);
    } finally { await server.close(); }
  });

  it("does not retry a failed page or convert denial into partial success", async () => {
    const server = await fixture({ failPage: 2 });
    try {
      const { getSupabaseIncidentBundle } = await import("./fireafter-supabase");
      await expect(getSupabaseIncidentBundle(domainId)).rejects.toMatchObject({ code: "42501" });
      expect(server.calls.filter(c => c.table === "assets")).toHaveLength(2);
    } finally { await server.close(); }
  });

  it("blocks actual import persistence and live refresh after an expired inventory read", async () => {
    // Test production failure semantics, not Vitest's explicit in-memory fixture mode.
    vi.stubEnv("NODE_ENV", "production");
    const server = await fixture({ stall: "final-count" });
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => nativeTimeout(ms === 30_000 ? 300 : ms));
    try {
      const { importIncidentAssets } = await import("./fireafter-data");
      await expect(importIncidentAssets({ operationId, incidentId: domainId, fileName: "test-only.csv", content: "name,longitude,latitude\nCrossing,-119.1,34.3",
        principal: { kind: "user", actorId: "30000000-0000-4000-8000-000000000003", organizationId },
      })).rejects.toMatchObject({ code: "read_budget" });
      expect(server.calls.some(c => c.method !== "GET" && c.method !== "HEAD" && c.table !== "fireafter_read_import_receipt")).toBe(false);
      expect(server.calls.filter(c => c.table === "incidents")).toHaveLength(2);
    } finally { await server.close(); }
  });

  it.each([false, true])("valid import reaches downstream boundaries only without expiry (expired=%s)", async expired => {
    vi.stubEnv("NODE_ENV", "production");
    const server = await fixture({ stall: expired ? "final-count" : undefined });
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => nativeTimeout(ms === 30_000 ? 300 : ms));
    try {
      const persistence = await import("./fireafter-supabase");
      const persist = vi.spyOn(persistence, "persistImportedAssetsToSupabase").mockImplementation(async input => ({ ...input, receipt: { ...importReceipt, incidentId, requestHash: input.importOperation.requestHash }, replayed: false }));
      const sources = await import("./live-sources");
      const refresh = vi.spyOn(sources, "runLiveSourceRefresh").mockRejectedValue(new Error("test-only refresh boundary reached"));
      const { importIncidentAssets } = await import("./fireafter-data");
      const operation = importIncidentAssets({ operationId, incidentId: domainId, fileName: "test-only.csv",
        content: "name,longitude,latitude\nCrossing,-119.1,34.3",
        principal: { kind: "user", actorId: "30000000-0000-4000-8000-000000000003", organizationId },
      });
      if (expired) await expect(operation).rejects.toMatchObject({ code: "read_budget" });
      else await expect(operation).resolves.toMatchObject({
        bundle: null, importOutcome: { state: "persisted", refresh: "unconfirmed" },
      });
      expect(persist).toHaveBeenCalledTimes(expired ? 0 : 1);
      expect(refresh).toHaveBeenCalledTimes(expired ? 0 : 1);
      if (!expired) expect(persist.mock.calls[0][0].assets).toHaveLength(1);
    } finally { await server.close(); }
  });
});
