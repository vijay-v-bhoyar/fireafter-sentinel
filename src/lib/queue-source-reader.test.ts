import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSupabasePayload } from "./fireafter-supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { queueSourceProjection, QUEUE_SOURCE_SELECT } from "./queue-source-read-model";
import { inventoryUser as user } from "../test/asset-page-fixture";
import type { SourceSnapshot } from "./types";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
type Options = { count?: number; cap?: number; parent?: (row: Record<string, unknown>, read: number) => void;
  change?: (rows: Record<string, unknown>[], count: number) => { rows: Record<string, unknown>[]; count: number }; delay?: number };
async function fixture(options: Options = {}) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]), now = new Date();
  const sources: SourceSnapshot[] = Array.from({ length: options.count ?? 26 }, (_, index) => ({ id: `source-${index}`, incidentId: incident.id,
    sourceKey: `source-${index}`, sourceName: `Source ${index}`, fetchedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(),
    sourceTimeBasis: "provider", status: "online", stale: false, freshnessLabel: "Checked", detail: "Published evidence", coverageStatus: "available",
    rawPayload: { value: index } }));
  const payload = buildSupabasePayload({ incident, sourceSnapshots: sources, recommendations: [] }, { assets: [], auditEvents: [],
    write: { actorId: user.id, organizationId: user.organizationId, operation: "create", expectedRevision: null } });
  const sourceRows = new Map(payload.sourceSnapshots.map(row => [row.id, queueSourceProjection(row)])), requests: URL[] = [];
  let reads = 0, closed = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost"); requests.push(url); expect(request.method).toBe("GET");
    let rows: Record<string, unknown>[], count: number;
    if (url.pathname.endsWith("/incidents")) {
      const row = structuredClone(payload.incident); options.parent?.(row, ++reads); rows = [row]; count = 1;
    } else {
      expect(url.pathname).toBe("/rest/v1/source_snapshots");
      expect(url.searchParams.get("select")).toBe(QUEUE_SOURCE_SELECT);
      expect(url.searchParams.get("incident_id")).toBe(`eq.${payload.incident.id}`);
      expect(url.searchParams.get("order")).toBe("id.asc");
      expect(request.headers.prefer).toContain("count=exact");
      const ids = url.searchParams.get("id")!.slice(4, -1).split(","); count = ids.length;
      expect(ids.length).toBeLessThanOrEqual(50);
      expect(url.searchParams.get("limit")).toBe(String(ids.length));
      rows = ids.slice(0, options.cap ?? 50).map(id => structuredClone(sourceRows.get(id)!));
      const changed = options.change?.(rows, count); if (changed) { rows = changed.rows; count = changed.count; }
    }
    const send = () => { if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json", "content-range": `0-${Math.max(0, rows.length - 1)}/${count}` }); response.end(JSON.stringify(rows)); } };
    response.on("close", () => { closed++; });
    if (options.delay && url.pathname.endsWith("/source_snapshots")) timers.push(setTimeout(send, options.delay)); else send();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-fixture-only");
  vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "60000");
  return { incidentId: incident.id, payload, requests, closed: () => closed,
    close: async () => { timers.forEach(clearTimeout); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
beforeEach(() => { vi.resetModules(); vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("reads exact source membership through real SDK capped responses without asset/recommendation reads", async () => {
  const server = await fixture({ cap: 2 });
  try {
    const { getSupabaseQueueSourceState: read } = await import("./fireafter-supabase"), page = await read(server.incidentId, user);
    expect(page.sourceSnapshots).toHaveLength(26); expect(page.withheldSourceIds).toEqual([]);
    expect(new Set(page.sourceSnapshots.map(row => row.id)).size).toBe(26);
    expect(page.sourceSnapshots.every(row => row.freshness?.state === "current")).toBe(true);
    expect(server.requests.filter(url => url.pathname.endsWith("/source_snapshots"))).toHaveLength(13);
    expect(server.requests.filter(url => url.pathname.endsWith("/incidents"))).toHaveLength(2);
  } finally { await server.close(); }
});
it.each(["foreign", "changed-generation", "changed-authority", "legacy", "old-version", "non-operational", "wrong-revision"])("rejects %s before returning source evidence", async defect => {
  const server = await fixture({ parent: (row, read) => {
    const fire = row.selected_fire as Record<string, unknown>, manifest = fire.inventoryManifest as Record<string, unknown>;
    if (defect === "foreign" || (defect === "changed-authority" && read > 1)) row.organization_id = "30000000-0000-4000-8000-000000000003";
    if (defect === "changed-generation" && read > 1) manifest.revision = "30000000-0000-4000-8000-000000000003";
    if (defect === "legacy") delete manifest.sourceQueueVersion;
    if (defect === "old-version") manifest.sourceQueueVersion = "old";
    if (defect === "non-operational") fire.nonOperational = true;
  } });
  try { const { getSupabaseQueueSourceState: read } = await import("./fireafter-supabase");
    await expect(read(server.incidentId, user, defect === "wrong-revision" ? "30000000-0000-4000-8000-000000000003" : undefined)).rejects.toBeInstanceOf(Error);
    if (!["changed-generation", "changed-authority"].includes(defect)) expect(server.requests).toHaveLength(1);
  } finally { await server.close(); }
});
it.each(["foreign-row", "duplicate", "count", "missing", "model-missing", "metadata-drift", "oversize"])("rejects %s without treating it as absent coverage", async defect => {
  const server = await fixture({ change: (rows, count) => {
    if (defect === "foreign-row") rows[0].incident_id = "other";
    if (defect === "duplicate") rows = [rows[0], rows[0]];
    if (defect === "count") count--;
    if (defect === "missing") rows = [];
    if (defect === "model-missing") rows[0].queue_read = null;
    if (defect === "metadata-drift") rows[0].source_name = "Changed outside revision";
    if (defect === "oversize") rows[0].meta_detail = "x".repeat(4 * 1024 * 1024);
    return { rows, count };
  } });
  try { const { getSupabaseQueueSourceState: read } = await import("./fireafter-supabase");
    await expect(read(server.incidentId, user)).rejects.toBeInstanceOf(Error);
  } finally { await server.close(); }
});
it("returns explicit empty membership, not invented online feeds", async () => {
  const server = await fixture({ count: 0 });
  try { const { getSupabaseQueueSourceState: read } = await import("./fireafter-supabase");
    expect(await read(server.incidentId, user)).toMatchObject({ sourceSnapshots: [], withheldSourceIds: [] }); expect(server.requests).toHaveLength(2);
  } finally { await server.close(); }
});
it("refuses unsupported source cardinality and roles before source transfer", async () => {
  const server = await fixture({ count: 129 });
  try { const { getSupabaseQueueSourceState: read } = await import("./fireafter-supabase");
    await expect(read(server.incidentId, { ...user, role: "viewer" })).rejects.toMatchObject({ status: 403 }); expect(server.requests).toHaveLength(0);
    await expect(read(server.incidentId, user)).rejects.toMatchObject({ code: "read_budget" }); expect(server.requests).toHaveLength(1);
  } finally { await server.close(); }
});
it("cancels a stalled source transfer at the unscaled whole-read deadline without retry", async () => {
  const server = await fixture({ delay: 20000 });
  try { const { getSupabaseQueueSourceState: read } = await import("./fireafter-supabase"), start = performance.now();
    await expect(read(server.incidentId, user)).rejects.toBeInstanceOf(Error);
    expect(performance.now() - start).toBeGreaterThanOrEqual(14000); expect(performance.now() - start).toBeLessThan(18000);
    expect(server.requests.filter(url => url.pathname.endsWith("/source_snapshots"))).toHaveLength(1);
  } finally { await server.close(); }
}, 25000);
