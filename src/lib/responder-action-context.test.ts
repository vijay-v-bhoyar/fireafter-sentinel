import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSupabasePayload, mapSupabaseRowsToBundle } from "./fireafter-supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { queueSourceProjection, QUEUE_SOURCE_SELECT } from "./queue-source-read-model";
import { projectBundleFreshness } from "./source-freshness";
import { ATOMIC_RESPONDER_ACTION_SECURITY_RPC } from "./operational-write-security";
import { inventoryUser as user } from "../test/asset-page-fixture";
import { queuePage } from "../test/queue-page-fixture";
import type { InventoryManifest } from "./inventory-manifest";
import type { Asset, SourceSnapshot } from "./types";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
type Options = { total?: number; expired?: boolean; cap?: number; defect?: string; stall?: "assets" | "source_snapshots"; expireAtFence?: boolean };
type RpcArgs = { p_action: Record<string, unknown> | null; p_audit_event: Record<string, unknown> | null };
const foreignId = "30000000-0000-4000-8000-000000000003";

async function fixture(options: Options = {}) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const recommendations = queuePage(0, options.total ?? 3, options.total ?? 3).items.flatMap(item => item.status === "available" ? [{
    ...item.recommendation, incidentId: incident.id, coordinates: [-118.25, 34.05] as [number, number],
  }] : []);
  const assets: Asset[] = recommendations.map(rec => ({ id: rec.assetId, incidentId: incident.id, name: rec.assetName, type: "Bridge", locationLabel: "Creek",
    coordinates: rec.coordinates, source: "National Bridge Inventory", sourceKey: "nbi", confidence: "Medium", localOrUploaded: false }));
  const now = Date.now(), time = new Date(now - (options.expired ? 3600000 : 0)).toISOString();
  const sources: SourceSnapshot[] = ["nbi", "osm_roads", "nhd_streams"].map(sourceKey => ({
    id: `source-${sourceKey}`, incidentId: incident.id, sourceKey, sourceName: sourceKey, fetchedAt: time, sourceUpdatedAt: time,
    sourceTimeBasis: "provider", status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Checked", detail: "Published records",
    rawPayload: { records: Array.from({ length: 8000 }, () => randomUUID()) },
  }));
  const payload = buildSupabasePayload({ incident, sourceSnapshots: sources, recommendations }, { assets, auditEvents: [],
    write: { actorId: user.id, organizationId: user.organizationId, operation: "create", expectedRevision: null } });
  const manifest = payload.incident.selected_fire.inventoryManifest as InventoryManifest;
  const input = { commandId: randomUUID(), expectedRevision: manifest.revision, recommendationId: payload.recommendations[0].id,
    action: "annotate" as const, note: "Review selected bridge", actorName: "Local test operator", actorId: user.id, actorOrganizationId: user.organizationId! };
  if (options.defect === "source-version") manifest.sourceQueueVersion = "unsupported";
  if (options.defect === "legacy") delete manifest.sourceQueueVersion;
  if (options.defect === "retired") manifest.assetIds = [];
  if (options.defect === "source-limit") manifest.sourceSnapshotIds = Array.from({ length: 129 }, () => randomUUID());
  const requests: URL[] = [], rpcCalls: RpcArgs[] = [], violations: string[] = [];
  const bytes = { parents: 0, assets: 0, recommendations: 0, sources: 0 };
  let parentReads = 0, replay: { action: unknown; auditEvent: unknown } | null = null, changedRevision = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost"); requests.push(url);
    const fail = (message: string) => { violations.push(message); response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ message })); };
    try {
      if (url.pathname.endsWith(`/rpc/${ATOMIC_RESPONDER_ACTION_SECURITY_RPC}`) && request.method === "POST") {
        let body = ""; for await (const chunk of request) body += chunk;
        const args = JSON.parse(body) as RpcArgs; rpcCalls.push(args);
        // Controlled HTTP transport, not a substitute for SQL atomicity/grant tests.
        const receipt = args.p_action ? { action: args.p_action, auditEvent: args.p_audit_event } : replay;
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(receipt)); return;
      }
      if (options.defect === "legacy" && request.method === "HEAD" && url.pathname.endsWith("/source_snapshots") &&
        url.searchParams.get("incident_id") === `eq.${payload.incident.id}` && url.searchParams.get("select") === "id") {
        response.writeHead(200, { "content-range": `*/${payload.sourceSnapshots.length}` }); response.end(); return;
      }
      if (request.method !== "GET") { fail("Unexpected method"); return; }
      const table = url.pathname.split("/").at(-1)!;
      let rows: Record<string, unknown>[], count = 0;
      if (table === "incidents") {
        parentReads++;
        const row = structuredClone(payload.incident);
        if (options.defect === "foreign" || (options.defect === "changed-authority" && parentReads > 1)) row.organization_id = foreignId;
        if (options.defect === "non-operational-incident") row.selected_fire.nonOperational = true;
        if (changedRevision || (options.defect === "changed-generation" && parentReads > 1)) (row.selected_fire.inventoryManifest as InventoryManifest).revision = foreignId;
        if (options.expireAtFence && parentReads > 1) vi.setSystemTime(now + 3600000);
        rows = [row]; count = 1;
      } else if (table === "recommendations") {
        const id = url.searchParams.get("id"), alias = url.searchParams.get("score_breakdown");
        if (!id?.startsWith("eq.") && !alias?.startsWith("cs.")) { fail("Unbounded recommendation read"); return; }
        const domainId = alias ? JSON.parse(alias.slice(3)).domainRecommendationId : undefined;
        rows = structuredClone(payload.recommendations.filter(row => id ? `eq.${row.id}` === id : row.score_breakdown.domainRecommendationId === domainId));
        if (options.defect === "non-operational-recommendation" && rows[0]) (rows[0].score_breakdown as Record<string, unknown>).nonOperational = true;
        if (options.defect === "outside-recommendation" && rows[0]) (rows[0].score_breakdown as Record<string, unknown>).coordinates = [0, 0];
        count = rows.length;
      } else if (table === "assets") {
        const id = url.searchParams.get("id");
        if (!id?.startsWith("eq.") || url.searchParams.get("incident_id") !== `eq.${payload.incident.id}`) { fail("Unbounded or unscoped asset read"); return; }
        rows = structuredClone(payload.assets.filter(row => `eq.${row.id}` === id));
        if (options.defect === "missing-asset") rows = [];
        if (rows[0]) {
          if (options.defect === "foreign-asset") rows[0].incident_id = foreignId;
          if (options.defect === "wrong-asset") rows[0].id = foreignId;
          if (options.defect === "non-operational-asset") (rows[0].properties as Record<string, unknown>).nonOperational = true;
          if (options.defect === "outside-asset") (rows[0].properties as Record<string, unknown>).coordinates = [0, 0];
          if (options.defect === "oversize") (rows[0].properties as Record<string, unknown>).detail = "x".repeat(8 * 1024 * 1024);
        }
        count = rows.length;
      } else if (table === "source_snapshots") {
        if (url.searchParams.get("incident_id") !== `eq.${payload.incident.id}`) { fail("Unscoped source read"); return; }
        if (options.defect === "legacy") {
          rows = structuredClone(payload.sourceSnapshots).sort((a, b) => a.id.localeCompare(b.id)); count = rows.length;
        } else {
          if (url.searchParams.get("select") !== QUEUE_SOURCE_SELECT || !url.searchParams.get("id")?.startsWith("in.(")) { fail("Full source payload read"); return; }
          if (!request.headers.prefer?.includes("count=exact")) { fail("Uncounted source read"); return; }
          const ids = url.searchParams.get("id")!.slice(4, -1).split(",");
          if (ids.length > 50) { fail("Oversized source batch"); return; }
          rows = structuredClone(payload.sourceSnapshots.filter(row => ids.includes(row.id)).map(queueSourceProjection).slice(0, options.cap ?? 50)); count = ids.length;
          if (options.defect === "missing-source") rows = [];
          if (options.defect === "wrong-count") count--;
          if (options.defect === "duplicate-source") rows = [rows[0], rows[0]];
          if (options.defect === "bad-source-model") delete rows[0].queue_read;
          if (options.defect === "source-metadata") rows[0].fetched_at = "2000-01-01T00:00:00Z";
          if (options.defect === "foreign-source") rows[0].incident_id = foreignId;
        }
      } else { fail(`Unexpected table: ${table}`); return; }
      const body = JSON.stringify(rows);
      const category = table === "incidents" ? "parents" : table === "source_snapshots" ? "sources" : table as "assets" | "recommendations";
      bytes[category] += Buffer.byteLength(body);
      response.writeHead(200, { "content-type": "application/json", "content-range": `0-${Math.max(0, rows.length - 1)}/${count}` });
      if (options.stall === table) { response.write("["); return; }
      response.end(body);
    } catch (error) { fail(error instanceof Error ? error.message : "Local fixture failure"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-fixture-only"); vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "60000");
  vi.stubEnv("FIREAFTER_EVIDENCE_MAX_AGE_MINUTES", "30");
  return { input, payload, requests, rpcCalls, violations, bytes,
    enableReplay() { const prior = rpcCalls.find(call => call.p_action); if (!prior) throw new Error("No prior receipt"); replay = { action: prior.p_action, auditEvent: prior.p_audit_event }; changedRevision = true; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

beforeEach(() => { vi.resetModules(); vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([false, true])("captures the same fresh/stale snapshot with bounded HTTP source reads, expired=%s", async expired => {
  const server = await fixture({ expired, cap: 1 });
  try {
    const { recordSupabaseAction: record } = await import("./fireafter-supabase");
    const result = await record(server.input);
    const expected = projectBundleFreshness(mapSupabaseRowsToBundle({ ...server.payload, responderActions: [], auditEvents: [] }), new Date(result!.createdAt));
    const rec = expected.recommendations.find(row => row.assetId === result!.recommendationSnapshot.assetId)!;
    expect(result!.recommendationSnapshot).toMatchObject(rec);
    expect(result!.recommendationSnapshot.riskLevel).toBe(expired ? "Unknown" : "High");
    expect(result!.auditEvent.payload.recommendationSnapshot).toMatchObject(rec);
    expect(server.rpcCalls).toHaveLength(2); expect(server.rpcCalls[0].p_action).toBeNull();
    expect(server.requests.filter(url => url.pathname.endsWith("/assets"))).toHaveLength(1);
    expect(server.requests.filter(url => url.pathname.endsWith("/source_snapshots"))).toHaveLength(3);
    expect(server.bytes.sources).toBeLessThan(16000); expect(server.violations).toEqual([]);
  } finally { await server.close(); }
});

it.each(["foreign", "changed-authority", "changed-generation", "retired", "missing-asset", "foreign-asset", "wrong-asset", "outside-asset", "outside-recommendation",
  "non-operational-incident", "non-operational-asset", "non-operational-recommendation", "oversize", "source-version", "source-limit", "missing-source", "wrong-count", "duplicate-source", "bad-source-model", "source-metadata", "foreign-source"])("does not submit a new decision for %s", async defect => {
  const server = await fixture({ defect });
  try {
    const { recordSupabaseAction: record } = await import("./fireafter-supabase");
    await expect(record(server.input)).rejects.toBeDefined();
    expect(server.rpcCalls.every(call => call.p_action === null)).toBe(true); expect(server.violations).toEqual([]);
  } finally { await server.close(); }
});

it("retains legacy source hydration only for publications without a projection version", async () => {
  const server = await fixture({ defect: "legacy" });
  try { const { recordSupabaseAction: record } = await import("./fireafter-supabase");
    expect((await record(server.input))!.note).toBe(server.input.note); expect(server.violations).toEqual([]);
    expect(server.requests.find(url => url.pathname.endsWith("/source_snapshots"))!.searchParams.get("select")).toBe("*");
  } finally { await server.close(); }
});

it("returns a prior receipt after inventory changes without rereading decision context", async () => {
  const server = await fixture();
  try { const { recordSupabaseAction: record } = await import("./fireafter-supabase");
    const original = await record(server.input); server.enableReplay(); const before = server.requests.length;
    expect(await record(server.input)).toEqual(original);
    expect(server.requests.slice(before).some(url => /\/(assets|source_snapshots)$/.test(url.pathname))).toBe(false);
    expect(server.rpcCalls.filter(call => call.p_action)).toHaveLength(1); expect(server.violations).toEqual([]);
  } finally { await server.close(); }
});

it("uses the clock after the final parent fence, not the earlier source read", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); const server = await fixture({ expireAtFence: true });
  try { const { recordSupabaseAction: record } = await import("./fireafter-supabase");
    const result = await record(server.input); expect(result!.recommendationSnapshot.riskLevel).toBe("Unknown");
    expect(result!.auditEvent.payload.recommendationSnapshot).toMatchObject({ riskLevel: "Unknown" }); expect(server.violations).toEqual([]);
  } finally { await server.close(); }
});

it("records first, middle and last decisions from 91,511 positions without full child scans", async () => {
  const server = await fixture({ total: 91511 }); const started = performance.now();
  try {
    const { recordSupabaseAction: record } = await import("./fireafter-supabase");
    for (const index of [0, 45755, 91510]) {
      const row = server.payload.recommendations[index];
      const result = await record({ ...server.input, commandId: randomUUID(), recommendationId: row.id });
      expect(result!.recommendationSnapshot.id).toBe(row.score_breakdown.domainRecommendationId);
      expect(result!.recommendationSnapshot.riskLevel).toBe("High");
    }
    expect(server.rpcCalls.filter(call => call.p_action)).toHaveLength(3);
    expect(server.requests.filter(url => url.pathname.endsWith("/assets"))).toHaveLength(3);
    expect(server.bytes.assets).toBeLessThan(10000); expect(server.bytes.sources).toBeLessThan(50000); expect(server.violations).toEqual([]);
    console.log("[local action-context receipt]", JSON.stringify({ positions: 91511, decisions: 3, durationMs: Math.round(performance.now() - started), bytes: server.bytes, requests: server.requests.length, hostedRequests: 0, sqlCommitExecuted: false }));
  } finally { await server.close(); }
}, 60000);

it.each(["assets", "source_snapshots"] as const)("cancels a stalled %s body within the shared ten-second context deadline", async stall => {
  const server = await fixture({ stall }); const started = performance.now();
  try { const { recordSupabaseAction: record } = await import("./fireafter-supabase");
    await expect(record(server.input)).rejects.toBeDefined();
    expect(performance.now() - started).toBeGreaterThan(9000); expect(performance.now() - started).toBeLessThan(15000);
    expect(server.requests.filter(url => url.pathname.endsWith(`/${stall}`))).toHaveLength(1);
    expect(server.rpcCalls.every(call => call.p_action === null)).toBe(true); expect(server.violations).toEqual([]);
  } finally { await server.close(); }
}, 20000);
