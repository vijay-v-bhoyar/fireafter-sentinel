import { afterEach, expect, it, vi } from "vitest";
import { fetchHistoryPage, fetchHistoryRecord } from "./history-client";
const id = "10000000-0000-4000-8000-000000000001";
const query = { incidentId: "county", lane: "actions" as const, limit: "25" };
const user = { actorId: id, organizationId: id };
const page = { incidentId: "county", databaseIncidentId: id, canonicalIncidentId: "county", lane: "actions", limit: 25,
  commandId: null, entries: [], nextCursor: null };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("sends expected identity with a bounded uncached read", async () => {
  const fetcher = vi.fn(async () => Response.json(page));
  expect(await fetchHistoryPage(query, user, new AbortController().signal, fetcher)).toEqual(page);
  expect(fetcher.mock.calls[0]).toEqual(["/api/history?incidentId=county&lane=actions&limit=25", expect.objectContaining({ cache: "no-store",
    headers: { "x-fireafter-actor": id, "x-fireafter-organization": id }, signal: expect.any(AbortSignal) })]);
});
it.each([{ lane: "audit" }, { incidentId: "other" }, { commandId: id }, { limit: 50 }, { entries: [{ id: "bad" }] }])("rejects mismatched/malformed response %j", async change => {
  await expect(fetchHistoryPage(query, user, new AbortController().signal, async () => Response.json({ ...page, ...change }))).rejects.toThrow();
});
it.each([400, 401, 403, 503])("returns safe error for HTTP %s", async status => {
  await expect(fetchHistoryPage(query, user, new AbortController().signal, async () => new Response("PRIVATE_PROVIDER", { status }))).rejects.not.toThrow("PRIVATE");
});
it("does not accept an unchanged pagination cursor", async () => {
  await expect(fetchHistoryPage({ ...query, cursor: "abc" }, user, new AbortController().signal, async () => Response.json({ ...page, nextCursor: "abc" }))).rejects.toThrow();
});
it("cancels an indefinitely delayed body at the actual client deadline", async () => {
  vi.useFakeTimers(); let canceled = false;
  const operation = fetchHistoryPage(query, user, new AbortController().signal, async () => new Response(new ReadableStream({ cancel() { canceled = true; } })));
  const check = expect(operation).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(15_001); await check; expect(canceled).toBe(true);
});
it("rejects oversized bodies rather than accepting their prefix", async () => {
  await expect(fetchHistoryPage(query, user, new AbortController().signal, async () => new Response("x".repeat(2 * 1024 * 1024 + 1)))).rejects.toMatchObject({ code: "too_large" });
});

const recordQuery = { incidentId: "county", lane: "actions" as const, recordId: id };
const evidence = { incidentId: "county", databaseIncidentId: id, canonicalIncidentId: "county", lane: "actions",
  record: { id, createdAt: "2026-09-14T00:00:00.000001Z", type: "annotate", actorId: null,
    actorName: "Historical reviewer", summary: "Recorded responder decision", provenanceFlag: true,
    details: { note: "Recorded original note", recommendationSnapshot: { id: "retired" } } } };
it("retrieves original evidence independently with authority and no-store", async () => {
  const fetcher = vi.fn(async () => Response.json(evidence));
  expect(await fetchHistoryRecord(recordQuery, user, new AbortController().signal, fetcher)).toEqual(evidence);
  expect(fetcher.mock.calls[0]).toEqual([`/api/history?incidentId=county&lane=actions&recordId=${id}`, expect.objectContaining({
    cache: "no-store", headers: { "x-fireafter-actor": id, "x-fireafter-organization": id } })]);
});
it.each([{ incidentId: "other" }, { lane: "audit" }, { record: { ...evidence.record, id: "10000000-0000-4000-8000-000000000002" } }])("rejects evidence for another requested scope %j", async change => {
  await expect(fetchHistoryRecord(recordQuery, user, new AbortController().signal, async () => Response.json({ ...evidence, ...change }))).rejects.toThrow();
});
it.each([401, 403, 404, 413, 503])("does not expose provider errors for evidence HTTP %s", async status => {
  await expect(fetchHistoryRecord(recordQuery, user, new AbortController().signal, async () => new Response("PRIVATE_PROVIDER", { status }))).rejects.toMatchObject({ status });
  await expect(fetchHistoryRecord(recordQuery, user, new AbortController().signal, async () => new Response("PRIVATE_PROVIDER", { status }))).rejects.not.toThrow("PRIVATE_PROVIDER");
});
it("cancels a stalled evidence body and leaves its outcome unavailable", async () => {
  vi.useFakeTimers(); let canceled = false;
  const result = fetchHistoryRecord(recordQuery, user, new AbortController().signal, async () => new Response(new ReadableStream({ cancel() { canceled = true; } })));
  const check = expect(result).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(15_001); await check; expect(canceled).toBe(true);
});
it("rejects evidence above the reader ceiling", async () => {
  await expect(fetchHistoryRecord(recordQuery, user, new AbortController().signal, async () => new Response("x".repeat(8 * 1024 * 1024 + 1)))).rejects.toMatchObject({ code: "too_large" });
});
