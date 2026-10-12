import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerProductionLoopbackDatabase } from "../test/sentinel-loopback-proxy";
import { buildSupabasePayload } from "./fireafter-supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { inventoryUser } from "../test/asset-page-fixture";
import { queuePage } from "../test/queue-page-fixture";
import type { Asset } from "./types";

vi.mock("./auth", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

type Fault = "upstream-error" | "body-stall" | "missing" | "asset-error" | "generation" | "topology" | "read-budget" | "shared-deadline";
const routes = ["map", "export"] as const;
async function fixture(fault?: Fault, populated = false) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const recommendations = populated ? queuePage(0, 1, 1).items.flatMap(item => item.status === "available"
    ? [{ ...item.recommendation, incidentId: incident.id, coordinates: [-118.25, 34.05] as [number, number] }] : []) : [];
  const assets: Asset[] = recommendations.map(rec => ({ id: rec.assetId, incidentId: incident.id, name: rec.assetName,
    type: "Bridge", locationLabel: "County creek", coordinates: rec.coordinates, source: "National Bridge Inventory",
    sourceKey: "nbi", confidence: "Medium", localOrUploaded: false }));
  const payload = buildSupabasePayload({ incident, sourceSnapshots: [], recommendations }, { assets, auditEvents: [],
    write: { actorId: inventoryUser.id, organizationId: inventoryUser.organizationId, operation: "create", expectedRevision: null } });
  const requests: { method: string; table: string }[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let canceledBodies = 0;
  let incidentReads = 0;
  const server = createServer((request, response) => {
    const table = new URL(request.url!, "http://localhost").pathname.split("/").at(-1)!;
    requests.push({ method: request.method!, table });
    if (!["GET", "HEAD"].includes(request.method!)) { response.writeHead(405).end(); return; }
    if ((table === "incidents" && fault === "upstream-error") || (table === "assets" && fault === "asset-error")) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "FIXTURE_ERROR", message: "PRIVATE_DATABASE_DETAIL" })); return;
    }
    if ((table === "incidents" && fault === "body-stall") || (table === "audit_events" && fault === "shared-deadline")) {
      response.once("close", () => { if (!response.writableEnded) canceledBodies++; });
      response.writeHead(200, { "content-type": "application/json" }); response.write("["); return;
    }
    let rows: unknown[] = [];
    if (table === "incidents") {
      incidentReads++;
      const row = structuredClone(payload.incident);
      if (fault === "generation" && incidentReads > 1) row.last_refresh = "2026-01-01T00:00:00.000Z";
      if (fault === "topology") {
        row.location_context = { ...row.location_context, sourceKey: "tigerweb-counties", boundary: { type: "Polygon", coordinates: [] } };
        row.selected_fire.locationContext = row.location_context;
      }
      rows = fault === "missing" ? [] : [row];
    } else if (table === "assets") rows = payload.assets;
    else if (table === "recommendations") rows = payload.recommendations;
    else if (!["source_snapshots", "audit_events", "responder_actions"].includes(table)) {
      response.writeHead(400).end("Unexpected fixture read"); return;
    }
    const count = table === "assets" && fault === "read-budget" ? 100001 : rows.length;
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json", "content-range": `0-${Math.max(0, rows.length - 1)}/${count}` });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify(rows));
    };
    if (table === "incidents" && fault === "shared-deadline") timers.push(setTimeout(send, 16000));
    else send();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-fixture-only");
  vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "250");
  vi.stubEnv("NODE_ENV", "production");
  registerProductionLoopbackDatabase(`http://127.0.0.1:${address.port}`);
  vi.stubEnv("FIREAFTER_ENABLE_FIXTURES", "false");
  return { incident, requests, canceledBodies: () => canceledBodies, close: async () => {
    timers.forEach(clearTimeout);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

async function output(route: typeof routes[number], incidentId: string, streamed = false) {
  const { GET } = route === "map" ? await import("../app/api/map/features/route") : await import("../app/api/export/geojson/route");
  return GET(new Request(`http://localhost/api/${route === "map" ? "map/features" : "export/geojson"}?incidentId=${incidentId}`,
    { headers: streamed ? { Accept: "application/x-ndjson" } : undefined }));
}
beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([false, true])("streams verified database rows with real HTTP, populated=%s", async populated => {
  const server = await fixture(undefined, populated);
  try {
    const response = await output("map", server.incident.id, true);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const { MapStreamCollector } = await import("./map-stream-contract"), collector = new MapStreamCollector(server.incident.id);
    for (const line of (await response.text()).trimEnd().split("\n")) collector.accept(JSON.parse(line));
    const map = collector.finish(); expect(map.recommendations.features).toHaveLength(populated ? 1 : 0);
    if (populated) { expect(map.recommendations.features[0].geometry?.coordinates).toEqual([-118.25, 34.05]); expect(map.recommendations.features[0].properties?.riskLevel).toBe("Unknown"); }
    expect(server.requests.every(request => ["GET", "HEAD"].includes(request.method))).toBe(true);
  } finally { await server.close(); }
});

it("rejects unavailable database evidence before negotiated stream headers", async () => {
  const server = await fixture("upstream-error");
  try {
    const response = await output("map", server.incident.id, true);
    expect(response.status).toBe(503); expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ code: "COUNTY_DATA_UNAVAILABLE" });
  } finally { await server.close(); }
});

it.each(routes.flatMap(route => (["upstream-error", "body-stall", "missing", "asset-error", "generation", "topology", "read-budget"] as const)
  .map(fault => ({ route, fault }))))("$route does not deliver successful empty data after $fault", async ({ route, fault }) => {
  const server = await fixture(fault);
  try {
    const start = performance.now();
    const response = await output(route, server.incident.id);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe(route === "map" ? "Cookie, Accept" : "Cookie");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({ code: "COUNTY_DATA_UNAVAILABLE", error: expect.stringMatching(/unavailable/i) });
    expect(body.features).toBeUndefined(); expect(body.assets).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_DATABASE_DETAIL|Upstream response|FIXTURE_ERROR|FeatureCollection/);
    expect(server.requests.length).toBeGreaterThan(0);
    expect(server.requests.every(request => ["GET", "HEAD"].includes(request.method))).toBe(true);
    if (["body-stall", "upstream-error"].includes(fault)) {
      expect(server.requests).toEqual([{ method: "GET", table: "incidents" }]);
      expect(performance.now() - start).toBeLessThan(4000);
    }
  } finally { await server.close(); }
});

it.each(routes.flatMap(route => [false, true].map(populated => ({ route, populated }))))(
  "$route preserves a verified inventory, populated=$populated", async ({ route, populated }) => {
    const server = await fixture(undefined, populated);
    try {
      const response = await output(route, server.incident.id);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe(route === "map" ? "Cookie, Accept" : "Cookie");
      const body = await response.json();
      const features = route === "map" ? body.recommendations.features : body.features;
      expect(features).toHaveLength(populated ? 1 : 0);
      if (populated) {
        expect(features[0].geometry.coordinates).toEqual([-118.25, 34.05]);
        expect(features[0].properties.riskLevel).toBe("Unknown");
      }
      if (route === "export") {
        expect(body.fireafter.incidentId).toBe(server.incident.id);
        expect(response.headers.get("content-type")).toContain("application/geo+json");
        expect(response.headers.get("content-disposition")).toContain("attachment");
      } else expect(body.incidentId).toBe(server.incident.id);
    } finally { await server.close(); }
  },
);

it("shares the thirty-second saved-read deadline across initial lookup and stalled audit bodies", async () => {
  const server = await fixture("shared-deadline");
  vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "60000");
  try {
    const start = performance.now();
    const response = await output("export", server.incident.id);
    expect(response.status).toBe(503);
    expect(performance.now() - start).toBeGreaterThanOrEqual(29900);
    expect(performance.now() - start).toBeLessThan(34000);
    expect(server.requests.filter(request => request.table === "incidents")).toHaveLength(1);
    expect(server.requests.filter(request => request.table === "audit_events")).toHaveLength(2);
    await vi.waitFor(() => expect(server.canceledBodies()).toBe(2));
    expect(response.headers.get("content-disposition")).toBeNull();
  } finally { await server.close(); }
}, 40000);
