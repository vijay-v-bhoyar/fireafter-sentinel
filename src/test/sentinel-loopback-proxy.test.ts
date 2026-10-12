import { afterEach, expect, it, vi } from "vitest";
import { registerProductionLoopbackDatabase } from "./sentinel-loopback-proxy";
import { requireSupabaseTarget } from "../lib/sentinel/target-policy.mjs";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("retains production target policy while restricting the test transport to its owned loopback", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const actualFetch = vi.fn<typeof fetch>(async () => new Response("fixture"));
  vi.stubGlobal("fetch", actualFetch);
  const origin = registerProductionLoopbackDatabase("http://127.0.0.1:43210");
  expect(requireSupabaseTarget(origin, process.env)).toBe(origin);
  expect(() => requireSupabaseTarget("http://127.0.0.1:43210", process.env)).toThrow();
  await fetch(origin + "/rest/v1/assets?select=id", { redirect: "error" });
  expect(String(actualFetch.mock.calls[0][0])).toBe("http://127.0.0.1:43210/rest/v1/assets?select=id");
  expect(() => fetch("https://fireafter-app.vercel.app/")).toThrow();
  expect(() => fetch("https://unregistered.supabase.co/")).toThrow();
  expect(actualFetch).toHaveBeenCalledTimes(1);
});
it.each(["http://localhost:43210", "https://example.gov", "http://127.0.0.1:43210/path"])("rejects a non-owned fixture origin %s", origin => {
  expect(() => registerProductionLoopbackDatabase(origin)).toThrow();
});
