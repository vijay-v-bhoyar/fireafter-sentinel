import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: vi.fn((url: string, key: string) => ({
    kind: "browser",
    url,
    key,
  })),
  createServerClient: vi.fn((url: string, key: string) => ({
    kind: "server",
    url,
    key,
  })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn((url: string, key: string, options: unknown) => ({
    kind: "admin",
    url,
    key,
    options,
  })),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    getAll: vi.fn(() => []),
    set: vi.fn(),
  })),
}));

describe("Supabase env helpers", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.SENTINEL_TARGET_SUPABASE_URL = "https://example.supabase.co";
    process.env.SENTINEL_PROTECTED_SUPABASE_URLS = "https://protected-fireafter.supabase.co";
    process.env.NEXT_PUBLIC_SENTINEL_VERIFIED_SUPABASE_URL = "https://example.supabase.co";
  });

  it("rejects a protected admin target before SDK creation", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://protected-fireafter.supabase.co";
    process.env.SENTINEL_TARGET_SUPABASE_URL = "https://protected-fireafter.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-test-key";
    const { createClient } = await import("@supabase/supabase-js");
    const { getSupabaseAdminClient } = await import("./supabase");
    expect(() => getSupabaseAdminClient()).toThrow("Sentinel destination");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects a missing private registry before cookies or server SDK access", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "synthetic-test-key";
    delete process.env.SENTINEL_PROTECTED_SUPABASE_URLS;
    const { getSupabaseServerClient } = await import("./supabase");
    await expect(getSupabaseServerClient()).rejects.toThrow("Sentinel destination");
    expect(cookies).not.toHaveBeenCalled();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("a held admin client cannot dispatch after its registry becomes protected", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-test-key";
    const operation = await import("./refresh-operation");
    const request = vi.spyOn(operation, "fetchOperationResponse").mockResolvedValue(new Response(null, { status: 204 }));
    const { getSupabaseAdminClient } = await import("./supabase");
    const client = getSupabaseAdminClient() as unknown as { options: { global: { fetch: typeof fetch } } };
    process.env.SENTINEL_PROTECTED_SUPABASE_URLS = "https://example.supabase.co";
    await expect(client.options.global.fetch("https://example.supabase.co/rest/v1/assets")).rejects.toThrow("Sentinel destination");
    expect(request).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("uses the publishable key when configured", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_real";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon";

    const { getSupabaseBrowserClient, getSupabasePublicKey, hasSupabaseEnv } =
      await import("./supabase");

    expect(getSupabasePublicKey()).toBe("sb_publishable_real");
    expect(hasSupabaseEnv()).toBe(true);
    expect(getSupabaseBrowserClient()).toMatchObject({
      key: "sb_publishable_real",
      url: "https://example.supabase.co",
    });
  });

  it("uses a bounded Supabase request timeout from configuration", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    process.env.FIREAFTER_SUPABASE_TIMEOUT_MS = "1250";

    const { getSupabaseAdminClient, getSupabaseRequestTimeoutMs } =
      await import("./supabase");

    expect(getSupabaseRequestTimeoutMs()).toBe(1250);
    expect(getSupabaseAdminClient()).toMatchObject({
      options: {
        global: { fetch: expect.any(Function) },
      },
    });
  });

  it("rejects invalid timeout configuration to the safe default", async () => {
    process.env.FIREAFTER_SUPABASE_TIMEOUT_MS = "not-a-duration";

    const { getSupabaseRequestTimeoutMs } = await import("./supabase");

    expect(getSupabaseRequestTimeoutMs()).toBe(5000);
  });

  it.each([
    ["/auth/v1/token?grant_type=password", "POST", 20000],
    ["/auth/v1/token?grant_type=refresh_token", "POST", 5000],
    ["/auth/v1/token?grant_type=password", "GET", 5000],
    ["/rest/v1/rpc/fireafter_commit_bundle", "POST", 40000],
    ["/rest/v1/rpc/fireafter_commit_import", "POST", 40000],
    ["/rest/v1/rpc/fireafter_commit_ingestion", "POST", 40000],
    ["/rest/v1/rpc/fireafter_commit_staged_ingestion", "POST", 40000],
    ["/rest/v1/rpc/fireafter_commit_staged_ingestion", "GET", 5000],
    ["/rest/v1/source_snapshots", "GET", 20000],
    ["/rest/v1/source_snapshots", "POST", 5000],
    ["/rest/v1/assets", "GET", 5000],
    ["/auth/v1/user", "GET", 5000],
    ["/rest/v1/rpc/fireafter_commit_bundle", "GET", 5000],
  ])("bounds admin %s %s independently of ordinary reads", async (path, method, timeout) => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    delete process.env.FIREAFTER_SUPABASE_TIMEOUT_MS;
    const operation = await import("./refresh-operation");
    const request = vi.spyOn(operation, "fetchOperationResponse").mockResolvedValue(new Response(null, { status: 204 }));
    const { getSupabaseAdminClient } = await import("./supabase");
    const client = getSupabaseAdminClient() as unknown as { options: { global: { fetch: typeof fetch } } };
    const started = performance.now();
    await client.options.global.fetch(`https://example.supabase.co${path}`, { method });
    const budget = request.mock.calls[0][2];
    expect(budget.deadline - started).toBeGreaterThanOrEqual(timeout);
    expect(budget.deadline - started).toBeLessThan(timeout + 1000);
    request.mockRestore();
  });

  it("accepts a password response arriving after the former five-second deadline", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-only-public-key";
    delete process.env.FIREAFTER_SUPABASE_TIMEOUT_MS;
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5500));
      return Response.json({ access_token: "test-only" });
    }));
    const { getSupabaseServerClient } = await import("./supabase");
    await getSupabaseServerClient();
    const options = vi.mocked(createServerClient).mock.calls.at(-1)![2]!;
    const response = await options.global!.fetch!("https://example.supabase.co/auth/v1/token?grant_type=password", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: "test-only" });
  }, 10000);

  it("rejects a foreign snapshot origin before transport", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    delete process.env.FIREAFTER_SUPABASE_TIMEOUT_MS;
    const operation = await import("./refresh-operation");
    const request = vi.spyOn(operation, "fetchOperationResponse").mockResolvedValue(new Response(null, { status: 204 }));
    const { getSupabaseAdminClient } = await import("./supabase");
    const client = getSupabaseAdminClient() as unknown as { options: { global: { fetch: typeof fetch } } };
    const callsBefore = request.mock.calls.length;
    await expect(client.options.global.fetch("https://other.example/rest/v1/source_snapshots")).rejects.toThrow("Sentinel destination");
    expect(request.mock.calls).toHaveLength(callsBefore);
    request.mockRestore();
  });

  const inventoryQuery = "?select=*&incident_id=eq.10000000-0000-4000-8000-000000000001&order=id.asc&limit=500";
  it.each([
    ["rpc/fireafter_read_refresh_recommendations", "", "POST", 20000],
    ["rpc/fireafter_read_refresh_recommendations", "", "GET", 5000],
    ["rpc/fireafter_read_refresh_recommendations", "?limit=500", "POST", 5000],
    ["rpc/fireafter_refresh_read_security_version", "", "POST", 5000],
    ["assets", inventoryQuery, "GET", 20000],
    ["recommendations", inventoryQuery, "GET", 20000],
    ["recommendations", inventoryQuery.replace("select=*", "select=*,asset:assets(id,incident_id,name,asset_type,location_label,local_or_uploaded,origin,source_key,coordinates:properties->coordinates,domainAssetId:properties->>domainAssetId,propertySourceKey:properties->>sourceKey)"), "GET", 20000],
    ["assets", inventoryQuery.replace("select=*", "select=*,asset:assets(*)"), "GET", 5000],
    ["recommendations", inventoryQuery.replace("select=*", "select=*,actor:users(*)"), "GET", 5000],
    ["assets", inventoryQuery + "&id=gt.20000000-0000-4000-8000-000000000002", "GET", 20000],
    ["assets", inventoryQuery, "HEAD", 5000],
    ["assets", inventoryQuery, "POST", 5000],
    ["incidents", inventoryQuery, "GET", 5000],
    ["assets", inventoryQuery + "&limit=500", "GET", 5000],
    ["assets", inventoryQuery + "&or=(id.not.is.null)", "GET", 5000],
    ["assets", inventoryQuery.replace("limit=500", "limit=501"), "GET", 5000],
    ["assets", inventoryQuery.replace("eq.10000000-0000-4000-8000-000000000001", "not.is.null"), "GET", 5000],
    ["assets", inventoryQuery.replace("select=*", "select=id"), "GET", 5000],
    ["assets", inventoryQuery + "&id=not.is.null", "GET", 5000],
  ])("scopes complete inventory budget: %s %s %s", async (table, query, method, timeout) => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    delete process.env.FIREAFTER_SUPABASE_TIMEOUT_MS;
    delete process.env.FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES;
    const operation = await import("./refresh-operation");
    const request = vi.spyOn(operation, "fetchOperationResponse").mockResolvedValue(new Response(null, { status: 204 }));
    const { getSupabaseAdminClient } = await import("./supabase");
    const client = getSupabaseAdminClient() as unknown as { options: { global: { fetch: typeof fetch } } };
    const start = performance.now();
    await client.options.global.fetch(`https://example.supabase.co/rest/v1/${table}${query}`, { method });
    expect(request.mock.calls[0][2].deadline - start).toBeGreaterThanOrEqual(timeout);
    expect(request.mock.calls[0][2].deadline - start).toBeLessThan(timeout + 1000);
    expect(request.mock.calls[0][2].remainingBytes).toBe(8 * 1024 * 1024);
  });

  it("keeps non-admin and cross-origin inventories on ordinary budgets", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "public-test-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    delete process.env.FIREAFTER_SUPABASE_TIMEOUT_MS;
    const operation = await import("./refresh-operation");
    const request = vi.spyOn(operation, "fetchOperationResponse").mockResolvedValue(new Response(null, { status: 204 }));
    const { getSupabaseAdminClient, getSupabaseServerClient } = await import("./supabase");
    await getSupabaseServerClient();
    const server = vi.mocked(createServerClient).mock.calls.at(-1)![2]!;
    const admin = getSupabaseAdminClient() as unknown as { options: { global: { fetch: typeof fetch } } };
    for (const [transport, origin] of [[server.global!.fetch!, "https://example.supabase.co"], [admin.options.global.fetch, "https://other.example"]] as const) {
      if (origin === "https://other.example") {
        const callsBefore = request.mock.calls.length;
        await expect(transport(`${origin}/rest/v1/assets${inventoryQuery}`)).rejects.toThrow("Sentinel destination");
        await expect(transport(`${origin}/rest/v1/rpc/fireafter_read_refresh_recommendations`, { method: "POST" })).rejects.toThrow("Sentinel destination");
        expect(request.mock.calls).toHaveLength(callsBefore);
        continue;
      }
      const start = performance.now();
      await transport(`${origin}/rest/v1/assets${inventoryQuery}`);
      expect(request.mock.calls.at(-1)![2].deadline - start).toBeLessThan(6000);
      const rpcStart = performance.now();
      await transport(`${origin}/rest/v1/rpc/fireafter_read_refresh_recommendations`, { method: "POST" });
      expect(request.mock.calls.at(-1)![2].deadline - rpcStart).toBeLessThan(6000);
    }
  });

  it("keeps non-admin and cross-origin staged commits on ordinary budgets", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "public-test-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    delete process.env.FIREAFTER_SUPABASE_TIMEOUT_MS;
    const operation = await import("./refresh-operation");
    const request = vi.spyOn(operation, "fetchOperationResponse").mockResolvedValue(new Response(null, { status: 204 }));
    const { getSupabaseAdminClient, getSupabaseServerClient } = await import("./supabase");
    await getSupabaseServerClient();
    const server = vi.mocked(createServerClient).mock.calls.at(-1)![2]!;
    const admin = getSupabaseAdminClient() as unknown as { options: { global: { fetch: typeof fetch } } };
    for (const [transport, origin] of [[server.global!.fetch!, "https://example.supabase.co"], [admin.options.global.fetch, "https://other.example"]] as const) {
      if (origin === "https://other.example") {
        const callsBefore = request.mock.calls.length;
        await expect(transport(`${origin}/rest/v1/rpc/fireafter_commit_staged_ingestion`, { method: "POST" })).rejects.toThrow("Sentinel destination");
        expect(request.mock.calls).toHaveLength(callsBefore);
        continue;
      }
      const start = performance.now();
      await transport(`${origin}/rest/v1/rpc/fireafter_commit_staged_ingestion`, { method: "POST" });
      expect(request.mock.calls.at(-1)![2].deadline - start).toBeLessThan(6000);
    }
  });

  it("labels inventory failures without logging identifiers, queries or credentials", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    process.env.FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES = "1024";
    process.env.FIREAFTER_SUPABASE_TIMEOUT_MS = "25000";
    const operation = await import("./refresh-operation");
    const { OutboundResponseError } = await import("./bounded-response");
    const failure = new OutboundResponseError("timeout");
    vi.spyOn(operation, "fetchOperationResponse").mockRejectedValue(failure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getSupabaseAdminClient } = await import("./supabase");
    const client = getSupabaseAdminClient() as unknown as { options: { global: { fetch: typeof fetch } } };
    await expect(client.options.global.fetch(`https://example.supabase.co/rest/v1/recommendations${inventoryQuery}`)).rejects.toBe(failure);
    expect(warning).toHaveBeenCalledWith("[fireafter] Supabase response rejected", {
      code: "timeout", timeoutMs: 25000, maxBytes: 1024, operation: "recommendation_inventory_read", requestBytes: undefined,
    });
  });

  it("falls back to the anon key for existing deployments", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon";

    const { getSupabasePublicKey, hasSupabaseEnv } = await import("./supabase");

    expect(getSupabasePublicKey()).toBe("legacy-anon");
    expect(hasSupabaseEnv()).toBe(true);
  });

  it("allows bounded large source reads without widening other response budgets", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    delete process.env.FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES;
    const operation = await import("./refresh-operation");
    const request = vi.spyOn(operation, "fetchOperationResponse").mockResolvedValue(new Response(null, { status: 204 }));
    const { getSupabaseAdminClient } = await import("./supabase");
    const client = getSupabaseAdminClient() as unknown as { options: { global: { fetch: typeof fetch } } };
    await client.options.global.fetch("https://example.supabase.co/rest/v1/source_snapshots");
    expect(request.mock.calls.at(-1)![2].remainingBytes).toBe(16 * 1024 * 1024);
    await client.options.global.fetch("https://example.supabase.co/rest/v1/assets");
    expect(request.mock.calls.at(-1)![2].remainingBytes).toBe(8 * 1024 * 1024);
    process.env.FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES = "1024";
    await client.options.global.fetch("https://example.supabase.co/rest/v1/source_snapshots");
    expect(request.mock.calls.at(-1)![2].remainingBytes).toBe(1024);
    request.mockRestore();
  });

  it.each([true, false])("cookie-write failures are visible when required=%s", async (requireCookieWrites) => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-public-key";
    const set = vi.fn(() => { throw new Error("private cookie failure"); });
    vi.mocked(cookies).mockResolvedValueOnce({ getAll: () => [], set } as never);
    const { getSupabaseServerClient } = await import("./supabase");
    await getSupabaseServerClient({ requireCookieWrites });
    const options = vi.mocked(createServerClient).mock.calls.at(-1)?.[2] as unknown as {
      cookies: { setAll: (items: { name: string; value: string; options: object }[]) => void };
    };
    const write = () => options.cookies.setAll([{ name: "session", value: "", options: { maxAge: 0 } }]);
    if (requireCookieWrites) expect(write).toThrow("Session cookie update failed");
    else expect(write).not.toThrow();
    expect(set).toHaveBeenCalledOnce();
  });
});
