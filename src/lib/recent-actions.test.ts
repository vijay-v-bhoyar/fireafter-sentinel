import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { historyTime } from "./history-contract";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const incidentId = id(900), foreignId = id(901);
function row(n: number) {
  return { id: id(n), recommendation_id: id(800), action: "annotate", note: `Original note ${n}`,
    actor_id: null, actor_name: "Reviewer", modified_priority: null,
    created_at: `2026-10-08T00:00:00.${String(Math.floor(n / 2)).padStart(6, "0")}+00:00`,
    recommendation_snapshot: { id: "retired-recommendation", evidence: [n], nonOperational: n === 3 },
    recommendations: { incident_id: incidentId } };
}
type Row = ReturnType<typeof row>;
type Options = { rows?: Row[]; cap?: number; delay?: number; status?: number;
  change?: (result: { data: unknown[]; count: number }, page: number) => { data: unknown[]; count: number } };
async function fixture(options: Options = {}) {
  const requests: URL[] = [], timers: ReturnType<typeof setTimeout>[] = [];
  let canceled = false;
  const rows = (options.rows ?? [row(1)]).sort((a, b) => {
    const delta = historyTime(b.created_at) - historyTime(a.created_at);
    return delta === BigInt(0) ? a.id.localeCompare(b.id) : delta > 0 ? 1 : -1;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost"); requests.push(url);
    expect(request.method).toBe("GET");
    expect(url.pathname).toBe("/rest/v1/responder_actions");
    expect(url.searchParams.get("select")).toBe("*,recommendations!inner(incident_id)");
    expect(url.searchParams.get("recommendations.incident_id")).toBe(`eq.${incidentId}`);
    expect(url.searchParams.get("order")).toBe("created_at.desc,id.asc");
    expect(url.searchParams.has("recommendation_id")).toBe(false);
    let selected = rows.filter(item => item.recommendations.incident_id === incidentId);
    const condition = url.searchParams.get("or");
    if (condition) {
      const match = condition.match(/^\(created_at.lt.(.+),and\(created_at.eq.(.+),id.gt.([a-f0-9-]+)\)\)$/)!;
      expect(match).toBeTruthy(); expect(match[1]).toBe(match[2]);
      selected = selected.filter(item => historyTime(item.created_at) < historyTime(match[1]) ||
        (historyTime(item.created_at) === historyTime(match[1]) && item.id > match[3]));
    }
    const count = selected.length;
    const result = { data: selected.slice(0, Math.min(Number(url.searchParams.get("limit")), options.cap ?? 200)), count };
    const transformed = options.change?.(result, requests.length) ?? result;
    response.once("close", () => { if (!response.writableEnded) canceled = true; });
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(options.status ?? 200, { "content-type": "application/json", "content-range": `0-${Math.max(0, transformed.data.length - 1)}/${transformed.count}` });
      response.end(JSON.stringify(options.status ? { code: "42501", message: "fixture denial" } : transformed.data));
    };
    if (options.delay) timers.push(setTimeout(send, options.delay)); else send();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local port");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-test-only");
  vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "60000");
  return { requests, rows, canceled: () => canceled, close: async () => {
    timers.forEach(clearTimeout); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
beforeEach(() => { vi.resetModules(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("reads the same top 200 complete records across provider caps, microseconds and tied timestamps", async () => {
  const server = await fixture({ rows: [...Array.from({ length: 251 }, (_, n) => row(n + 1)), { ...row(600), recommendations: { incident_id: foreignId } }], cap: 7 });
  try {
    const { readRecentIncidentActions } = await import("./recent-actions");
    const result = await readRecentIncidentActions(incidentId);
    const expected = server.rows.filter(r => r.recommendations.incident_id === incidentId).slice(0, 200)
      .map(r => { const saved = { ...r } as Partial<Row>; delete saved.recommendations; return saved; });
    expect(result).toEqual(expected); expect(server.requests).toHaveLength(29);
    expect(new Set(result.map(r => r.id)).size).toBe(200);
  } finally { await server.close(); }
});
it.each([0, 1, 200])("uses one bounded request for %i records", async count => {
  const server = await fixture({ rows: Array.from({ length: count }, (_, n) => row(n + 1)) });
  try {
    const { readRecentIncidentActions } = await import("./recent-actions");
    expect(await readRecentIncidentActions(incidentId)).toHaveLength(count);
    expect(server.requests).toHaveLength(1);
  } finally { await server.close(); }
});
it("compares equal instants across timezone offsets without changing stored timestamps", async () => {
  const server = await fixture({ rows: [row(5), row(4)], change: result => ({ ...result,
    data: (result.data as Row[]).map((value, index) => ({ ...value, created_at: index === 0
      ? "2026-10-07T19:00:00.000002-05:00" : "2026-10-08T05:30:00.000002+05:30" })),
  }) });
  try {
    const { readRecentIncidentActions } = await import("./recent-actions");
    const result = await readRecentIncidentActions(incidentId);
    expect(result.map(value => value.id)).toEqual([id(4), id(5)]);
    expect(result.map(value => value.created_at)).toEqual(["2026-10-07T19:00:00.000002-05:00", "2026-10-08T05:30:00.000002+05:30"]);
  } finally { await server.close(); }
});
it.each(["foreign", "duplicate", "order", "empty", "count", "identity", "timestamp"])("rejects %s response corruption without a partial window", async defect => {
  const server = await fixture({ rows: [row(1), row(2)], cap: defect === "count" ? 1 : 200, change: (result, page) => {
    const data = structuredClone(result.data) as Row[];
    if (defect === "foreign") data[0].recommendations.incident_id = foreignId;
    if (defect === "duplicate") data[1] = data[0];
    if (defect === "order") data.reverse();
    if (defect === "identity") data[0].id = "invalid";
    if (defect === "timestamp") data[0].created_at = "2026-10-08T00:00:00.0000001Z";
    return { data: defect === "empty" ? [] : data, count: result.count + (defect === "count" && page === 2 ? 1 : 0) };
  } });
  try {
    const { readRecentIncidentActions } = await import("./recent-actions");
    await expect(readRecentIncidentActions(incidentId)).rejects.toMatchObject({ code: "read_invalid" });
  } finally { await server.close(); }
});
it("enforces the aggregate byte limit even when individual pages fit", async () => {
  const server = await fixture({ rows: Array.from({ length: 200 }, (_, n) => ({ ...row(n + 1), note: "x".repeat(45000) })), cap: 100 });
  try {
    const { readRecentIncidentActions } = await import("./recent-actions");
    await expect(readRecentIncidentActions(incidentId)).rejects.toMatchObject({ code: "read_budget" });
    expect(server.requests).toHaveLength(2);
  } finally { await server.close(); }
});
it("cancels at the real ten-second window budget with no automatic retry", async () => {
  const server = await fixture({ delay: 12000 });
  try {
    const { readRecentIncidentActions } = await import("./recent-actions");
    const start = performance.now();
    await expect(readRecentIncidentActions(incidentId)).rejects.toMatchObject({ code: "read_budget" });
    expect(performance.now() - start).toBeGreaterThanOrEqual(9900);
    expect(performance.now() - start).toBeLessThan(11500);
    await vi.waitFor(() => expect(server.canceled()).toBe(true)); expect(server.requests).toHaveLength(1);
  } finally { await server.close(); }
}, 15000);
it("does not retry a denied read, and invalid incident input sends no query", async () => {
  const server = await fixture({ status: 503 });
  try {
    const { readRecentIncidentActions } = await import("./recent-actions");
    await expect(readRecentIncidentActions("not-an-id")).rejects.toMatchObject({ code: "read_invalid" });
    expect(server.requests).toHaveLength(0);
    await expect(readRecentIncidentActions(incidentId)).rejects.toMatchObject({ code: "42501" });
    expect(server.requests).toHaveLength(1);
  } finally { await server.close(); }
});

it("honors a caller cancellation before the recent-window deadline", async () => {
  const server = await fixture({ delay: 3000 });
  try {
    const { readRecentIncidentActions } = await import("./recent-actions");
    const controller = new AbortController();
    const rejected = expect(readRecentIncidentActions(incidentId, controller.signal)).rejects.toMatchObject({ code: "read_budget" });
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    controller.abort(); await rejected;
    await vi.waitFor(() => expect(server.canceled()).toBe(true));
    expect(server.requests).toHaveLength(1);
    await expect(readRecentIncidentActions(incidentId, controller.signal)).rejects.toMatchObject({ code: "read_budget" });
    expect(server.requests).toHaveLength(1);
  } finally { await server.close(); }
});
