import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
const incidentId = "10000000-0000-4000-8000-000000000001";

async function fixture(delayMs: number, padding = 0) {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let canceled = false;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.once("close", () => { if (!response.writableEnded) canceled = true; });
    response.writeHead(200, { "content-type": "application/json", "content-range": "0-0/1" });
    response.write("[");
    timers.push(setTimeout(() => {
      if (!response.destroyed) response.end(JSON.stringify({ id: incidentId, incident_id: incidentId, padding: "x".repeat(padding) }) + "]");
    }, delayMs));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-key");
  vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "5000");
  vi.stubEnv("FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES", "8388608");
  return {
    state: () => ({ canceled, requests }),
    close: async () => {
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

beforeEach(() => { vi.resetModules(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("real SDK inventory transfers over isolated HTTP", () => {
  it.each(["assets", "recommendations"])("completes a %s body taking longer than the ordinary five-second budget", async table => {
    const server = await fixture(5500);
    try {
      const { getSupabaseAdminClient } = await import("./supabase");
      const start = performance.now();
      const result = await getSupabaseAdminClient()!.from(table).select("*", { count: "exact" })
        .eq("incident_id", incidentId).order("id", { ascending: true }).limit(500).retry(false);
      expect(result.error).toBeNull();
      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(performance.now() - start).toBeGreaterThan(5000);
      expect(server.state()).toEqual({ canceled: false, requests: 1 });
    } finally { await server.close(); }
  }, 10000);

  it("still rejects an unscoped slow read without returning its partial body", async () => {
    const server = await fixture(6500);
    try {
      const { getSupabaseAdminClient } = await import("./supabase");
      const result = await getSupabaseAdminClient()!.from("assets").select("*").retry(false);
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain("deadline");
      await vi.waitFor(() => expect(server.state()).toEqual({ canceled: true, requests: 1 }));
    } finally { await server.close(); }
  }, 10000);

  it("cancels a hanging inventory at the unscaled twenty-second limit", async () => {
    const server = await fixture(25000);
    try {
      const { getSupabaseAdminClient } = await import("./supabase");
      const start = performance.now();
      const result = await getSupabaseAdminClient()!.from("recommendations").select("*")
        .eq("incident_id", incidentId).order("id", { ascending: true }).limit(500).retry(false);
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain("deadline");
      expect(performance.now() - start).toBeGreaterThanOrEqual(19500);
      expect(performance.now() - start).toBeLessThan(23000);
      await vi.waitFor(() => expect(server.state()).toEqual({ canceled: true, requests: 1 }));
    } finally { await server.close(); }
  }, 30000);

  it("retains the byte cap and caller cancellation on extended reads", async () => {
    const server = await fixture(30, 2048);
    try {
      vi.stubEnv("FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES", "1024");
      const { getSupabaseAdminClient } = await import("./supabase");
      const client = getSupabaseAdminClient()!;
      const query = () => client.from("assets").select("*").eq("incident_id", incidentId)
        .order("id", { ascending: true }).limit(500).retry(false);
      const oversized = await query();
      expect(oversized.data).toBeNull();
      expect(oversized.error).not.toBeNull();
      const aborted = await query().abortSignal(AbortSignal.abort());
      expect(aborted.data).toBeNull();
      expect(aborted.error).not.toBeNull();
      expect(server.state().requests).toBe(1);
    } finally { await server.close(); }
  });
});
