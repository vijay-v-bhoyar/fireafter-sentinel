import { beforeEach, afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn(), dispatch: vi.fn(), rpc: vi.fn() }));
vi.mock("./auth", () => ({ requireCurrentUser: calls.authorize, AuthError: class extends Error { constructor(message: string, readonly status: number) { super(message); } } }));
vi.mock("./ingestion-store", () => ({ readIngestionJob: calls.read, publicIngestionStatus: (job: { id: string; status: string }) => ({ id: job.id, status: job.status }), ingestionRpc: calls.rpc }));
vi.mock("./ingestion-dispatch", () => ({ dispatchIngestion: calls.dispatch }));
import { GET, POST } from "@/app/api/ingestion/[jobId]/route";
const jobId = "50000000-0000-4000-a000-000000000001";
const context = { params: Promise.resolve({ jobId }) };
beforeEach(() => {
  vi.clearAllMocks();
  calls.authorize.mockResolvedValue({ id: "actor", organizationId: "org", role: "analyst" });
  calls.read.mockResolvedValue({ id: jobId, actor_id: "actor", organization_id: "org", status: "queued", seed: { private: "never return" } });
});
afterEach(() => vi.unstubAllEnvs());
it("returns only public progress with no caching and no mutation on GET", async () => {
  const response = await GET(new Request(`http://localhost/api/ingestion/${jobId}`), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ingestion: { id: jobId, status: "queued" } });
  expect(calls.dispatch).not.toHaveBeenCalled(); expect(calls.rpc).not.toHaveBeenCalled();
});
it.each([{ id: "other", organizationId: "org" }, { id: "actor", organizationId: "other" }])("does not expose another actor/organization's progress", async user => {
  calls.authorize.mockResolvedValue(user);
  expect((await GET(new Request(`http://localhost/api/ingestion/${jobId}`), context)).status).toBe(404);
});
it("rejects cross-origin resume before authorization or dispatch", async () => {
  const response = await POST(new Request(`http://localhost/api/ingestion/${jobId}`, { method: "POST", headers: { origin: "https://untrusted.invalid" } }), context);
  expect(response.status).toBe(403); expect(calls.authorize).not.toHaveBeenCalled(); expect(calls.dispatch).not.toHaveBeenCalled();
});
it("resumes the original operation after authorization, not a new job", async () => {
  const response = await POST(new Request(`http://localhost/api/ingestion/${jobId}`, { method: "POST" }), context);
  expect(response.status).toBe(200);
  expect(calls.rpc).toHaveBeenCalledWith("fireafter_resume_ingestion", { p_id: jobId, p_actor: "actor", p_org: "org" });
  expect(calls.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: jobId }));
});
