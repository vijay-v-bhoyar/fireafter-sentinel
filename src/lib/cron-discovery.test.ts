import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import {
  claimSupabaseScheduledRefreshes,
  listSupabaseIncidentIds,
  settleSupabaseScheduledRefresh,
} from "./fireafter-supabase";
import { getSupabaseAdminClient } from "./supabase";
import { refreshIncidentBundle } from "./fireafter-data";
import { GET } from "@/app/api/cron/refresh/route";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn() }));
vi.mock("./fireafter-data", () => ({ refreshIncidentBundle: vi.fn() }));

type Row = { id: string; selected_fire: Record<string, unknown>; last_refresh: string | null };
const row = (i: number, nonOperational = false): Row => ({
  id: `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`,
  selected_fire: { domainIncidentId: `incident-${i}`, ...(nonOperational ? { fireafterNonOperational: true } : {}) },
  last_refresh: null,
});

// Exercise the installed PostgREST query serializer; transport exists only in tests.
function install(rows: Row[], options: { pageSize?: number; failPage?: number; failRpc?: "claim" | "settle"; count?: number; omit?: boolean; countDrift?: boolean } = {}) {
  let pages = 0;
  let counts = 0;
  let attemptSequence = 0;
  const scheduled = new Map<string, { attemptId?: string; nextAttemptAt: number | null; lastAttemptAt: number | null }>();
  const calls: URL[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    signals.push(init?.signal);
    if (url.pathname.endsWith("/rpc/fireafter_claim_scheduled_refreshes")) {
      if (options.failRpc === "claim") return Response.json({ code: "42501", message: "private database diagnostic" }, { status: 503 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { p_limit?: number; p_worker_id?: string };
      const now = Date.now();
      const candidates = rows.filter(record => {
        const state = scheduled.get(record.id) ?? { nextAttemptAt: null, lastAttemptAt: null };
        return !record.selected_fire.fireafterNonOperational && state.attemptId === undefined &&
          (state.nextAttemptAt === null || state.nextAttemptAt <= now);
      }).sort((a, b) => {
        const left = scheduled.get(a.id) ?? { nextAttemptAt: null, lastAttemptAt: null };
        const right = scheduled.get(b.id) ?? { nextAttemptAt: null, lastAttemptAt: null };
        return (left.nextAttemptAt === null ? -Infinity : left.nextAttemptAt) - (right.nextAttemptAt === null ? -Infinity : right.nextAttemptAt) ||
          (left.lastAttemptAt === null ? -Infinity : left.lastAttemptAt) - (right.lastAttemptAt === null ? -Infinity : right.lastAttemptAt) || a.id.localeCompare(b.id);
      }).slice(0, body.p_limit ?? 20);
      return Response.json(candidates.map(record => {
        const attemptId = `${(++attemptSequence).toString(16).padStart(8, "0")}-0000-4000-8000-000000000002`;
        scheduled.set(record.id, { attemptId, nextAttemptAt: null, lastAttemptAt: now });
        return { incident_id: record.id, domain_incident_id: String(record.selected_fire.domainIncidentId), attempt_id: attemptId, worker_id: body.p_worker_id };
      }));
    }
    if (url.pathname.endsWith("/rpc/fireafter_settle_scheduled_refresh")) {
      if (options.failRpc === "settle") return Response.json({ code: "42501", message: "private database diagnostic" }, { status: 503 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { p_incident_id?: string; p_attempt_id?: string; p_succeeded?: boolean };
      const state = scheduled.get(body.p_incident_id ?? "");
      if (!state || state.attemptId !== body.p_attempt_id) return Response.json({ code: "FR409", message: "lease mismatch" }, { status: 409 });
      scheduled.set(body.p_incident_id!, { attemptId: undefined, nextAttemptAt: body.p_succeeded ? null : Date.now() + 60_000, lastAttemptAt: state.lastAttemptAt });
      return Response.json(null);
    }
    if (init?.method === "HEAD") {
      counts++;
      return new Response(null, { status: 200, headers: { "content-range": `0-0/${(options.count ?? rows.length) + (options.countDrift && counts > 1 ? 1 : 0)}` } });
    }
    pages++;
    if (pages === options.failPage) return Response.json({ code: "08006", message: "private database diagnostic" }, { status: 503 });
    const after = url.searchParams.get("id")?.replace(/^gt\./, "") ?? "";
    const byId = (a: Row, b: Row) => a.id.localeCompare(b.id);
    const compare = url.searchParams.get("order")?.startsWith("last_refresh.")
      ? (a: Row, b: Row) => (a.last_refresh === null ? -Infinity : Date.parse(a.last_refresh)) -
        (b.last_refresh === null ? -Infinity : Date.parse(b.last_refresh)) || byId(a, b)
      : byId;
    const selected = rows.filter(r => r.id > after).sort(compare)
      .slice(0, Math.min(Number(url.searchParams.get("limit") ?? 1000), options.pageSize ?? 1000));
    return Response.json(options.omit ? [] : selected);
  });
  vi.mocked(getSupabaseAdminClient).mockReturnValue(createClient("https://discovery.example", "test-only-key", {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  }));
  return { calls, signals, fetch };
}

describe("FA15-D cron discovery", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("rejects unavailable database configuration", async () => {
    vi.mocked(getSupabaseAdminClient).mockReturnValue(null);
    await expect(listSupabaseIncidentIds()).rejects.toThrow(/Supabase|database/i);
  });

  it("selects eligible incidents beyond excluded records and a provider page cap", async () => {
    const records = [...Array.from({ length: 25 }, (_, i) => row(i + 1, true)), row(26), row(27), row(28)];
    records[26].last_refresh = "2026-01-01T00:00:00Z";
    const { calls, signals } = install(records, { pageSize: 7 });
    await expect(listSupabaseIncidentIds(2)).resolves.toEqual(["incident-26", "incident-28"]);
    expect(calls.filter(u => u.searchParams.has("order")).length).toBeGreaterThan(1);
    expect(signals.every(s => s instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(1);
  });

  it("does not return partial work when a later page fails", async () => {
    const { calls } = install([row(1), row(2), row(3)], { pageSize: 1, failPage: 2 });
    await expect(listSupabaseIncidentIds(2)).rejects.toBeDefined();
    expect(calls).toHaveLength(3); // One count and two pages, with no SDK retry.
  });

  it("rejects incomplete discovery even if a page is empty", async () => {
    install([row(1)], { omit: true });
    await expect(listSupabaseIncidentIds()).rejects.toThrow(/inventory/i);
  });

  it("rejects a county count above the synchronous safety ceiling", async () => {
    const { calls } = install([], { count: 10_001 });
    await expect(listSupabaseIncidentIds()).rejects.toThrow(/budget|capacity/i);
    expect(calls).toHaveLength(1);
  });

  it("accepts a confirmed empty database", async () => {
    install([]);
    await expect(listSupabaseIncidentIds()).resolves.toEqual([]);
  });

  it("claims and settles durable scheduled-refresh state through the installed RPC serializer", async () => {
    const records = [row(1), row(2)];
    const { calls } = install(records);
    const claims = await claimSupabaseScheduledRefreshes(2, "worker-test", 60);
    expect(claims).toHaveLength(2);
    expect(claims.every(claim => claim.workerId === "worker-test")).toBe(true);
    await settleSupabaseScheduledRefresh(claims[0], false);
    await settleSupabaseScheduledRefresh(claims[1], true);
    expect(calls.filter(url => url.pathname.includes("fireafter_")).map(url => url.pathname)).toEqual([
      "/rest/v1/rpc/fireafter_claim_scheduled_refreshes",
      "/rest/v1/rpc/fireafter_settle_scheduled_refresh",
      "/rest/v1/rpc/fireafter_settle_scheduled_refresh",
    ]);
  });

  it("orders null refresh first, then oldest time and stable database ID", async () => {
    const records = [row(3), row(2), row(1), row(4)];
    records[0].last_refresh = "2026-02-01T00:00:00Z";
    records[1].last_refresh = "2026-01-01T00:00:00Z";
    install(records);
    await expect(listSupabaseIncidentIds(4)).resolves.toEqual(["incident-1", "incident-4", "incident-2", "incident-3"]);
  });

  it("rejects observed count drift before scheduling work", async () => {
    install([row(1)], { countDrift: true });
    await expect(listSupabaseIncidentIds()).rejects.toMatchObject({ code: "read_generation" });
  });

  it.each([0, 21, 1.5, NaN, Infinity])("rejects invalid selection limit %s before querying", async limit => {
    const { calls } = install([row(1)]);
    await expect(listSupabaseIncidentIds(limit)).rejects.toThrow(/limit/i);
    expect(calls).toHaveLength(0);
  });

  it.each(["id", "time", "selected-fire", "duplicate"])("rejects malformed %s discovery records", async kind => {
    const records = [row(1)];
    if (kind === "id") records[0].id = "not-a-database-uuid";
    if (kind === "time") records[0].last_refresh = "invalid-time";
    if (kind === "selected-fire") records[0].selected_fire = [] as unknown as Record<string, unknown>;
    if (kind === "duplicate") records.push(row(1));
    install(records);
    await expect(listSupabaseIncidentIds()).rejects.toMatchObject({ code: "read_invalid" });
  });

  it.each(["head", "page", "final-count"])("propagates the deadline through a stalled real HTTP %s request", async stage => {
    let headCount = 0;
    let stalled = false;
    const server = createServer((request, response) => {
      if (request.method === "HEAD") headCount++;
      if ((stage === "head" && headCount === 1) || (stage === "page" && request.method !== "HEAD") ||
        (stage === "final-count" && headCount === 2)) { stalled = true; return; }
      response.setHeader("content-type", "application/json");
      response.setHeader("content-range", "0-0/1");
      response.end(request.method === "HEAD" ? undefined : JSON.stringify([row(1)]));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback port");
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(() => timeout(500));
      vi.mocked(getSupabaseAdminClient).mockReturnValue(createClient(`http://127.0.0.1:${address.port}`, "test-only-key", {
        auth: { persistSession: false, autoRefreshToken: false },
      }));
      await expect(listSupabaseIncidentIds()).rejects.toMatchObject({ code: "read_budget" });
      expect(stalled).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("accepts exactly the discovery ceiling without truncating selection", async () => {
    const records = Array.from({ length: 10_000 }, (_, i) => row(i + 1, i < 9999));
    const { calls } = install(records);
    await expect(listSupabaseIncidentIds(1)).resolves.toEqual(["incident-10000"]);
    expect(calls).toHaveLength(22);
  });

  it("does not start refreshes when real discovery fails after an eligible page", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    install([row(1), row(2)], { failRpc: "claim" });
    const response = await GET(new Request("http://localhost/api/cron/refresh", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(response.status).toBe(500);
    expect(refreshIncidentBundle).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("private database diagnostic");
  });

  it("returns non-success from the real cron route when database configuration is absent", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getSupabaseAdminClient).mockReturnValue(null);
    const response = await GET(new Request("http://localhost/api/cron/refresh", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Incident claim failed" });
    expect(refreshIncidentBundle).not.toHaveBeenCalled();
  });

  it("authenticates before discovery and refresh side effects", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const { calls } = install([row(1)]);
    const response = await GET(new Request("http://localhost/api/cron/refresh"));
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(refreshIncidentBundle).not.toHaveBeenCalled();
  });

  it("passes only eligible discovered incidents to the actual cron orchestrator", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("FIREAFTER_CRON_INCIDENT_LIMIT", "2");
    install([row(1, true), row(2), row(3)], { pageSize: 1 });
    vi.mocked(refreshIncidentBundle).mockImplementation(async databaseIncidentId => ({
      incident: { id: databaseIncidentId, recoveryScopeId: databaseIncidentId }, recommendations: [],
    }) as never);
    const response = await GET(new Request("http://localhost/api/cron/refresh", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(response.status).toBe(200);
    expect(refreshIncidentBundle).toHaveBeenNthCalledWith(1, row(2).id, { kind: "cron" }, true);
    expect(refreshIncidentBundle).toHaveBeenNthCalledWith(2, row(3).id, { kind: "cron" }, true);
    expect(refreshIncidentBundle).toHaveBeenCalledTimes(2);
  });

  it("FA15-F1 does not let repeated failures starve the next eligible incident", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("FIREAFTER_CRON_INCIDENT_LIMIT", "20");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const records = Array.from({ length: 21 }, (_, index) => row(index + 1));
    install(records);
    const attempts: string[] = [];
    vi.mocked(refreshIncidentBundle).mockImplementation(async incidentId => {
      attempts.push(incidentId);
      if (incidentId !== records[20].id) throw new Error("Test-only persistent refresh failure");
      records[20].last_refresh = "2026-09-14T00:00:00Z";
      return { incident: { id: incidentId, recoveryScopeId: incidentId }, recommendations: [] } as never;
    });

    for (let run = 0; run < 2; run++) {
      const before = attempts.length;
      const response = await GET(new Request("http://localhost/api/cron/refresh", {
        headers: { authorization: "Bearer test-cron-secret" },
      }));
      const batch = attempts.slice(before);
      expect(response.status).toBe(batch.some(id => id !== records[20].id) ? 500 : 200);
      expect(attempts.length - before).toBeLessThanOrEqual(20);
    }
    expect(attempts, "Two batches of capacity 20 must not retry the same failing twenty while starving incident 21").toContain(records[20].id);
  });
});
