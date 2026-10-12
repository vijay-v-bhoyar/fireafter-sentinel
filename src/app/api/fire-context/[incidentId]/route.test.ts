import { beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryCapacityError } from "@/lib/inventory-error";

class MockAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

class MockFireContextSelectionError extends Error {
  status = 409;
}

const requireIncidentAccessMock = vi.fn();
const selectIncidentFireBundleMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  AuthError: MockAuthError,
  requireIncidentAccess: requireIncidentAccessMock,
}));

vi.mock("@/lib/fireafter-data", () => ({
  FireContextSelectionError: MockFireContextSelectionError,
  selectIncidentFireBundle: selectIncidentFireBundleMock,
  toClientDashboardBundle: (bundle: unknown) => bundle,
}));

describe("POST /api/fire-context/[incidentId]", () => {
  it("returns a safe actionable inventory failure", async () => {
    const error = new InventoryCapacityError("elevation_deadline");
    selectIncidentFireBundleMock.mockRejectedValueOnce(error);
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/fire-context/incident-ventura", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceKey: "wfigs", sourceFeatureId: "fire-1" }),
    }), { params: Promise.resolve({ incidentId: "incident-ventura" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: error.message, code: "elevation_deadline" });
  });
  beforeEach(() => {
    requireIncidentAccessMock.mockReset();
    selectIncidentFireBundleMock.mockReset();
    requireIncidentAccessMock.mockResolvedValue({
      id: "user-1",
      email: "commander@example.com",
      organizationId: "org-1",
      role: "incident_commander",
    });
  });

  it("authorizes, validates, and persists a selected source candidate", async () => {
    selectIncidentFireBundleMock.mockResolvedValue({
      incident: {
        id: "incident-utah-county-ut",
        selectedFire: { name: "Iron", sourceKey: "wfigs-ytd", sourceFeatureId: "fc-1" },
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/fire-context/incident-utah-county-ut", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceKey: "wfigs-ytd", sourceFeatureId: "fc-1" }),
      }),
      { params: Promise.resolve({ incidentId: "incident-utah-county-ut" }) },
    );

    expect(response.status).toBe(200);
    expect(requireIncidentAccessMock).toHaveBeenCalledWith("incident-utah-county-ut");
    expect(selectIncidentFireBundleMock).toHaveBeenCalledWith({
      principal: { kind: "user", actorId: "user-1", organizationId: "org-1" },
      incidentId: "incident-utah-county-ut",
      sourceKey: "wfigs-ytd",
      sourceFeatureId: "fc-1",
      actorId: "user-1",
      actorName: "commander@example.com",
    });
  });

  it("rejects malformed selection before authorization or live validation", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/fire-context/incident-utah-county-ut", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceKey: "unknown", sourceFeatureId: "" }),
      }),
      { params: Promise.resolve({ incidentId: "incident-utah-county-ut" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid fire context request",
    });
    expect(requireIncidentAccessMock).not.toHaveBeenCalled();
    expect(selectIncidentFireBundleMock).not.toHaveBeenCalled();
  });

  it("rejects cross-origin selection before authorization", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/fire-context/incident-utah-county-ut", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
        body: JSON.stringify({ sourceKey: "wfigs", sourceFeatureId: "fc-1" }),
      }),
      { params: Promise.resolve({ incidentId: "incident-utah-county-ut" }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin request rejected",
    });
    expect(requireIncidentAccessMock).not.toHaveBeenCalled();
  });

  it("returns the actionable stale-candidate error without hiding it behind a generic 500", async () => {
    selectIncidentFireBundleMock.mockRejectedValueOnce(
      new MockFireContextSelectionError(
        "The selected current WFIGS fire perimeter is no longer published. Refresh candidates and choose another perimeter.",
      ),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/fire-context/incident-utah-county-ut", {
        method: "POST",
        body: JSON.stringify({ sourceKey: "wfigs", sourceFeatureId: "fc-old" }),
      }),
      { params: Promise.resolve({ incidentId: "incident-utah-county-ut" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "The selected current WFIGS fire perimeter is no longer published. Refresh candidates and choose another perimeter.",
    });
  });

  it("returns an actionable operational error without exposing provider details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    selectIncidentFireBundleMock.mockRejectedValueOnce(
      new Error("private Supabase or WFIGS provider diagnostic"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/fire-context/incident-utah-county-ut", {
        method: "POST",
        body: JSON.stringify({ sourceKey: "wfigs", sourceFeatureId: "fc-1" }),
      }),
      { params: Promise.resolve({ incidentId: "incident-utah-county-ut" }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Fire context selection failed. Review Operational Health and Data Source Coverage, then retry.",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("blocks cross-organization access before live-source work", async () => {
    requireIncidentAccessMock.mockRejectedValueOnce(
      new MockAuthError("Incident access denied", 403),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/fire-context/incident-other-org", {
        method: "POST",
        body: JSON.stringify({ sourceKey: "wfigs", sourceFeatureId: "fc-1" }),
      }),
      { params: Promise.resolve({ incidentId: "incident-other-org" }) },
    );

    expect(response.status).toBe(403);
    expect(selectIncidentFireBundleMock).not.toHaveBeenCalled();
  });
});
