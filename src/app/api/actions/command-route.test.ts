import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/fireafter-data", () => ({ recordResponderAction: mocks.record }));
vi.mock("@/lib/auth", () => ({
  AuthError: class extends Error {
    constructor(message: string, readonly status = 401) { super(message); }
  }, requireRecommendationAccess: mocks.authorize,
}));
const command = {
  commandId: "d5554057-33bc-4e55-8d4a-2a4421eab174",
  expectedRevision: "0ca1f8d8-a8bb-440a-a4bf-ddbbf31a0069",
  recommendationId: "rec-test", action: "accept", note: "Reviewed evidence",
};
async function post(body: unknown) {
  const { POST } = await import("./route");
  return POST(new Request("http://localhost/api/actions", {
    method: "POST", headers: { "content-type": "application/json", "x-fireafter-actor": "actor", "x-fireafter-organization": "org" }, body: JSON.stringify(body),
  }));
}
describe("FA10 responder command API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({ id: "actor", email: "actor@example.com", organizationId: "org" });
    mocks.record.mockResolvedValue({ id: "stored-action" });
  });
  it.each(["commandId", "expectedRevision"])("rejects omitted %s before authority or writes", async (key) => {
    const body: Record<string, unknown> = { ...command }; delete body[key];
    expect((await post(body)).status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("preserves the client command and displayed revision while stamping the actor", async () => {
    expect((await post({ ...command, actorId: "forged" })).status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({
      ...command, actorId: "actor", actorOrganizationId: "org",
    }));
  });
  it.each([{ id: "switched-actor", organizationId: "org" }, { id: "actor", organizationId: "switched-org" }])("rejects a session switch before recording %j", async user => {
    mocks.authorize.mockResolvedValue(user);
    const response = await post(command);
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it.each([
    { action: "modify", note: "", modifiedPriority: "High" },
    { action: "modify", note: "reason" },
    { action: "accept", modifiedPriority: "High" },
  ])("rejects inconsistent modification semantics %j", async (overrides) => {
    expect((await post({ ...command, ...overrides })).status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it.each([[401, "AUTH_REQUIRED"], [403, "FA401"], [404, "NOT_FOUND"]] as const)(
    "preserves a route-level %s denial through the real command transport", async (status, code) => {
      const { AuthError } = await import("@/lib/auth");
      const { sendResponderCommand } = await import("@/lib/responder-command-client");
      mocks.authorize.mockRejectedValue(new AuthError("Access rejected", status));
      const response = await post(command);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.clone().json()).toMatchObject({ code });
      await expect(sendResponderCommand({ ...command, action: "accept" }, vi.fn().mockResolvedValue(response)))
        .rejects.toMatchObject({ code, status });
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );
});
