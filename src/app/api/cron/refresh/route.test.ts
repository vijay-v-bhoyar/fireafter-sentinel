import { beforeEach, describe, expect, it, vi } from "vitest";

const claimSupabaseScheduledRefreshesMock = vi.fn();
const settleSupabaseScheduledRefreshMock = vi.fn();
const refreshIncidentBundleMock = vi.fn();

vi.mock("@/lib/fireafter-supabase", () => ({
  claimSupabaseScheduledRefreshes: claimSupabaseScheduledRefreshesMock,
  settleSupabaseScheduledRefresh: settleSupabaseScheduledRefreshMock,
}));

vi.mock("@/lib/fireafter-data", () => ({
  refreshIncidentBundle: refreshIncidentBundleMock,
}));

vi.mock("@/lib/error-message", () => ({
  errorMessage: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));

describe("GET /api/cron/refresh", () => {
  beforeEach(() => {
    claimSupabaseScheduledRefreshesMock.mockReset();
    settleSupabaseScheduledRefreshMock.mockReset();
    refreshIncidentBundleMock.mockReset();
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.FIREAFTER_CRON_INCIDENT_LIMIT = "";
  });

  it("requires the configured cron bearer token", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/cron/refresh"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(claimSupabaseScheduledRefreshesMock).not.toHaveBeenCalled();
    expect(refreshIncidentBundleMock).not.toHaveBeenCalled();
  });

  it("fails closed when the cron secret is not configured", async () => {
    delete process.env.CRON_SECRET;

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/cron/refresh", {
        headers: { authorization: "Bearer any-token" },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "CRON_SECRET is not configured",
    });
    expect(claimSupabaseScheduledRefreshesMock).not.toHaveBeenCalled();
    expect(refreshIncidentBundleMock).not.toHaveBeenCalled();
  });

  it("refreshes persisted incidents instead of a hard-coded demo incident", async () => {
    claimSupabaseScheduledRefreshesMock.mockResolvedValue([
      claim("incident-utah-county-ut"),
      claim("incident-los-angeles-ca"),
    ]);
    refreshIncidentBundleMock.mockImplementation(async (databaseIncidentId: string) => ({
      incident: { id: databaseIncidentId.replace(/^database-/, ""), recoveryScopeId: databaseIncidentId },
      recommendations: databaseIncidentId.includes("utah") ? [{ id: "rec-utah" }] : [],
    }));

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/cron/refresh", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(claimSupabaseScheduledRefreshesMock).toHaveBeenCalledWith(20, undefined, 600);
    expect(refreshIncidentBundleMock).toHaveBeenNthCalledWith(
      1,
      claim("incident-utah-county-ut").databaseIncidentId,
      { kind: "cron" },
      true,
    );
    expect(refreshIncidentBundleMock).toHaveBeenNthCalledWith(
      2,
      claim("incident-los-angeles-ca").databaseIncidentId,
      { kind: "cron" },
      true,
    );
    expect(body).toMatchObject({
      ok: true,
      refreshedCount: 2,
      failedCount: 0,
      results: [
        {
          ok: true,
          incidentId: "incident-utah-county-ut",
          recommendationCount: 1,
        },
        {
          ok: true,
          incidentId: "incident-los-angeles-ca",
          recommendationCount: 0,
        },
      ],
    });
  });

  it("reports partial failures without blocking successful incident refreshes", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    claimSupabaseScheduledRefreshesMock.mockResolvedValue([claim("incident-a"), claim("incident-b")]);
    refreshIncidentBundleMock
      .mockResolvedValueOnce({
        incident: { id: "incident-a", recoveryScopeId: claim("incident-a").databaseIncidentId },
        recommendations: [{ id: "rec-a" }, { id: "rec-b" }],
      })
      .mockRejectedValueOnce(new Error("WFIGS timeout"));

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/cron/refresh", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      refreshedCount: 1,
      failedCount: 1,
      results: [
        { ok: true, incidentId: "incident-a", recommendationCount: 2 },
        { ok: false, incidentId: "incident-b", error: "Incident refresh failed" },
      ],
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[fireafter] cron refresh failed for incident-b",
      "WFIGS timeout",
    );
    expect(settleSupabaseScheduledRefreshMock).toHaveBeenNthCalledWith(1, claim("incident-a"), true);
    expect(settleSupabaseScheduledRefreshMock).toHaveBeenNthCalledWith(2, claim("incident-b"), false);
    consoleError.mockRestore();
  });

  it("does not report a refresh as successful when its lease settlement fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    claimSupabaseScheduledRefreshesMock.mockResolvedValue([claim("incident-a")]);
    refreshIncidentBundleMock.mockResolvedValue({
      incident: { id: "incident-a", recoveryScopeId: claim("incident-a").databaseIncidentId },
      recommendations: [],
    });
    settleSupabaseScheduledRefreshMock.mockRejectedValue(new Error("lease unavailable"));

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/cron/refresh", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      refreshedCount: 0,
      failedCount: 1,
      results: [{ ok: false, incidentId: "incident-a", error: "Refresh lease settlement failed" }],
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[fireafter] cron refresh lease settlement failed for incident-a",
      "lease unavailable",
    );
    consoleError.mockRestore();
  });

  it("caps configured incident work to the supported per-run maximum", async () => {
    process.env.FIREAFTER_CRON_INCIDENT_LIMIT = "100000";
    claimSupabaseScheduledRefreshesMock.mockResolvedValue([]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/cron/refresh", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(claimSupabaseScheduledRefreshesMock).toHaveBeenCalledWith(20, undefined, 600);
  });

  it("fails closed without exposing incident-claim diagnostics", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    claimSupabaseScheduledRefreshesMock.mockRejectedValueOnce(
      new Error("permission denied for table incidents"),
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/cron/refresh", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Incident claim failed",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[fireafter] cron incident claim failed",
      "permission denied for table incidents",
    );
    consoleError.mockRestore();
  });

  it("returns an honest no-op when no persisted incidents exist", async () => {
    claimSupabaseScheduledRefreshesMock.mockResolvedValue([]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/cron/refresh", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      refreshedCount: 0,
      failedCount: 0,
      results: [],
    });
    expect(refreshIncidentBundleMock).not.toHaveBeenCalled();
  });

  it("FA15-I1 dispatches the canonical claimed incident without alias resolution", async () => {
    const leased = claim("shared-or-renamed-alias");
    claimSupabaseScheduledRefreshesMock.mockResolvedValue([leased]);
    refreshIncidentBundleMock.mockResolvedValue({
      incident: { id: "current-alias", recoveryScopeId: leased.databaseIncidentId },
      recommendations: [],
    });
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/cron/refresh", {
      headers: { authorization: "Bearer test-cron-secret" },
    }));
    expect(response.status).toBe(200);
    expect(refreshIncidentBundleMock).toHaveBeenCalledExactlyOnceWith(leased.databaseIncidentId, { kind: "cron" }, true);
    expect(settleSupabaseScheduledRefreshMock).toHaveBeenCalledExactlyOnceWith(leased, true);
  });

  it.each([undefined, "different-database-incident"])("FA15-I2 never confirms a mismatched result scope: %s", async recoveryScopeId => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const leased = claim("incident-a");
      claimSupabaseScheduledRefreshesMock.mockResolvedValue([leased]);
      refreshIncidentBundleMock.mockResolvedValue({ incident: { id: leased.incidentId, recoveryScopeId }, recommendations: [] });
      const { GET } = await import("./route");
      const response = await GET(new Request("http://localhost/api/cron/refresh", {
        headers: { authorization: "Bearer test-cron-secret" },
      }));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ ok: false, refreshedCount: 0, failedCount: 1 });
      expect(settleSupabaseScheduledRefreshMock).not.toHaveBeenCalledWith(leased, true);
      expect(settleSupabaseScheduledRefreshMock).toHaveBeenCalledExactlyOnceWith(leased, false);
    } finally { consoleError.mockRestore(); }
  });
});

function claim(incidentId: string) {
  return {
    databaseIncidentId: `database-${incidentId}`,
    incidentId,
    attemptId: `attempt-${incidentId}`,
    workerId: "worker-test",
  };
}
