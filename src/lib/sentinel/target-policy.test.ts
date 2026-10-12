import { describe, expect, it, vi } from "vitest";
import { requireAppTarget, requireSupabaseTarget, requireBrowserSupabaseTarget, SentinelTargetError } from "./target-policy.mjs";

const newDatabase = "https://sentinel-test.supabase.co";
const protectedDatabase = "https://protected-fireafter.supabase.co";
const config = { SENTINEL_TARGET_SUPABASE_URL: newDatabase, SENTINEL_PROTECTED_SUPABASE_URLS: protectedDatabase };

describe("Sentinel destination admission", () => {
  it.each([
    [newDatabase, {}],
    [newDatabase, { SENTINEL_TARGET_SUPABASE_URL: newDatabase }],
    [protectedDatabase, { ...config, SENTINEL_TARGET_SUPABASE_URL: protectedDatabase }],
    ["https://another.supabase.co", config],
    [newDatabase + "/rest/v1", config],
    ["https://user:secret@sentinel-test.supabase.co", config],
    [newDatabase + "?target=another", config],
    ["http://sentinel-test.supabase.co", config],
    ["https://127.0.0.1", { ...config, SENTINEL_TARGET_SUPABASE_URL: "https://127.0.0.1" }],
    ["https://private.local", { ...config, SENTINEL_TARGET_SUPABASE_URL: "https://private.local" }],
    [newDatabase, { ...config, SENTINEL_PROTECTED_SUPABASE_URLS: "not-a-url" }],
  ])("rejects unsafe/missing/mismatched registry before any dispatch (%s)", (url, registry) => {
    const dispatch = vi.fn();
    expect(() => dispatch(requireSupabaseTarget(url as string, registry))).toThrow(SentinelTargetError);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("dispatches once only to the explicitly registered new database", () => {
    const dispatch = vi.fn();
    dispatch(requireSupabaseTarget(newDatabase, config));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(newDatabase);
  });
  it("allows explicitly registered disposable loopback only outside production", () => {
    const url = "http://127.0.0.1:54321";
    const local = { ...config, SENTINEL_TARGET_SUPABASE_URL: url, SENTINEL_ALLOW_LOCAL_DB: "true", NODE_ENV: "test" };
    expect(requireSupabaseTarget(url, local)).toBe(url);
    expect(() => requireSupabaseTarget(url, { ...local, NODE_ENV: "production" })).toThrow();
    expect(() => requireSupabaseTarget(url, { ...local, SENTINEL_ALLOW_LOCAL_DB: "false" })).toThrow();
  });
  it("a browser client needs the origin admitted by the build configuration", () => {
    expect(() => requireBrowserSupabaseTarget(newDatabase, undefined)).toThrow();
    expect(() => requireBrowserSupabaseTarget(protectedDatabase, newDatabase)).toThrow();
    expect(requireBrowserSupabaseTarget(newDatabase, newDatabase)).toBe(newDatabase);
  });
  it.each(["https://fireafter-app.vercel.app", "http://127.0.0.1:3010", "http://[::1]:3010"])("never admits the protected app %s", url => {
    const request = vi.fn();
    expect(() => request(requireAppTarget(url, { SENTINEL_TARGET_APP_URL: url,
      SENTINEL_PROTECTED_APP_URLS: "https://fireafter-app.vercel.app" }))).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("requires a positive app identity and a deny-list for remote verification", () => {
    expect(() => requireAppTarget("https://sentinel-new.vercel.app", {})).toThrow();
    expect(() => requireAppTarget("https://sentinel-new.vercel.app", { SENTINEL_TARGET_APP_URL: "https://sentinel-new.vercel.app" })).toThrow();
    expect(requireAppTarget("https://sentinel-new.vercel.app", { SENTINEL_TARGET_APP_URL: "https://sentinel-new.vercel.app",
      SENTINEL_PROTECTED_APP_URLS: "https://fireafter-app.vercel.app" })).toBe("https://sentinel-new.vercel.app");
    expect(() => requireAppTarget("http://127.0.0.1:3020", { SENTINEL_TARGET_APP_URL: "http://127.0.0.1:3021" })).toThrow();
  });
});
