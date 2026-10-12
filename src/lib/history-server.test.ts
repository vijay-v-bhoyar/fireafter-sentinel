import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { readHistoryPage, readHistoryRecord } from "./history-server";
import { HistoryCursorSchema, historyTime } from "./history-contract";
const mocks = vi.hoisted(() => ({ client: vi.fn(), context: vi.fn() }));
vi.mock("./supabase", () => ({ getSupabaseAdminClient: mocks.client }));
vi.mock("./fireafter-supabase", () => ({ getIncidentAuthorizationContext: mocks.context }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const incidentId = id(900), org = id(901);
const context = { databaseIncidentId: incidentId, domainIncidentId: "county-history", organizationId: org };
const user = { id: id(902), organizationId: org, role: "analyst" as const, email: "reviewer@example.test" };
const base = { incidentId: "county-history", lane: "actions" as const, limit: "25" };
type Row = Record<string, unknown> & { id: string; created_at: string };
function action(n: number): Row {
  return { id: id(n), created_at: `2026-09-14T00:00:00.${String(n).padStart(6, "0")}+00:00`,
    recommendation_id: id(800), action: "annotate", note: "Historical note", actor_id: id(902), actor_name: "County reviewer", modified_priority: null,
    recommendation_snapshot: { id: "retired-recommendation", assetName: "County crossing", historicalField: n },
    recommendations: { incident_id: incidentId } };
}
function audit(n: number): Row {
  return { id: id(n), created_at: action(n).created_at, incident_id: incidentId, recommendation_id: id(800),
    event_type: "RecommendationAnnotated", actor_id: id(902), actor_name: "County reviewer", summary: "Decision recorded", payload: { historicalField: n } };
}
let rows: Row[], requests: URL[], cap: number, responseOverride: ((rows: Row[]) => Row[]) | undefined;
beforeEach(() => {
  vi.clearAllMocks(); rows = Array.from({ length: 251 }, (_, i) => action(251 - i)); requests = []; cap = 50; responseOverride = undefined;
  mocks.context.mockResolvedValue(context);
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); requests.push(url);
    expect(["/rest/v1/responder_actions", "/rest/v1/audit_events"]).toContain(url.pathname);
    expect(url.searchParams.get(url.pathname.endsWith("responder_actions") ? "recommendations.incident_id" : "incident_id")).toBe(`eq.${incidentId}`);
    const recordId = url.searchParams.get("id")?.replace(/^eq\./, "");
    if (!recordId) expect(url.searchParams.get("order")).toBe("created_at.desc,id.desc");
    if (!recordId) expect(url.searchParams.get("select")).not.toMatch(/(?:^|,)(?:note|payload|recommendation_snapshot|summary)(?:,|$)/);
    let selected = rows;
    if (recordId) selected = selected.filter(row => row.id === recordId);
    const condition = url.searchParams.get("or");
    if (condition) {
      const match = condition.match(/^\(created_at.lt.(.+),and\(created_at.eq.(.+),id.lt.([a-f0-9-]+)\)\)$/)!;
      expect(match).toBeTruthy(); expect(match[1]).toBe(match[2]);
      selected = selected.filter(row => historyTime(row.created_at) < historyTime(match[1]) ||
        (historyTime(row.created_at) === historyTime(match[1]) && row.id < match[3]));
    }
    const count = selected.length;
    selected = selected.slice(0, recordId ? 1 : Math.min(Number(url.searchParams.get("limit")), cap));
    if (!recordId) selected = selected.map(row => url.pathname.endsWith("responder_actions")
      ? { id: row.id, created_at: row.created_at, actor_id: row.actor_id, actor_name: row.actor_name, action: row.action,
        recommendations: row.recommendations, command_reference: (row.recommendation_snapshot as Record<string, unknown>).domainActionId ?? null }
      : { id: row.id, created_at: row.created_at, actor_id: row.actor_id, actor_name: row.actor_name, incident_id: row.incident_id,
        event_type: row.event_type, command_reference: (row.payload as Record<string, unknown>).commandId ?? null });
    return Response.json(responseOverride ? responseOverride(selected) : selected,
      { headers: { "content-range": `0-${Math.max(0, selected.length - 1)}/${count}` } });
  };
  mocks.client.mockReturnValue(createClient("https://history-fixture.invalid", "test-only", { auth: { persistSession: false }, global: { fetch: fetcher } }));
});
afterEach(() => vi.restoreAllMocks());
describe("FA10 complete retained history through the real PostgREST SDK (fixture transport, not SQL)", () => {
  it("review: finds producer-shaped command IDs for every authorized actor", async () => {
    const commandId = id(700);
    rows = [2, 1].map(n => ({ ...action(n), actor_id: id(710 + n), recommendation_snapshot: { domainActionId: `action-command-${id(710 + n)}-${commandId}` } }));
    const page = await readHistoryPage({ ...base, commandId }, user);
    expect(page.entries.map(entry => entry.id)).toEqual([id(2), id(1)]);
  });
  it("review: retains records whose real note quotes a fixture marker", async () => {
    rows = [{ ...action(1), note: "Discussed fireafter browser smoke during incident review" }];
    expect((await readHistoryPage(base, user)).entries).toHaveLength(1);
  });
  it("review: oversized evidence cannot block the listing cursor", async () => {
    rows = [{ ...action(2), note: "x".repeat(2 * 1024 * 1024) }, action(1)];
    const page = await readHistoryPage({ ...base, limit: "1" }, user);
    expect(page.entries.map(entry => entry.id)).toEqual([id(2)]); expect(page.nextCursor).not.toBeNull();
    const record = await readHistoryRecord({ incidentId: base.incidentId, lane: "actions", recordId: id(2) }, user);
    expect(record.record.details.note).toBe(rows[0].note);
    const older = await readHistoryPage({ ...base, limit: "1", cursor: page.nextCursor! }, user);
    expect(older.entries.map(entry => entry.id)).toEqual([id(1)]);
  });
  it("review: preserves nullable recorded actor IDs, not only display names", async () => {
    rows = [{ ...action(1), actor_id: id(777) }];
    expect((await readHistoryPage(base, user)).entries[0]).toHaveProperty("actorId", id(777));
  });
  it.each(["actions", "audit"] as const)("retrieves every %s record beyond old caps despite a smaller provider cap", async lane => {
    if (lane === "audit") rows = Array.from({ length: 251 }, (_, i) => audit(251 - i));
    cap = 7;
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = await readHistoryPage({ ...base, lane, cursor }, user);
      seen.push(...page.entries.map(entry => entry.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(rows.map(row => row.id)); expect(new Set(seen).size).toBe(251);
    expect(requests.length).toBe(36); expect(mocks.context).toHaveBeenCalledTimes(72);
  });
  it("preserves distinct IDs with identical timestamps and content, without invented audit pairs", async () => {
    rows = [action(2), action(1)].map(row => ({ ...row, created_at: "2026-09-14T00:00:00.000001Z" }));
    const first = await readHistoryPage({ ...base, limit: "1" }, user);
    const next = await readHistoryPage({ ...base, limit: "1", cursor: first.nextCursor! }, user);
    expect([...first.entries, ...next.entries].map(row => row.id)).toEqual([id(2), id(1)]);
    const original = await readHistoryRecord({ incidentId: base.incidentId, lane: "actions", recordId: id(2) }, user);
    expect(original.record.details).not.toHaveProperty("auditEvent");
    expect(original.record.details.recommendationSnapshot).toEqual(rows[0].recommendation_snapshot);
  });
  it("retains and labels explicit non-operational provenance without losing records", async () => {
    rows = [{ ...action(2), note: "training_fixture" }, action(1)];
    // The existing policy's explicit marker is used rather than invented field accuracy.
    rows[0].recommendation_snapshot = { nonOperational: true };
    const page = await readHistoryPage({ ...base, limit: "1" }, user);
    expect(page.entries).toHaveLength(1); expect(page.nextCursor).not.toBeNull();
    const record = await readHistoryRecord({ incidentId: base.incidentId, lane: "actions", recordId: id(2) }, user);
    expect(record.record.provenanceFlag).toBe(true); expect(record.record.details.recommendationSnapshot).toEqual(rows[0].recommendation_snapshot);
  });
  it("preserves original evidence and redacts FIRMS credentials without mutating rows", async () => {
    rows = [{ ...audit(1), payload: { source: "https://firms.modaps.eosdis.nasa.gov/api/area/csv/SECRET/VIIRS/1", note: "Keep historical wording" } }];
    const saved = structuredClone(rows);
    const page = await readHistoryRecord({ incidentId: base.incidentId, lane: "audit", recordId: id(1) }, user);
    expect(JSON.stringify(page)).not.toContain("SECRET"); expect(page.record.details.payload).toMatchObject({ note: "Keep historical wording" }); expect(rows).toEqual(saved);
  });
  it.each([null, { ...context, organizationId: id(909) }])("denies missing/foreign incident before reading history", async value => {
    mocks.context.mockResolvedValue(value); await expect(readHistoryPage(base, user)).rejects.toMatchObject({ status: value ? 403 : 404 }); expect(requests).toHaveLength(0);
  });
  it.each(["viewer", null] as const)("denies role %s before service reads", async role => {
    await expect(readHistoryPage(base, { ...user, role })).rejects.toMatchObject({ status: 403 }); expect(requests).toHaveLength(0);
  });
  it("rejects an observed ownership change before publication", async () => {
    mocks.context.mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, organizationId: id(909) });
    await expect(readHistoryPage(base, user)).rejects.toMatchObject({ status: 403 });
  });
  it.each(["incidentId", "lane", "commandId"])("rejects cursor scope mismatch: %s", async field => {
    const cursor = { version: 1, incidentId, lane: "actions", commandId: null, createdAt: action(5).created_at, id: id(5),
      [field]: field === "lane" ? "audit" : id(909) };
    await expect(readHistoryPage({ ...base, cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") }, user)).rejects.toMatchObject({ status: 400 }); expect(requests).toHaveLength(0);
  });
  it.each(["not-json", "e30"])("rejects malformed cursor %s", async cursor => {
    await expect(readHistoryPage({ ...base, cursor }, user)).rejects.toMatchObject({ status: 400 }); expect(requests).toHaveLength(0);
  });
  it.each(["duplicate", "wrong-parent", "wrong-order", "invalid-time", "oversized"])("fails closed for %s provider data", async failure => {
    responseOverride = data => failure === "duplicate" ? [data[0], data[0]] : failure === "wrong-parent" ? [{ ...data[0], recommendations: { incident_id: id(999) } }]
      : failure === "wrong-order" ? [...data].reverse() : failure === "invalid-time" ? [{ ...data[0], created_at: "bad" }]
        : [{ ...data[0], actor_name: "x".repeat(2 * 1024 * 1024) }];
    await expect(readHistoryPage(base, user)).rejects.toMatchObject({ status: 503 });
  });
  it.each(["actions", "audit"] as const)("filters %s by exact command UUID", async lane => {
    const commandId = id(600);
    rows = lane === "actions" ? [{ ...action(1), recommendation_snapshot: { domainActionId: `action-command-${user.id}-${commandId}` } }]
      : [{ ...audit(1), payload: { commandId } }];
    const page = await readHistoryPage({ ...base, lane, commandId }, user);
    expect(page.entries).toHaveLength(1);
    expect(requests[0].searchParams.get(lane === "actions" ? "recommendation_snapshot->>domainActionId" : "payload->>commandId"))
      .toBe(lane === "actions" ? `like.action-command-%-${commandId}` : `eq.${commandId}`);
  });
  it("validates the cursor timestamp without rounding microseconds", () => {
    expect(historyTime("2026-09-14T00:00:00.000002Z") - historyTime("2026-09-14T00:00:00.000001+00:00")).toBe(BigInt(1));
    expect(HistoryCursorSchema.safeParse({ createdAt: "invalid" }).success).toBe(false);
  });
  it.each(["actions", "audit"] as const)("denies foreign record evidence in %s", async lane => {
    rows = lane === "actions" ? [{ ...action(1), recommendations: { incident_id: id(999) } }] : [{ ...audit(1), incident_id: id(999) }];
    await expect(readHistoryRecord({ incidentId: base.incidentId, lane, recordId: id(1) }, user)).rejects.toMatchObject({ status: 503 });
  });
  it("denies evidence publication after observed ownership loss", async () => {
    mocks.context.mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, organizationId: id(999) });
    await expect(readHistoryRecord({ incidentId: base.incidentId, lane: "actions", recordId: id(1) }, user)).rejects.toMatchObject({ status: 403 });
  });
  it("keeps a legacy null actor ID without inferring it from the name", async () => {
    rows = [{ ...action(1), actor_id: null }];
    expect((await readHistoryRecord({ incidentId: base.incidentId, lane: "actions", recordId: id(1) }, user)).record.actorId).toBeNull();
  });
  it("fails closed above the evidence reader limit while the listing remains reachable", async () => {
    rows = [{ ...action(1), note: "x".repeat(8 * 1024 * 1024) }];
    expect((await readHistoryPage(base, user)).entries).toHaveLength(1);
    await expect(readHistoryRecord({ incidentId: base.incidentId, lane: "actions", recordId: id(1) }, user)).rejects.toMatchObject({ status: 413 });
  });
});
