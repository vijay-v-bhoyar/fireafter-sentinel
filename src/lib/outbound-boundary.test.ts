import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/ssr", () => ({ createBrowserClient: vi.fn(), createServerClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: (_url: string, _key: string, options: unknown) => ({ options }) }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "false");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-service-key");
  vi.stubEnv("FIREAFTER_SOURCE_MAX_RESPONSE_BYTES", "1024");
  vi.stubEnv("FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES", "1024");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("FA13-OUT1 real callers bound response bytes", () => {
  it.each([undefined, "1"])("Supabase rejects oversized body with Content-Length %s", async (length) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(2048), { headers: length ? { "content-length": length } : {} })));
    const { getSupabaseAdminClient } = await import("./supabase");
    const client = getSupabaseAdminClient() as unknown as { options: { global: { fetch: typeof fetch } } };
    await expect(client.options.global.fetch("https://example.supabase.co/rest/v1/assets")).rejects.toThrow();
  });
  it.each([undefined, "1"])("source search rejects oversized JSON with Content-Length %s", async (length) => {
    const { searchLocationsLive, CountySearchUnavailableError } = await import("./live-sources");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ features: [], extra: "x".repeat(2048) }), { headers: length ? { "content-length": length } : {} }));
    await expect(searchLocationsLive("Ventura CA", fetchImpl)).rejects.toBeInstanceOf(CountySearchUnavailableError);
  });
});
