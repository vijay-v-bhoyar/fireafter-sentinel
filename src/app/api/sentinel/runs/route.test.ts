import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { GET } from "./[id]/route";
import { POST as CANCEL } from "./[id]/cancel/route";
import { SentinelRunError } from "@/lib/sentinel/runs";
import { SENTINEL_LIMITS } from "@/lib/sentinel/contracts";

const service = vi.hoisted(() => ({ admit: vi.fn(), read: vi.fn(), cancel: vi.fn(),dispatch:vi.fn() }));
vi.mock("@/lib/sentinel/dispatch",()=>({dispatchSentinel:service.dispatch}));
vi.mock("@/lib/sentinel/runs", async original => ({ ...await original<typeof import("@/lib/sentinel/runs")>(),
  admitRun: service.admit, readRun: service.read, cancelRun: service.cancel }));
const id = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body = { incidentId: id(1), sourceConfigRevision: id(2), mode: "synthetic", commandId: id(3) };
const run = { id: id(4), scope: { organizationId: id(5), incidentId: id(1), mode: "synthetic" }, status: "queued" };
const context = { params: Promise.resolve({ id: run.id }) };
const base = "http://127.0.0.1:3020/api/sentinel/runs";
const crossOriginHeaders: Record<string, string>[] = [{ origin: "https://attacker.example" }, { "sec-fetch-site": "cross-site" }];
const mutation = (value: unknown = body, headers: Record<string, string> = {}) => new Request(base, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value),
});
beforeEach(() => { vi.resetAllMocks(); service.admit.mockResolvedValue({ run, receipt: { runId: run.id }, replayed: false }); service.read.mockResolvedValue(run); service.cancel.mockResolvedValue({ run: { ...run, status: "canceled" } });service.dispatch.mockResolvedValue({dispatchPending:false}); });
describe("Sentinel run HTTP boundary", () => {
  it("returns scoped status URL and queued admission without pretending providers executed", async () => {
    const response = await POST(mutation()); const result = await response.json();
    expect(response.status).toBe(202); expect(result.runId).toBe(run.id); expect(result.run.status).toBe("queued");
    expect(result.statusUrl).toBe(`/api/sentinel/runs/${run.id}?incidentId=${id(1)}&mode=synthetic`);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
    expect(service.admit).toHaveBeenCalledExactlyOnceWith(body);
    expect(service.dispatch).toHaveBeenCalledExactlyOnceWith(run);
  });
  it("returns durable admission with unconfirmed dispatch without claiming rollback or completion",async()=>{
    service.dispatch.mockResolvedValue({dispatchPending:true});const response=await POST(mutation());const result=await response.json();expect(response.status).toBe(202);expect(result.dispatchPending).toBe(true);expect(result.runId).toBe(run.id);expect(result.run.status).toBe("queued");
  });
  it.each(crossOriginHeaders)("rejects cross-origin mutation before service calls %j", async headers => {
    expect((await POST(mutation(body, headers))).status).toBe(403);
    expect((await CANCEL(mutation({ incidentId: id(1), mode: "synthetic", commandId: id(3) }, headers), context)).status).toBe(403);
    expect(service.admit).not.toHaveBeenCalled(); expect(service.cancel).not.toHaveBeenCalled();
  });
  it("rejects declared and streamed excess size, compressed and malformed JSON", async () => {
    expect((await POST(mutation(body, { "content-length": String(SENTINEL_LIMITS.mutationBytes + 1) }))).status).toBe(413);
    expect((await POST(mutation({ padding: "x".repeat(SENTINEL_LIMITS.mutationBytes) }))).status).toBe(413);
    expect((await POST(mutation(body, { "content-encoding": "gzip" }))).status).toBe(415);
    expect((await POST(new Request(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }))).status).toBe(400);
    expect((await POST(mutation(body, { "content-type": "text/plain" }))).status).toBe(415);
    expect(service.admit).not.toHaveBeenCalled();
  });
  it("reads an explicit scoped locator and returns indistinguishable absence", async () => {
    const request = new Request(`${base}/${run.id}?incidentId=${id(1)}&mode=synthetic`);
    expect((await GET(request, context)).status).toBe(200);
    expect(service.read).toHaveBeenCalledExactlyOnceWith({ runId: run.id, incidentId: id(1), mode: "synthetic" });
    service.read.mockResolvedValue(null); expect((await GET(request, context)).status).toBe(404);
  });
  it.each(["", `?incidentId=${id(1)}`, `?incidentId=${id(1)}&incidentId=${id(2)}&mode=synthetic`, `?incidentId=${id(1)}&mode=synthetic&role=incident_commander`])("denies ambiguous status query %s", async query => {
    expect((await GET(new Request(`${base}/${run.id}${query}`), context)).status).toBe(400);
    expect(service.read).not.toHaveBeenCalled();
  });
  it("uses the route run ID and rejects body-supplied identity fields", async () => {
    const payload = { incidentId: id(1), mode: "synthetic", commandId: id(3) };
    expect((await CANCEL(mutation(payload), context)).status).toBe(200);
    expect(service.cancel).toHaveBeenCalledExactlyOnceWith({ ...payload, runId: run.id });
    service.cancel.mockClear();
    expect((await CANCEL(mutation({ ...payload, runId: id(99) }), context)).status).toBe(400);
    expect((await CANCEL(mutation({ ...payload, actorId: id(99) }), context)).status).toBe(400);
    expect(service.cancel).not.toHaveBeenCalled();
  });
  it.each([["AUTH_REQUIRED", 401], ["SCOPE_DENIED", 403], ["RUN_CONFLICT", 409], ["RUN_BUSY", 409], ["BUDGET_STOPPED", 429], ["STORAGE_UNAVAILABLE", 503]] as const)("returns safe %s as HTTP %s", async (code, status) => {
    service.admit.mockRejectedValue(new SentinelRunError(code));
    const response = await POST(mutation()); expect(response.status).toBe(status); expect((await response.json()).code).toBe(code);
  });
  it("never exposes unexpected database/provider errors", async () => {
    service.admit.mockRejectedValue(new Error("PRIVATE_CONNECTION_AND_KEY"));
    const response = await POST(mutation()); expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE_CONNECTION_AND_KEY");
  });
});
