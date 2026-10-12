import { beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryCapacityError } from "@/lib/inventory-error";

class MockAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

const commandFields = { commandId: "d5554057-33bc-4e55-8d4a-2a4421eab174", expectedRevision: "0ca1f8d8-a8bb-440a-a4bf-ddbbf31a0069" };
const recordResponderActionMock = vi.fn();
const requireRecommendationAccessMock = vi.fn(async () => ({
  id: "user-1",
  email: "commander@example.com",
  organizationId: "org-1",
  role: "incident_commander",
}));

vi.mock("@/lib/auth", () => ({
  AuthError: MockAuthError,
  requireRecommendationAccess: requireRecommendationAccessMock,
}));

vi.mock("@/lib/fireafter-data", () => ({
  recordResponderAction: recordResponderActionMock,
}));

describe("POST /api/actions", () => {
  beforeEach(() => {
    recordResponderActionMock.mockReset();
    requireRecommendationAccessMock.mockReset();
    requireRecommendationAccessMock.mockResolvedValue({
      id: "user-1",
      email: "commander@example.com",
      organizationId: "org-1",
      role: "incident_commander",
    });
  });

  it("records responder actions with the authenticated actor", async () => {
    recordResponderActionMock.mockResolvedValue({
      id: "action-1",
      action: "accept",
      actorName: "commander@example.com",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-fireafter-actor": "user-1", "x-fireafter-organization": "org-1" },
        body: JSON.stringify({ ...commandFields,
          recommendationId: "rec-1",
          action: "accept",
          note: "Field crew assigned.",
          actorName: "client supplied",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "action-1",
      actorName: "commander@example.com",
    });
    expect(recordResponderActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendationId: "rec-1",
        action: "accept",
        note: "Field crew assigned.",
        actorId: "user-1",
        actorName: "commander@example.com",
        actorOrganizationId: "org-1",
      }),
    );
    expect(requireRecommendationAccessMock).toHaveBeenCalledWith("rec-1");
    expect(recordResponderActionMock.mock.calls[0][0]).not.toMatchObject({
      actorName: "client supplied",
    });
  });

  it.each(["read_generation", "read_unverified", "read_invalid"] as const)("returns safe actionable 503 for %s", async (code) => {
    const error = new InventoryCapacityError(code);
    recordResponderActionMock.mockRejectedValueOnce(error);
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "x-fireafter-actor": "user-1", "x-fireafter-organization": "org-1" }, body: JSON.stringify({ ...commandFields, recommendationId: "rec-1", action: "annotate" }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: error.message, code });
    expect(requireRecommendationAccessMock).toHaveBeenCalledWith("rec-1");
  });

  it("returns 400 for malformed JSON instead of a blank server error", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid responder action",
    });
    expect(requireRecommendationAccessMock).not.toHaveBeenCalled();
    expect(recordResponderActionMock).not.toHaveBeenCalled();
  });

  it("rejects oversized action requests before authorization", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(32 * 1024 + 1),
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Responder action is too large",
    });
    expect(requireRecommendationAccessMock).not.toHaveBeenCalled();
    expect(recordResponderActionMock).not.toHaveBeenCalled();
  });

  it("rejects action notes beyond the persisted field limit", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...commandFields,
          recommendationId: "rec-1",
          action: "annotate",
          note: "x".repeat(2001),
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(requireRecommendationAccessMock).not.toHaveBeenCalled();
    expect(recordResponderActionMock).not.toHaveBeenCalled();
  });

  it("keeps auth failures explicit for unauthenticated writes", async () => {
    requireRecommendationAccessMock.mockRejectedValueOnce(
      new MockAuthError("Authentication required"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...commandFields,
          recommendationId: "rec-1",
          action: "accept",
          note: "Smoke check.",
        }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
    expect(recordResponderActionMock).not.toHaveBeenCalled();
  });

  it("keeps cross-incident authorization failures explicit", async () => {
    requireRecommendationAccessMock.mockRejectedValueOnce(
      new MockAuthError("Incident access denied", 403),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...commandFields,
          recommendationId: "rec-other-org",
          action: "accept",
          note: "Should be denied.",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Incident access denied",
      code: "FA401",
    });
    expect(recordResponderActionMock).not.toHaveBeenCalled();
  });

  it("does not expose unexpected persistence errors to clients", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordResponderActionMock.mockRejectedValueOnce(
      new Error("duplicate key value violates unique constraint"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-fireafter-actor": "user-1", "x-fireafter-organization": "org-1" },
        body: JSON.stringify({ ...commandFields,
          recommendationId: "rec-1",
          action: "accept",
          note: "Reviewed.",
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Action failed. Review Operational Health and History & Audit, then retry.",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("rejects cross-origin requests before parsing or authorization", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/actions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin request rejected",
    });
    expect(requireRecommendationAccessMock).not.toHaveBeenCalled();
    expect(recordResponderActionMock).not.toHaveBeenCalled();
  });
});
