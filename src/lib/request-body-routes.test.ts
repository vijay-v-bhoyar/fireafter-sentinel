import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ authorize: vi.fn(), mutate: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  AuthError: class extends Error {},
  requireCurrentUser: calls.authorize,
  requireIncidentAccess: calls.authorize,
  requireRecommendationAccess: calls.authorize,
  signInWithPassword: calls.mutate,
  verifySignedInOrganizationMembership: calls.authorize,
}));
vi.mock("@/lib/fireafter-data", () => ({
  createIncidentBundle: calls.mutate, selectIncidentFireBundle: calls.mutate,
  recordResponderAction: calls.mutate, importIncidentAssets: calls.mutate,
  FireContextSelectionError: class extends Error {},
  toClientDashboardBundle: (bundle: unknown) => bundle,
}));

const routes = [
  { name: "incident", load: () => import("@/app/api/incident/route"), limit: 32768, payload: { locationId: "ventura-ca" } },
  { name: "fire-context", load: () => import("@/app/api/fire-context/[incidentId]/route"), limit: 32768, payload: { sourceKey: "wfigs", sourceFeatureId: "fire-1" } },
  { name: "actions", load: () => import("@/app/api/actions/route"), limit: 32768, payload: { commandId: "11111111-1111-4111-8111-111111111111", expectedRevision: "22222222-2222-4222-8222-222222222222", recommendationId: "recommendation-1", action: "Annotate", note: "Review" } },
  { name: "assets/import", load: () => import("@/app/api/assets/import/route"), limit: 1100000, payload: { operationId: "10000000-0000-4000-8000-000000000001", incidentId: "incident-1", fileName: "assets.csv", content: "name,lat,lon\nCrossing,34,-119" } },
  { name: "auth/login", load: () => import("@/app/api/auth/login/route"), limit: 32768, payload: { email: "responder@example.com", password: "test-only-password" } },
];

beforeEach(() => {
  calls.authorize.mockReset().mockResolvedValue({ id: "user-1", email: "responder@example.com", organizationId: "org-1" });
  calls.mutate.mockReset().mockResolvedValue({ id: "user-1", assets: [], auditEvent: null, bundle: null });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("FA13-IN1 actual body limits before side effects", () => {
  for (const route of routes) {
    it.each([undefined, "1"])(`${route.name} rejects oversized JSON with Content-Length %s`, async (length) => {
      const { POST } = await route.load();
      const response = await POST(new Request(`http://localhost/api/${route.name}`, {
        method: "POST", headers: { "content-type": "application/json", ...(length ? { "content-length": length } : {}) },
        body: JSON.stringify({ ...route.payload, extra: "x".repeat(route.limit) }),
      }), { params: Promise.resolve({ incidentId: "incident-1" }) });
      expect(response.status).toBe(413);
      expect(calls.mutate).not.toHaveBeenCalled();
      expect(calls.authorize).not.toHaveBeenCalled();
    });
  }
});

describe("FA13-IN3 route compatibility and failed transfers", () => {
  for (const route of routes) {
    it(`${route.name} preserves a valid request and authorization`, async () => {
      const { POST } = await route.load();
      const payload = route.name === "actions" ? { ...route.payload, action: "annotate" } : route.payload;
      const response = await POST(new Request(`http://localhost/api/${route.name}`, {
        method: "POST", headers: { "content-type": "application/json", ...(route.name === "actions" ? { "x-fireafter-actor": "user-1", "x-fireafter-organization": "org-1" } : {}) }, body: JSON.stringify(payload),
      }), { params: Promise.resolve({ incidentId: "incident-1" }) });
      expect(response.status).toBe(200);
      expect(calls.authorize).toHaveBeenCalledOnce();
      expect(calls.mutate).toHaveBeenCalledOnce();
    });
    it(`${route.name} times out incomplete body without side effects`, async () => {
      const { POST } = await route.load();
      vi.useFakeTimers(); vi.stubEnv("FIREAFTER_REQUEST_BODY_TIMEOUT_MS", "250");
      const cancel = vi.fn();
      const result = POST(new Request(`http://localhost/api/${route.name}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({ cancel }), duplex: "half",
      } as RequestInit), { params: Promise.resolve({ incidentId: "incident-1" }) });
      await vi.advanceTimersByTimeAsync(251);
      const response = await result;
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({ error: "Request body timed out. Check your connection before retrying." });
      expect(cancel).toHaveBeenCalledOnce();
      expect(calls.authorize).not.toHaveBeenCalled();
      expect(calls.mutate).not.toHaveBeenCalled();
    });
  }
  it.each(["multipart/form-data", "application/x-www-form-urlencoded"])("login rejects oversized %s before authenticating", async (type) => {
    const { POST } = await import("@/app/api/auth/login/route");
    const entries = { email: "responder@example.com", password: "test-only-password", extra: "x".repeat(32768) };
    const form = new FormData();
    for (const [key, value] of Object.entries(entries)) form.set(key, value);
    const response = await POST(new Request("http://localhost/api/auth/login", {
      method: "POST", body: type === "multipart/form-data" ? form : new URLSearchParams(entries),
    }));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("Login request is too large");
    expect(calls.mutate).not.toHaveBeenCalled();
  });
  it("import counts multipart envelope and non-file fields, not just file size", async () => {
    const { POST } = await import("@/app/api/assets/import/route");
    const body = new FormData();
    body.set("incidentId", "incident-1");
    body.set("file", new File(["name,lat,lon\nCrossing,34,-119"], "assets.csv"));
    body.set("ignored", "x".repeat(1100000));
    const request = new Request("http://localhost/api/assets/import", { method: "POST", body });
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(calls.mutate).not.toHaveBeenCalled();
    expect(calls.authorize).not.toHaveBeenCalled();
  });
  it("preserves valid multipart imports", async () => {
    const { POST } = await import("@/app/api/assets/import/route");
    const body = new FormData();
    body.set("incidentId", "incident-1");
    body.set("operationId", "10000000-0000-4000-8000-000000000001");
    body.set("file", new File(["name,lat,lon\nCrossing,34,-119"], "assets.csv"));
    const request = new Request("http://localhost/api/assets/import", { method: "POST", body });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(calls.mutate).toHaveBeenCalledWith(expect.objectContaining({ fileName: "assets.csv", actorOrganizationId: "org-1" }), request.signal);
  });
});
