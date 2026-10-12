import { createServer } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
const incidentId = "10000000-0000-4000-8000-000000000001";
const operation = { p_id: "20000000-0000-4000-8000-000000000002", p_lease: "30000000-0000-4000-8000-000000000003" };
async function admin() {
  const { getSupabaseAdminClient } = await import("./supabase");
  return getSupabaseAdminClient()! as unknown as SupabaseClient;
}

async function fixture(delayMs: number, padding = 0) {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const submitted: unknown[] = [];
  let canceled = false;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", value => { body += value; });
    request.on("end", () => {
      submitted.push({ method: request.method, path: request.url, body: JSON.parse(body) });
      response.once("close", () => { if (!response.writableEnded) canceled = true; });
      response.writeHead(200, { "content-type": "application/json" });
      response.write('"');
      timers.push(setTimeout(() => {
        if (!response.destroyed) response.end(incidentId + "x".repeat(padding) + '"');
      }, delayMs));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local test port");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-test-only-key");
  vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "5000");
  return { submitted, canceled: () => canceled, close: async () => {
    timers.forEach(clearTimeout); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("receives the staged commit receipt after five seconds through the real SDK without resubmission", async () => {
  const server = await fixture(5500);
  try {
    const client = await admin();
    const started = performance.now();
    const result = await client.rpc("fireafter_commit_staged_ingestion", operation);
    expect(result.error).toBeNull(); expect(result.data).toBe(incidentId);
    expect(performance.now() - started).toBeGreaterThan(5000);
    expect(server.submitted).toEqual([{ method: "POST", path: "/rest/v1/rpc/fireafter_commit_staged_ingestion", body: operation }]);
    expect(server.canceled()).toBe(false);
  } finally { await server.close(); }
}, 10000);

it("cancels an unacknowledged staged commit at the existing unscaled forty-second limit without retry", async () => {
  const server = await fixture(45000);
  try {
    const client = await admin();
    const started = performance.now();
    const result = await client.rpc("fireafter_commit_staged_ingestion", operation);
    expect(result.data).toBeNull(); expect(result.error?.message).toContain("deadline");
    expect(performance.now() - started).toBeGreaterThanOrEqual(39500);
    expect(performance.now() - started).toBeLessThan(44000);
    await vi.waitFor(() => expect(server.canceled()).toBe(true));
    expect(server.submitted).toHaveLength(1);
  } finally { await server.close(); }
}, 50000);

it("retains the original operation deadline and dispatched-write ambiguity", async () => {
  const server = await fixture(2000);
  try {
    vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "250");
    const client = await admin();
    const { withRefreshOperation } = await import("./refresh-operation");
    const result = withRefreshOperation("refresh", async () => client.rpc("fireafter_commit_staged_ingestion", operation));
    await expect(result).rejects.toMatchObject({ code: "refresh_deadline", message: expect.stringContaining("may have committed") });
    await vi.waitFor(() => expect(server.canceled()).toBe(true));
    expect(server.submitted).toHaveLength(1);
  } finally { await server.close(); }
});

it("still enforces response bytes and caller cancellation on staged commits", async () => {
  const server = await fixture(10, 2048);
  try {
    vi.stubEnv("FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES", "1024");
    const client = await admin();
    const oversized = await client.rpc("fireafter_commit_staged_ingestion", operation);
    expect(oversized.data).toBeNull(); expect(oversized.error).not.toBeNull();
    const canceled = await client.rpc("fireafter_commit_staged_ingestion", operation).abortSignal(AbortSignal.abort());
    expect(canceled.data).toBeNull(); expect(canceled.error).not.toBeNull();
    expect(server.submitted).toHaveLength(1);
  } finally { await server.close(); }
});
