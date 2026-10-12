import { beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryCapacityError } from "@/lib/inventory-error";

class MockAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

const refreshIncidentBundleMock = vi.fn();
const requireIncidentAccessMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  AuthError: MockAuthError,
  requireIncidentAccess: requireIncidentAccessMock,
}));

vi.mock("@/lib/fireafter-data", () => ({
  refreshIncidentBundle: refreshIncidentBundleMock,
  toClientDashboardBundle: (bundle: unknown) => bundle,
}));

describe("POST /api/refresh/[incidentId]", () => {
  it("returns an actionable safe capacity failure rather than a partial refresh", async () => {
    requireIncidentAccessMock.mockResolvedValue({ id: "operator" });
    const error = new InventoryCapacityError("inference_work");
    refreshIncidentBundleMock.mockRejectedValueOnce(error);
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/refresh/incident-ventura"), {
      params: Promise.resolve({ incidentId: "incident-ventura" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: error.message, code: "inference_work" });
  });
  beforeEach(() => {
    refreshIncidentBundleMock.mockReset();
    requireIncidentAccessMock.mockReset();
    requireIncidentAccessMock.mockResolvedValue({
      id: "user-1",
      email: "commander@example.com",
      organizationId: "org-1",
      role: "incident_commander",
    });
  });

  it("refreshes only after incident-scoped authorization passes", async () => {
    refreshIncidentBundleMock.mockResolvedValue({
      incident: { id: "incident-ventura" },
      sourceSnapshots: [],
      recommendations: [],
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/refresh/incident-ventura"), {
      params: Promise.resolve({ incidentId: "incident-ventura" }),
    });

    expect(response.status).toBe(200);
    expect(requireIncidentAccessMock).toHaveBeenCalledWith("incident-ventura");
    expect(refreshIncidentBundleMock).toHaveBeenCalledWith("incident-ventura", { kind: "user", actorId: "user-1", organizationId: "org-1" });
  });

  it("rejects cross-organization refreshes before live-source work starts", async () => {
    requireIncidentAccessMock.mockRejectedValueOnce(
      new MockAuthError("Incident access denied", 403),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/refresh/incident-other-org"),
      {
        params: Promise.resolve({ incidentId: "incident-other-org" }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Incident access denied",
    });
    expect(refreshIncidentBundleMock).not.toHaveBeenCalled();
  });

  it("does not expose unexpected source or persistence errors to clients", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    refreshIncidentBundleMock.mockRejectedValueOnce(
      new Error("upstream request included private diagnostic details"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/refresh/incident-ventura"),
      { params: Promise.resolve({ incidentId: "incident-ventura" }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Refresh failed. Review Operational Health and Data Source Coverage, then retry.",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("rejects cross-origin refreshes before incident authorization", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/refresh/incident-ventura", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
      {
        params: Promise.resolve({ incidentId: "incident-ventura" }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin request rejected",
    });
    expect(requireIncidentAccessMock).not.toHaveBeenCalled();
    expect(refreshIncidentBundleMock).not.toHaveBeenCalled();
  });
});
