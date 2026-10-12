import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as summary } from "@/app/api/sentinel/evidence/route";
import { GET as changes } from "@/app/api/sentinel/source-changes/route";
import { GET as document } from "@/app/api/sentinel/documents/[id]/route";
import { SentinelSourceError } from "./sources";
import { SentinelReadError } from "./store";
import { encodeSourceChangeCursor } from "./evidence-http";
import { SENTINEL_LIMITS } from "./contracts";
const reader = vi.hoisted(() => ({ summary: vi.fn(), changes: vi.fn(), document: vi.fn() }));
vi.mock("./sources", async original => ({ ...await original<typeof import("./sources")>(), readEvidenceSummary: reader.summary, readSourceChangePage: reader.changes }));
vi.mock("./store", async original => ({ ...await original<typeof import("./store")>(), readDocumentVersion: reader.document }));
const id = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const locator = `incidentId=${id(2)}&mode=synthetic`;
const request = (query = locator) => new Request(`http://127.0.0.1:3020/api/sentinel/evidence?${query}`);
const context = { params: Promise.resolve({ id: id(5) }) };
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" };
const page = { scope, evidenceGeneration: 26, unresolvedSourceChanges: 25, observedAt: "2026-10-11T10:00:00Z", items: [], hasMore: false, nextAfterGeneration: null };
const all = (query = locator) => Promise.all([summary(request(query)), changes(request(query)), document(request(query), context)]);
beforeEach(() => { vi.resetAllMocks(); reader.summary.mockResolvedValue({ scope, configuration: null, documents: [] }); reader.changes.mockResolvedValue(page); reader.document.mockResolvedValue({ id: id(5), scope }); });
describe("Authenticated Sentinel evidence read HTTP contracts", () => {
  it("passes only an explicit locator to each scoped reader and disables caching/sniffing", async () => {
    for (const response of await all()) {
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(reader.summary).toHaveBeenCalledExactlyOnceWith(id(2), "synthetic");
    expect(reader.changes).toHaveBeenCalledExactlyOnceWith(id(2), "synthetic", 0);
    expect(reader.document).toHaveBeenCalledExactlyOnceWith(id(2), "synthetic", id(5));
  });
  it.each(["", `incidentId=${id(2)}`, "incidentId=invalid&mode=synthetic", `incidentId=${id(2)}&mode=unknown`,
    `${locator}&incidentId=${id(3)}`, `${locator}&mode=live`, `${locator}&actorId=${id(9)}`, `${locator}&organizationId=${id(9)}`, `${locator}&afterGeneration=1`, `${locator}&cursor=`])("rejects missing, duplicate or authority-bearing query before reader calls %s", async query => {
    for (const response of await all(query)) expect(response.status).toBe(400);
    expect(reader.summary).not.toHaveBeenCalled(); expect(reader.changes).not.toHaveBeenCalled(); expect(reader.document).not.toHaveBeenCalled();
  });
  it("requires a valid immutable version ID", async () => {
    expect((await document(request(), { params: Promise.resolve({ id: "invalid" }) })).status).toBe(400);
    expect(reader.document).not.toHaveBeenCalled();
  });
  it("returns identical absence for inaccessible and nonexistent scoped records", async () => {
    reader.summary.mockResolvedValue(null); reader.changes.mockResolvedValue(null); reader.document.mockResolvedValue(null);
    const responses = await all(); for (const response of responses) expect(response.status).toBe(404);
    expect(await responses[0].json()).toEqual(await responses[1].json());
  });
  it.each([["AUTH_REQUIRED", 401], ["SCOPE_DENIED", 403], ["INPUT_INVALID", 400], ["SOURCE_CONFLICT", 409], ["STORAGE_UNAVAILABLE", 503]] as const)("maps safe %s errors to %s", async (code, status) => {
    const error = new SentinelSourceError(code); reader.summary.mockRejectedValue(error); reader.changes.mockRejectedValue(error); reader.document.mockRejectedValue(error);
    for (const response of await all()) { expect(response.status).toBe(status); expect((await response.json()).code).toBe(code); }
  });
  it("maps version-reader errors and does not expose unexpected exceptions", async () => {
    reader.document.mockRejectedValueOnce(new SentinelReadError("SCOPE_DENIED")); expect((await document(request(), context)).status).toBe(403);
    const error = new Error("PRIVATE_CONNECTION_PASSWORD"); reader.summary.mockRejectedValue(error); reader.changes.mockRejectedValue(error); reader.document.mockRejectedValue(error);
    for (const response of await all()) { expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE_CONNECTION_PASSWORD"); }
  });
  it("fails closed on an oversized serialized response", async () => {
    reader.document.mockResolvedValue({ normalizedText: "\u0001".repeat(SENTINEL_LIMITS.providerResponseBytes / 6 + 1) });
    const response = await document(request(), context); expect(response.status).toBe(503);
    expect((await response.text()).length).toBeLessThan(200);
  });
  it("round trips a scoped opaque cursor without exposing the internal cursor field", async () => {
    const token = encodeSourceChangeCursor(id(2), "synthetic", 25);
    reader.changes.mockResolvedValue({ ...page, evidenceGeneration: 51, unresolvedSourceChanges: 50, items: Array.from({ length: 25 }, (_, n) => ({
      id: id(100 + n), documentId: id(3), versionId: id(200 + n), previousVersionId: id(199 + n), runId: id(6),
      evidenceGeneration: 26 + n, createdAt: page.observedAt,
    })), hasMore: true, nextAfterGeneration: 50 });
    const response = await changes(request(`${locator}&cursor=${token}`)); const result = await response.json();
    expect(reader.changes).toHaveBeenCalledExactlyOnceWith(id(2), "synthetic", 25);
    expect(result.nextCursor).toBe(encodeSourceChangeCursor(id(2), "synthetic", 50)); expect(result).not.toHaveProperty("nextAfterGeneration");
    expect((await summary(request(`${locator}&cursor=${token}`))).status).toBe(400);
    expect((await document(request(`${locator}&cursor=${token}`), context)).status).toBe(400);
  });
  it.each(["*", "a".repeat(257), "eyJ2IjoxfQ", encodeSourceChangeCursor(id(3), "synthetic", 25), encodeSourceChangeCursor(id(2), "live", 25),
    Buffer.from(JSON.stringify({ v: 1, incidentId: id(2), mode: "synthetic", afterGeneration: -1 })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, incidentId: id(2), mode: "synthetic", afterGeneration: 1, actorId: id(9) })).toString("base64url"),
  ])("rejects malformed or misbound cursor %s before a reader call", async token => {
    expect((await changes(request(`${locator}&cursor=${token}`))).status).toBe(400); expect(reader.changes).not.toHaveBeenCalled();
  });
  it("rejects duplicate cursor parameters", async () => {
    const token = encodeSourceChangeCursor(id(2), "synthetic", 25);
    expect((await changes(request(`${locator}&cursor=${token}&cursor=${token}`))).status).toBe(400); expect(reader.changes).not.toHaveBeenCalled();
  });
  it("normalizes UUID case before comparing scoped database identities", async () => {
    const upper = "ABCDEF00-0000-4000-8000-000000000002";
    await summary(request(`incidentId=${upper}&mode=synthetic`));
    await document(request(`incidentId=${upper}&mode=synthetic`), { params: Promise.resolve({ id: upper }) });
    expect(reader.summary).toHaveBeenCalledWith(upper.toLowerCase(), "synthetic");
    expect(reader.document).toHaveBeenCalledWith(upper.toLowerCase(), "synthetic", upper.toLowerCase());
  });
});
