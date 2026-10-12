import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ context: vi.fn(), client: vi.fn() }));
vi.mock("./fireafter-supabase", async original => ({ ...await original<typeof import("./fireafter-supabase")>(), getIncidentAuthorizationContext: mocks.context }));
vi.mock("./supabase", () => ({ getSupabaseAdminClient: mocks.client }));
import { lookupResponderCommandReceipt } from "./responder-recovery-server";
const actorId = "10000000-0000-4000-8000-000000000001", organizationId = "20000000-0000-4000-8000-000000000002";
const incidentId = "30000000-0000-4000-8000-000000000003", commandId = "40000000-0000-4000-8000-000000000004";
const recommendationId = "50000000-0000-4000-8000-000000000005", revision = "60000000-0000-4000-8000-000000000006";
const request = { recommendationId, action: "annotate", note: "Private test-only note", modifiedPriority: null };
const reference = { actor_id: actorId, organization_id: organizationId, incident_id: incidentId, command_id: commandId, expected_revision: revision, request };
const snapshot = { id: "domain-rec", incidentId: "domain-incident", assetId: "domain-asset", domainActionId: `action-command-${actorId}-${commandId}` };
const payload = { commandId, expectedRevision: revision, domainAuditEventId: `audit-command-${actorId}-${commandId}`, domainIncidentId: "domain-incident", domainRecommendationId: "domain-rec", recommendationSnapshot: { ...snapshot, domainActionId: undefined }, action: request.action, note: request.note };
const response = {
  action: { id: "70000000-0000-4000-8000-000000000007", actor_id: actorId, recommendation_id: recommendationId, action: request.action, note: request.note, modified_priority: null, actor_name: "Test operator", recommendation_snapshot: snapshot, created_at: "2026-09-14T10:00:00Z" },
  auditEvent: { id: "80000000-0000-4000-8000-000000000008", actor_id: actorId, incident_id: incidentId, recommendation_id: recommendationId, event_type: "RecommendationAnnotated", actor_name: "Test operator", summary: "Test-only annotation", payload, created_at: "2026-09-14T10:00:00Z" },
};
const input = { actorId, organizationId, commandId, incidentId: "domain-incident" };
let row: unknown, receipt: unknown, rpcError: string | null, calls: { url: URL; body: unknown; method: string }[];
beforeEach(() => {
  vi.clearAllMocks(); row = structuredClone(reference); receipt = structuredClone(response); rpcError = null; calls = [];
  mocks.context.mockResolvedValue({ databaseIncidentId: incidentId, domainIncidentId: "domain-incident", organizationId });
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url)); calls.push({ url: parsed, body: init?.body ? JSON.parse(String(init.body)) : null, method: init?.method ?? "GET" });
    if (parsed.pathname.endsWith("/responder_command_receipts")) return Response.json(row === null ? [] : [row]);
    expect(parsed.pathname).toBe("/rest/v1/rpc/fireafter_record_responder_command");
    return rpcError ? Response.json({ code: rpcError, message: "PRIVATE SQL diagnostic" }, { status: 400 }) : Response.json(receipt);
  };
  mocks.client.mockReturnValue(createClient("https://database.example", "test-only-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchImpl } }));
});
describe("FA10 service receipt lookup with real SDK and mapper, test-only HTTP", () => {
  it("filters every identity, rechecks through the null-row RPC, and returns the canonical historical action", async () => {
    const result = await lookupResponderCommandReceipt(input);
    expect(result).toMatchObject({ databaseIncidentId: incidentId, canonicalIncidentId: "domain-incident" });
    expect(result.receipt?.id).toBe(snapshot.domainActionId); expect(result.receipt?.note).toBe(request.note);
    for (const [column, value] of Object.entries({ actor_id: actorId, organization_id: organizationId, incident_id: incidentId, command_id: commandId })) expect(calls[0].url.searchParams.get(column)).toBe(`eq.${value}`);
    expect(calls[0].url.searchParams.get("select")).not.toContain("response");
    expect(calls[1].body).toEqual({ p_command_id: commandId, p_actor_id: actorId, p_organization_id: organizationId, p_expected_revision: revision, p_request: request, p_action: null, p_audit_event: null });
    expect(calls).toHaveLength(2);
  });
  it("returns no receipt only on explicit null without attempting a command", async () => {
    row = null; expect(await lookupResponderCommandReceipt(input)).toEqual({ databaseIncidentId: incidentId, canonicalIncidentId: "domain-incident", receipt: null }); expect(calls).toHaveLength(1);
  });
  it("rejects foreign organization before service access", async () => {
    await expect(lookupResponderCommandReceipt({ ...input, organizationId: actorId })).rejects.toMatchObject({ code: "FA401" }); expect(calls).toHaveLength(0);
  });
  it("resolves a database alias to the same canonical receipt without rewriting history", async () => {
    const result = await lookupResponderCommandReceipt({ ...input, incidentId });
    expect(mocks.context).toHaveBeenCalledWith(incidentId);
    expect(result).toMatchObject({ databaseIncidentId: incidentId, canonicalIncidentId: "domain-incident", receipt: { id: snapshot.domainActionId } });
  });
  it("rejects a final RPC receipt with the wrong database incident even if domain metadata matches", async () => {
    receipt = { ...response, auditEvent: { ...response.auditEvent, incident_id: actorId } };
    await expect(lookupResponderCommandReceipt(input)).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each(["actor_id", "organization_id", "incident_id", "command_id", "expected_revision"])("rejects malformed/wrong-scope preliminary %s", async field => {
    row = { ...reference, [field]: field === "expected_revision" ? "not-a-uuid" : revision };
    await expect(lookupResponderCommandReceipt(input)).rejects.toMatchObject({ code: "unavailable" }); expect(calls).toHaveLength(1);
  });
  it.each(["FA401", "FA408", "FA409", "PGRST202"])("does not disclose preliminary content after RPC failure %s", async code => {
    rpcError = code;
    await expect(lookupResponderCommandReceipt(input)).rejects.toMatchObject({ code: code === "PGRST202" ? "unavailable" : code });
    await expect(lookupResponderCommandReceipt(input)).rejects.not.toThrow("PRIVATE");
  });
  it.each([null, {}, { ...response, auditEvent: { ...response.auditEvent, payload: { ...payload, domainIncidentId: "foreign" } } }])("rejects missing or inconsistent final receipt %j", async value => {
    receipt = value; await expect(lookupResponderCommandReceipt(input)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("fails closed without configured service access", async () => {
    mocks.client.mockReturnValue(null); await expect(lookupResponderCommandReceipt(input)).rejects.toMatchObject({ code: "unavailable" });
  });
});
