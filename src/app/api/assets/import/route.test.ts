import { beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryCapacityError } from "@/lib/inventory-error";
import { BundleWriteError } from "@/lib/bundle-write";
import type { AuditEvent, Asset, Recommendation } from "@/lib/types";

class MockAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

const operationId = "10000000-0000-4000-8000-000000000001";
const importIncidentAssetsMock = vi.fn();
const requireIncidentAccessMock = vi.fn(async () => ({
  id: "user-1",
  email: "commander@example.com",
  organizationId: "org-1",
  role: "incident_commander",
}));

vi.mock("@/lib/auth", () => ({
  AuthError: MockAuthError,
  requireIncidentAccess: requireIncidentAccessMock,
}));

vi.mock("@/lib/fireafter-data", () => ({
  importIncidentAssets: importIncidentAssetsMock,
  toClientDashboardBundle: (bundle: unknown) => bundle,
}));

describe("POST /api/assets/import", () => {
  it("returns a safe actionable inventory failure", async () => {
    const error = new InventoryCapacityError("read_budget");
    importIncidentAssetsMock.mockRejectedValueOnce(error);
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/assets/import", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId, incidentId: "incident-ventura", fileName: "assets.csv", content: "name,lat,lon" }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: error.message, code: "read_budget" });
  });
  beforeEach(() => {
    importIncidentAssetsMock.mockReset();
    requireIncidentAccessMock.mockReset();
    requireIncidentAccessMock.mockResolvedValue({
      id: "user-1",
      email: "commander@example.com",
      organizationId: "org-1",
      role: "incident_commander",
    });
  });

  it.each([
    ["cross-origin", 403], ["invalid-json", 400], ["invalid-schema", 400],
    ["too-large", 413], ["encoded", 415], ["inventory", 503],
    ["auth", 401], ["bundle-conflict", 409], ["failure", 500], ["success", 200],
  ] as const)("FA10 response is non-cacheable for %s", async (variant, status) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    let body = JSON.stringify({ operationId, incidentId: "incident-ventura", fileName: "assets.csv", content: "name,lat,lon\nA,34.4,-119.2" });
    if (variant === "cross-origin") headers.origin = "https://attacker.example";
    if (variant === "invalid-json") body = "{";
    if (variant === "invalid-schema") body = "{}";
    if (variant === "too-large") headers["content-length"] = "1100001";
    if (variant === "encoded") headers["content-encoding"] = "gzip";
    if (variant === "inventory") importIncidentAssetsMock.mockRejectedValueOnce(new InventoryCapacityError("read_budget"));
    if (variant === "auth") requireIncidentAccessMock.mockRejectedValueOnce(new MockAuthError("Authentication required"));
    if (variant === "bundle-conflict") importIncidentAssetsMock.mockRejectedValueOnce(new BundleWriteError("FB409"));
    if (variant === "failure") importIncidentAssetsMock.mockRejectedValueOnce(new Error("private provider diagnostic"));
    if (variant === "success") importIncidentAssetsMock.mockResolvedValueOnce({ operationId, assets: [], auditEvent: null, bundle: null, importErrors: ["No valid records"], importOutcome: { state: "no_changes", refresh: "not_attempted" } });
    const { POST } = await import("./route");
    const response = await POST(new Request("https://app.example/api/assets/import", { method: "POST", headers, body }));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("private provider diagnostic");
    if (["cross-origin", "invalid-json", "invalid-schema", "too-large", "encoded"].includes(variant)) {
      expect(requireIncidentAccessMock).not.toHaveBeenCalled();
      expect(importIncidentAssetsMock).not.toHaveBeenCalled();
    }
  });

  it("returns imported assets plus a refreshed dashboard bundle", async () => {
    const importedAsset = asset();
    const auditEvent = assetImportAuditEvent();
    const recommendation = recommendationForAsset(importedAsset);
    importIncidentAssetsMock.mockResolvedValue({
      assets: [importedAsset],
      auditEvent,
      importErrors: [],
      bundle: {
        incident: {
          id: "incident-ventura",
          locationId: "ventura-ca",
          county: "Ventura County",
          state: "CA",
          title: "Ventura Fire",
          code: "CA-FA-06111-001",
          status: "Storm Watch",
          stormWindow: "Next 48-72 hrs",
          rainfallForecast: "2.05 in forecast total rainfall",
          lastRefresh: "10:24 AM PDT",
          dataFreshness: "High",
          activeAlerts: 1,
          selectedFire: {
            name: "Current WFIGS Fire",
            acres: 1200,
            perimeterUpdated: "Jun 28, 2026",
            source: "NIFC WFIGS",
          },
        },
        locations: [],
        assets: [importedAsset],
        sourceSnapshots: [],
        recommendations: [recommendation],
        actions: [],
        auditEvents: [auditEvent],
        currentUser: {
          id: "user-1",
          email: "commander@example.com",
          role: "incident_commander",
        },
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/assets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId,
          incidentId: "incident-ventura",
          fileName: "assets.csv",
          content: "name,type,lat,lon\nSR-33 @ Creek,Culvert,34.4,-119.2",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      assets: [{ id: importedAsset.id }],
      auditEvent: { id: auditEvent.id },
      importErrors: [],
      bundle: {
        recommendations: [{ id: recommendation.id }],
      },
    });
    expect(importIncidentAssetsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "incident-ventura",
        fileName: "assets.csv",
        actorName: "commander@example.com",
        actorOrganizationId: "org-1",
      }),
      expect.any(AbortSignal),
    );
    expect(requireIncidentAccessMock).toHaveBeenCalledWith("incident-ventura");
  });

  it("rejects unauthenticated imports before touching asset persistence", async () => {
    requireIncidentAccessMock.mockRejectedValueOnce(
      new MockAuthError("Authentication required"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/assets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId,
          incidentId: "incident-ventura",
          fileName: "assets.csv",
          content: "name,type,lat,lon\nSR-33 @ Creek,Culvert,34.4,-119.2",
        }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
    });
    expect(importIncidentAssetsMock).not.toHaveBeenCalled();
  });

  it("rejects cross-organization imports before touching asset persistence", async () => {
    requireIncidentAccessMock.mockRejectedValueOnce(
      new MockAuthError("Incident access denied", 403),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/assets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId,
          incidentId: "incident-other-org",
          fileName: "assets.csv",
          content: "name,type,lat,lon\nSR-33 @ Creek,Culvert,34.4,-119.2",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Incident access denied",
    });
    expect(importIncidentAssetsMock).not.toHaveBeenCalled();
  });

  it("does not expose unexpected persistence errors to clients", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    importIncidentAssetsMock.mockRejectedValueOnce(
      new Error("permission denied for table assets"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/assets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId,
          incidentId: "incident-ventura",
          fileName: "assets.csv",
          content: "name,type,lat,lon\nSR-33 @ Creek,Culvert,34.4,-119.2",
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Asset import outcome is unconfirmed. Check History and Operational Health before resubmitting; a failed response does not prove rollback.",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("returns 400 for malformed JSON instead of a blank server error", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/assets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid asset import",
    });
    expect(requireIncidentAccessMock).not.toHaveBeenCalled();
    expect(importIncidentAssetsMock).not.toHaveBeenCalled();
  });

  it("rejects oversized imports before authorization or persistence", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/assets/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(1_100_000 + 1),
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Asset import is too large",
    });
    expect(requireIncidentAccessMock).not.toHaveBeenCalled();
    expect(importIncidentAssetsMock).not.toHaveBeenCalled();
  });

  it("rejects parsed import content beyond the supported character limit", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/assets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId,
          incidentId: "incident-ventura",
          fileName: "assets.csv",
          content: "x".repeat(1_000_001),
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(requireIncidentAccessMock).not.toHaveBeenCalled();
    expect(importIncidentAssetsMock).not.toHaveBeenCalled();
  });

  it("rejects cross-origin imports before reading the request body", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/assets/import", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin request rejected",
    });
    expect(requireIncidentAccessMock).not.toHaveBeenCalled();
    expect(importIncidentAssetsMock).not.toHaveBeenCalled();
  });
});

function asset(): Asset {
  return {
    id: "asset-1",
    incidentId: "incident-ventura",
    name: "SR-33 @ Creek",
    type: "Culvert",
    locationLabel: "Creek",
    coordinates: [-119.2, 34.4],
    source: "assets.csv",
    confidence: "High",
    localOrUploaded: true,
    origin: "uploaded",
    coverageStatus: "available",
  };
}

function recommendationForAsset(asset: Asset): Recommendation {
  return {
    id: "rec-1",
    incidentId: asset.incidentId,
    assetId: asset.id,
    assetName: asset.name,
    assetType: asset.type,
    locationLabel: asset.locationLabel,
    coordinates: asset.coordinates,
    recommendedAction: "Inspect culvert and upstream channel.",
    finalScore: 0.7,
    score100: 70,
    riskLevel: "High",
    confidenceLevel: "High",
    reasonCodes: ["Local Asset Imported"],
    limitations: [],
    changedSinceLastRefresh: "Local Asset Recalculated",
    sourcesUpdatedLabel: "Fresh",
    dataFreshnessHours: 1,
    scoreBreakdown: {
      rainfallThreat: 0.7,
      burnSeverity: 0.5,
      slopeTerrain: 0.6,
      downstreamExposure: 0.8,
      dataFreshness: 0.9,
      confidenceMultiplier: 0.9,
      baseScore: 0.75,
      finalScore: 0.7,
    },
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}

function assetImportAuditEvent(): AuditEvent {
  return {
    id: "audit-asset-import",
    incidentId: "incident-ventura",
    eventType: "AssetsImported",
    actorName: "commander@example.com",
    createdAt: "2026-06-28T00:00:00.000Z",
    summary: "Imported one local asset.",
    payload: {},
  };
}
