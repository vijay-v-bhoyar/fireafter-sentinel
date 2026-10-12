import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), lookup: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireIncidentAccess: mocks.authorize, AuthError: class extends Error { constructor(message: string, readonly status: number) { super(message); } } }));
vi.mock("@/lib/responder-recovery-server", () => ({ lookupResponderCommandReceipt: mocks.lookup }));
import { GET } from "./route";
import { AuthError } from "@/lib/auth";
const commandId = "10000000-0000-4000-8000-000000000001";
const query = `?incidentId=incident-a&commandId=${commandId}`;
const headers = { "x-fireafter-actor": "actor-a", "x-fireafter-organization": "org-a" };
const request = (suffix = query, auth = headers) => new Request(`https://app.example/api/actions/status${suffix}`, { headers: auth });
const identity = { databaseIncidentId: "20000000-0000-4000-8000-000000000002", canonicalIncidentId: "incident-a" };
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue({ id: "actor-a", organizationId: "org-a" }); mocks.lookup.mockResolvedValue({ ...identity, receipt: null }); });
describe("FA10 authenticated decision recovery route", () => {
  it("reports explicit absence as uncertainty, never rollback", async () => {
    const response = await GET(request());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ...identity, commandId, incidentId: "incident-a", state: "unconfirmed", receipt: null });
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith({ commandId, incidentId: "incident-a", actorId: "actor-a", organizationId: "org-a" });
  });
  it("returns canonical identity separately from the requested alias", async () => {
    mocks.lookup.mockResolvedValue({ ...identity, receipt: { id: "canonical-action" } });
    const response = await GET(request(`?incidentId=${identity.databaseIncidentId}&commandId=${commandId}`));
    expect(await response.json()).toEqual({ ...identity, commandId, incidentId: identity.databaseIncidentId, state: "committed", receipt: { id: "canonical-action" } });
  });
  it.each([401, 403, 404])("preserves authorization denial %s without reading receipts", async status => {
    mocks.authorize.mockRejectedValue(new AuthError("Denied", status));
    const response = await GET(request());
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it.each([{}, { ...headers, "x-fireafter-actor": "previous-actor" }, { ...headers, "x-fireafter-organization": "previous-org" }])("rejects missing or switched checkpoint authority %j", async auth => {
    const response = await GET(request(query, auth as typeof headers));
    expect(response.status).toBe(403); expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it.each(["", "?incidentId=a&commandId=bad", `${query}&commandId=${commandId}`, `${query}&actorId=forged`, `${query}&incidentId=other`])("rejects invalid query %s", async suffix => {
    expect((await GET(request(suffix))).status).toBe(400); expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it("does not return raw provider diagnostics", async () => {
    mocks.lookup.mockRejectedValue(new Error("PRIVATE_DATABASE_ERROR"));
    const response = await GET(request());
    expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("PRIVATE");
  });
});
