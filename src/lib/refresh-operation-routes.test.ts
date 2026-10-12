import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RefreshOperationError } from "./refresh-operation";
const calls = vi.hoisted(() => ({ authorize: vi.fn(), mutate: vi.fn(), discover: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  AuthError: class extends Error { status = 403; },
  requireCurrentUser: calls.authorize, requireIncidentAccess: calls.authorize,
}));
vi.mock("@/lib/fireafter-data", () => ({
  createIncidentBundle: calls.mutate, selectIncidentFireBundle: calls.mutate,
  refreshIncidentBundle: calls.mutate, importIncidentAssets: calls.mutate,
  FireContextSelectionError: class extends Error {}, toClientDashboardBundle: (value: unknown) => value,
}));
vi.mock("@/lib/fireafter-supabase", () => ({ listSupabaseIncidentIds: calls.discover }));
const cases = [
  { name: "incident", load: () => import("@/app/api/incident/route"), payload: { locationId: "test-county" } },
  { name: "refresh/test", load: () => import("@/app/api/refresh/[incidentId]/route"), payload: {} },
  { name: "fire-context/test", load: () => import("@/app/api/fire-context/[incidentId]/route"), payload: { sourceKey: "wfigs", sourceFeatureId: "test-fire" } },
  { name: "assets/import", load: () => import("@/app/api/assets/import/route"), payload: {
    operationId: "10000000-0000-4000-8000-000000000001", incidentId: "test", fileName: "test.csv", content: "name,lat,lon\nTest,34,-119",
  } },
];
beforeEach(() => {
  calls.authorize.mockReset().mockResolvedValue({ id: "test-user", email: "test@example.invalid", organizationId: "test-org" });
  calls.mutate.mockReset(); calls.discover.mockReset();
  vi.stubEnv("FIREAFTER_REFRESH_MAX_REQUESTS", "invalid");
  vi.stubEnv("CRON_SECRET", "test-only-cron");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
for (const scenario of cases) {
  const invoke = async () => (await scenario.load()).POST(new Request(`http://localhost/api/${scenario.name}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(scenario.payload),
  }), { params: Promise.resolve({ incidentId: "test" }) });
  it(`${scenario.name} denies authorization before initializing budget or mutating`, async () => {
    const { AuthError } = await import("@/lib/auth");
    calls.authorize.mockRejectedValue(new AuthError("Denied", 403));
    expect((await invoke()).status).toBe(403);
    expect(calls.mutate).not.toHaveBeenCalled();
  });
  it(`${scenario.name} returns safe no-store resource failure before side effects`, async () => {
    // Import owns its budget in the facade so it can preserve a confirmed receipt.
    if (scenario.name === "assets/import") calls.mutate.mockRejectedValue(new RefreshOperationError("refresh_config"));
    const response = await invoke();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "refresh_config", error: expect.stringContaining("resource policy") });
    expect(calls.authorize).toHaveBeenCalledOnce();
    expect(calls.mutate).toHaveBeenCalledTimes(scenario.name === "assets/import" ? 1 : 0);
  });
}
it("cron authorizes before initializing its batch budget", async () => {
  const { GET } = await import("@/app/api/cron/refresh/route");
  expect((await GET(new Request("http://localhost/api/cron/refresh"))).status).toBe(401);
  const response = await GET(new Request("http://localhost/api/cron/refresh", { headers: { authorization: "Bearer test-only-cron" } }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, code: "refresh_config" });
  expect(calls.discover).not.toHaveBeenCalled(); expect(calls.mutate).not.toHaveBeenCalled();
});
