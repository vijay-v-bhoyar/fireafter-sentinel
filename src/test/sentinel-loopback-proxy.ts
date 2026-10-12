import { vi } from "vitest";

/** Test transport only: production policy still sees an explicitly registered HTTPS database. */
export function registerProductionLoopbackDatabase(loopbackOrigin: string) {
  const local = new URL(loopbackOrigin);
  if (local.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(local.hostname) ||
      !local.port || local.origin !== loopbackOrigin) throw new Error("Fixture requires an explicit loopback origin.");
  const fixtureOrigin = `https://sentinel-fixture-${local.port}.supabase.co`;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", fixtureOrigin);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", fixtureOrigin);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "false");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = new URL(input instanceof Request ? input.url : String(input));
    if (requested.origin !== fixtureOrigin) throw new Error("Unregistered fixture transport destination.");
    const target = new URL(requested.pathname + requested.search, local);
    const options = input instanceof Request ? {
      method: input.method, headers: input.headers, body: input.body, signal: input.signal,
      redirect: input.redirect, duplex: "half", ...init,
    } as RequestInit : init;
    return nativeFetch(target, options);
  });
  return fixtureOrigin;
}
