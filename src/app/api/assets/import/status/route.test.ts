import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), lookup: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireIncidentAccess: mocks.authorize, AuthError: class extends Error { status = 403; } }));
vi.mock("@/lib/import-operation-server", () => ({ lookupImportOperation: mocks.lookup }));
import { GET } from "./route";
import { AuthError } from "@/lib/auth";
const operationId = "10000000-0000-4000-8000-000000000001";
const request = () => new Request(`https://app.example/api/assets/import/status?incidentId=incident-a&operationId=${operationId}`);
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue({ id: "actor", organizationId: "org" }); mocks.lookup.mockResolvedValue({ receipt: null }); });
describe("FA10-R3 authenticated import status", () => {
  it("reports uncertainty, never rollback, for no committed receipt", async () => {
    const response = await GET(request());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ operationId, incidentId: "incident-a", state: "unconfirmed", receipt: null });
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith({ operationId, incidentId: "incident-a", principal: { kind: "user", actorId: "actor", organizationId: "org" } });
  });
  it("denies unauthorized lookup before calling the receipt store", async () => {
    mocks.authorize.mockRejectedValue(new AuthError("Denied", 403));
    expect((await GET(request())).status).toBe(403);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("does not echo provider errors", async () => {
    mocks.lookup.mockRejectedValue(new Error("PRIVATE"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE");
  });
  it.each(["", "?incidentId=a&operationId=invalid", `?incidentId=a&operationId=${operationId}&operationId=${operationId}`, `?incidentId=a&operationId=${operationId}&actorId=forged`])("rejects malformed/untrusted scope %s", async query => {
    expect((await GET(new Request(`https://app.example/api/assets/import/status${query}`))).status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
