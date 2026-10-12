import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSupabasePayload, mapSupabaseRowsToBundle } from "./fireafter-supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { queueSourceProjection, QUEUE_SOURCE_SELECT } from "./queue-source-read-model";
import { projectBundleFreshness } from "./source-freshness";
import { inventoryUser as user } from "../test/asset-page-fixture";
import { queuePage } from "../test/queue-page-fixture";
import type { Asset, SourceSnapshot } from "./types";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
const auth = vi.hoisted(() => vi.fn());
vi.mock("./auth", async original => ({ ...await original<typeof import("./auth")>(), getCurrentUser: auth }));
vi.mock("@/components/fireafter-dashboard", () => ({ FireAfterDashboard: () => null }));
type Options = { total?: number; cap?: number; expired?: boolean; defect?: string; delay?: number };
async function fixture(options: Options = {}) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]), now = new Date();
  const recommendations = queuePage(0, options.total ?? 26, options.total ?? 26).items.flatMap(item => item.status === "available" ? [{ ...item.recommendation,
    incidentId: incident.id, coordinates: [-118.25, 34.05] as [number, number], assetName: `Bridge ${String(100000 - item.position).padStart(6, "0")}`,
    score100: item.position % 3 === 0 ? 80 : 60, riskLevel: item.position % 2 ? "High" as const : "Unknown" as const,
  }] : []);
  const assets: Asset[] = recommendations.map(rec => ({ id: rec.assetId, incidentId: incident.id, name: rec.assetName, type: "Bridge", locationLabel: "Creek",
    coordinates: rec.coordinates, source: "National Bridge Inventory", sourceKey: "nbi", confidence: "Medium", localOrUploaded: false }));
  const time = new Date(now.getTime() - (options.expired ? 3600000 : 0)).toISOString();
  const sources: SourceSnapshot[] = [{ id: "source-nbi", incidentId: incident.id, sourceKey: "nbi", sourceName: "Bridge Inventory", fetchedAt: time, sourceUpdatedAt: time,
    sourceTimeBasis: "provider", status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Checked", detail: "Published records", rawPayload: { records: 605 } }];
  const payload = buildSupabasePayload({ incident, sourceSnapshots: sources, recommendations }, { assets, auditEvents: [],
    write: { actorId: user.id, organizationId: user.organizationId, operation: "create", expectedRevision: null } });
  const requests: URL[] = [], timers: ReturnType<typeof setTimeout>[] = []; let parentReads = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost"); requests.push(url); expect(request.method).toBe("GET");
    let rows: Record<string, unknown>[], count: number;
    if (url.pathname.endsWith("/incidents")) {
      const row = structuredClone(payload.incident); parentReads++;
      if (options.defect === "foreign" || (options.defect === "changed-authority" && parentReads > 1)) row.organization_id = "30000000-0000-4000-8000-000000000003";
      const manifest = row.selected_fire.inventoryManifest as { revision: string; queueIndex?: unknown };
      if (options.defect === "changed-generation" && parentReads > 1) manifest.revision = "30000000-0000-4000-8000-000000000003";
      if (options.defect === "legacy") delete manifest.queueIndex;
      rows = [row]; count = 1;
    } else {
      const table = url.pathname.split("/").at(-1)!;
      expect(["source_snapshots", "assets", "recommendations"]).toContain(table);
      const ids = url.searchParams.get("id")!.slice(4, -1).split(","); expect(ids.length).toBeLessThanOrEqual(50);
      expect(url.searchParams.get("incident_id")).toBe(`eq.${payload.incident.id}`);
      expect(request.headers.prefer).toContain("count=exact");
      const data = table === "source_snapshots" ? payload.sourceSnapshots.map(queueSourceProjection) : table === "assets" ? payload.assets : payload.recommendations;
      if (table === "source_snapshots") expect(url.searchParams.get("select")).toBe(QUEUE_SOURCE_SELECT);
      rows = structuredClone(data.filter(row => ids.includes(row.id)).slice(0, options.cap ?? 50)); count = ids.length;
      if (table === "recommendations" && rows.length) {
        if (options.defect === "duplicate") rows = [rows[0], rows[0]];
        if (options.defect === "missing") rows = [];
        if (options.defect === "wrong-count") count--;
        if (options.defect === "retired-asset") rows[0].asset_id = "30000000-0000-4000-8000-000000000003";
        if (options.defect === "oversize") rows[0].limitations = ["x".repeat(4194305)];
        if (options.defect === "non-operational") (rows[0].score_breakdown as Record<string, unknown>).nonOperational = true;
        if (options.defect === "outside") (rows[0].score_breakdown as Record<string, unknown>).coordinates = [0, 0];
      }
    }
    const send = () => { if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json", "content-range": `0-${Math.max(0, rows.length - 1)}/${count}` }); response.end(JSON.stringify(rows)); } };
    if (options.delay && url.pathname.endsWith("/recommendations")) timers.push(setTimeout(send, options.delay)); else send();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-fixture-only"); vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "60000");
  return { incidentId: incident.id, payload, requests,
    close: async () => { timers.forEach(clearTimeout); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
beforeEach(() => { vi.resetModules(); auth.mockReset().mockResolvedValue(user); vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each([false, true])("matches the complete mapped queue across all capped pages, expired=%s", async expired => {
  const server = await fixture({ cap: 2, expired });
  try {
    const { getSupabaseQueuePage: read } = await import("./fireafter-supabase"); const all: string[] = []; let start = 0, revision: string | undefined;
    do {
      const result = await read({ incidentId: server.incidentId, start: String(start), limit: "10", revision, state: revision ? expired ? "expired" : "current" : undefined }, user);
      expect(result.page.items.every((item, index) => item.position === start + index + 1)).toBe(true);
      const expected = projectBundleFreshness(mapSupabaseRowsToBundle({ ...server.payload, responderActions: [], auditEvents: [] }), new Date(result.page.evaluatedAt));
      const records = result.page.items.flatMap(item => item.status === "available" ? [item.recommendation] : []);
      expect(records).toEqual(expected.recommendations.slice(start, start + 10)); all.push(...records.map(rec => rec.id)); revision = result.page.revision;
      if (result.page.nextStart === null) break; start = result.page.nextStart;
    } while (start < 100);
    expect(all).toHaveLength(26); expect(new Set(all).size).toBe(26);
    expect(server.requests.every(url => !["responder_actions", "audit_events"].some(table => url.pathname.endsWith(table)))).toBe(true);
  } finally { await server.close(); }
});
it.each(["foreign", "changed-authority", "changed-generation", "legacy", "duplicate", "missing", "wrong-count", "retired-asset", "oversize"])("fails closed for %s", async defect => {
  const server = await fixture({ defect });
  try { const { getSupabaseQueuePage: read } = await import("./fireafter-supabase");
    await expect(read({ incidentId: server.incidentId, start: "0", limit: "10" }, user)).rejects.toBeInstanceOf(Error);
    if (["foreign", "legacy"].includes(defect)) expect(server.requests).toHaveLength(1);
  } finally { await server.close(); }
});
it.each(["non-operational", "outside"])("preserves a withheld position for %s rather than shifting ranks", async defect => {
  const server = await fixture({ defect });
  try { const { getSupabaseQueuePage: read } = await import("./fireafter-supabase"), result = await read({ incidentId: server.incidentId, start: "0", limit: "10" }, user);
    expect(result.page.items).toHaveLength(10); expect(result.page.items.some(item => item.status === "withheld")).toBe(true); expect(result.page.nextStart).toBe(10);
  } finally { await server.close(); }
});
it("rejects a continuation from a different evidence state before record reads", async () => {
  const server = await fixture({ expired: true });
  try { const { getSupabaseQueuePage: read } = await import("./fireafter-supabase");
    await expect(read({ incidentId: server.incidentId, start: "0", limit: "10", state: "current" }, user)).rejects.toMatchObject({ status: 409 });
    expect(server.requests.some(url => url.pathname.endsWith("/recommendations"))).toBe(false);
  } finally { await server.close(); }
});
it("reads first, middle and final pages of a 91,511-position inventory without full child scans", async () => {
  const server = await fixture({ total: 91511 });
  try {
    const { getSupabaseQueuePage: read } = await import("./fireafter-supabase");
    const manifest = server.payload.incident.selected_fire.inventoryManifest as { revision: string; recommendationIds: string[] };
    const expected = new Map(server.payload.recommendations.map(row => [row.id, row.score_breakdown.domainRecommendationId]));
    for (const start of [0, 45750, 91510]) {
      const before = server.requests.length, result = await read({ incidentId: server.incidentId, start: String(start), limit: "10", revision: manifest.revision, state: "current" }, user);
      expect(result.page.totalStored).toBe(91511);
      expect(result.page.items.flatMap(item => item.status === "available" ? [item.recommendation.id] : [])).toEqual(manifest.recommendationIds.slice(start, start + 10).map(id => expected.get(id)));
      expect(server.requests.length - before).toBe(5);
    }
  } finally { await server.close(); }
}, 60000);
it("renders the actual map server page for 91,511 positions without full child or audit scans", async () => {
  const server = await fixture({ total: 91511 });
  try {
    const { default: MapPage } = await import("../app/map/page"), before = performance.now();
    const element = await MapPage({ searchParams: Promise.resolve({ incidentId: server.incidentId }) });
    expect(element.props.initialView).toBe("map");
    expect(element.props.bundle.queuePage.totalStored).toBe(91511); expect(element.props.bundle.recommendations).toHaveLength(10);
    expect(element.props.bundle.assets).toEqual([]); expect(element.props.bundle.actions).toEqual([]);
    expect(server.requests).toHaveLength(5);
    expect(server.requests.every(url => !["responder_actions", "audit_events"].some(table => url.pathname.endsWith(table)))).toBe(true);
    for (const url of server.requests.filter(url => ["assets", "recommendations"].some(table => url.pathname.endsWith(table)))) {
      expect(url.searchParams.get("id")!.slice(4, -1).split(",")).toHaveLength(10);
    }
    expect(performance.now() - before).toBeLessThan(15000); expect(auth).toHaveBeenCalledTimes(2);
  } finally { await server.close(); }
}, 60000);
it("cancels a stalled page at the shared 15-second deadline without retry", async () => {
  const server = await fixture({ delay: 60000 }); const start = performance.now();
  try { const { getSupabaseQueuePage: read } = await import("./fireafter-supabase");
    await expect(read({ incidentId: server.incidentId, start: "0", limit: "10" }, user)).rejects.toBeInstanceOf(Error);
    expect(performance.now() - start).toBeGreaterThan(14000); expect(performance.now() - start).toBeLessThan(20000);
    expect(server.requests.filter(url => url.pathname.endsWith("/recommendations"))).toHaveLength(1);
  } finally { await server.close(); }
}, 25000);
