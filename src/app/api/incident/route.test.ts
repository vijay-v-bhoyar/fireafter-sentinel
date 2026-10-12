import { beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryCapacityError } from "@/lib/inventory-error";
import { CountySearchUnavailableError } from "@/lib/live-sources";

class MockAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

const createIncidentBundleMock = vi.fn();
const requireCurrentUserMock = vi.fn(async () => ({
  id: "user-1",
  email: "commander@example.com",
  role: "incident_commander",
}));

vi.mock("@/lib/auth", () => ({
  AuthError: MockAuthError,
  requireCurrentUser: requireCurrentUserMock,
}));

vi.mock("@/lib/fireafter-data", () => ({
  createIncidentBundle: createIncidentBundleMock,
  toClientDashboardBundle: (bundle: unknown) => bundle,
}));

vi.mock("@/lib/error-message", () => ({
  errorMessage: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));

describe("POST /api/incident", () => {
  it("returns a safe actionable inventory failure", async () => {
    const error = new InventoryCapacityError("read_invalid");
    createIncidentBundleMock.mockRejectedValueOnce(error);
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/incident", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locationId: "ventura-ca" }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: error.message, code: "read_invalid" });
  });
  beforeEach(() => {
    createIncidentBundleMock.mockReset();
    requireCurrentUserMock.mockReset();
    requireCurrentUserMock.mockResolvedValue({
      id: "user-1",
      email: "commander@example.com",
      role: "incident_commander",
    });
  });

  it("creates incidents for authenticated responders", async () => {
    createIncidentBundleMock.mockResolvedValue({
      incident: { id: "incident-utah-county-ut" },
      recommendations: [],
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId: "utah-county-ut" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      incident: { id: "incident-utah-county-ut" },
    });
    expect(requireCurrentUserMock).toHaveBeenCalled();
    expect(createIncidentBundleMock).toHaveBeenCalledWith("utah-county-ut", expect.objectContaining({ kind: "user", actorId: "user-1" }));
  });

  it("returns 400 for malformed JSON instead of a blank server error", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid incident request",
    });
    expect(requireCurrentUserMock).not.toHaveBeenCalled();
    expect(createIncidentBundleMock).not.toHaveBeenCalled();
  });

  it("rejects oversized incident requests before authorization", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/incident", {
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
      error: "Incident request is too large",
    });
    expect(requireCurrentUserMock).not.toHaveBeenCalled();
    expect(createIncidentBundleMock).not.toHaveBeenCalled();
  });

  it("rejects location identifiers beyond the persisted field limit", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId: "x".repeat(257) }),
      }),
    );

    expect(response.status).toBe(400);
    expect(requireCurrentUserMock).not.toHaveBeenCalled();
    expect(createIncidentBundleMock).not.toHaveBeenCalled();
  });

  it("requires authentication before creating incidents", async () => {
    requireCurrentUserMock.mockRejectedValueOnce(
      new MockAuthError("Authentication required"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId: "utah-county-ut" }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
    });
    expect(createIncidentBundleMock).not.toHaveBeenCalled();
  });

  it("does not expose unexpected persistence errors to clients", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createIncidentBundleMock.mockRejectedValueOnce(
      new Error("relation public.incidents does not exist"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId: "utah-county-ut" }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Incident creation failed",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[fireafter] incident creation failed",
      "relation public.incidents does not exist",
    );
    consoleError.mockRestore();
  });

  it("returns a retryable degraded response when county search is unavailable", async () => {
    createIncidentBundleMock.mockRejectedValueOnce(new CountySearchUnavailableError());

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId: "utah-county-ut" }),
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "County search is temporarily unavailable. Retry when TIGERweb is reachable.",
      code: "county_search_unavailable",
      retryable: true,
    });
  });

  it("rejects cross-origin incident creation before parsing or authentication", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/incident", {
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
    expect(requireCurrentUserMock).not.toHaveBeenCalled();
    expect(createIncidentBundleMock).not.toHaveBeenCalled();
  });
});
