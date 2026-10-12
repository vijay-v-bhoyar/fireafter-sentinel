import { expect, it, vi } from "vitest";
import { fetchQueuePage } from "./queue-page-client";
import { queuePage } from "../test/queue-page-fixture";
const authority = { actorId: "actor", organizationId: "org" };
it("sends revision, state and authority with no-store semantics", async () => {
  const page = queuePage(10), fetcher = vi.fn(async () => Response.json(page));
  await fetchQueuePage({ incidentId: "county", start: "10", limit: "10", revision: page.revision, state: "current" }, authority, new AbortController().signal, fetcher);
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]; expect(url).toContain("state=current"); expect(url).toContain(`revision=${page.revision}`);
  expect(options.cache).toBe("no-store"); expect(new Headers(options.headers).get("x-fireafter-actor")).toBe("actor");
});
it.each(["wrong-incident", "wrong-revision", "wrong-order", "short-page", "wrong-next", "duplicate", "expired-score"])("rejects %s", async defect => {
  const page = queuePage();
  if (defect === "wrong-incident") page.canonicalIncidentId = "other";
  if (defect === "wrong-revision") page.revision = "10000000-0000-4000-8000-000000000005";
  if (defect === "wrong-order") page.items.reverse();
  if (defect === "short-page") page.items.pop();
  if (defect === "wrong-next") page.nextStart = 20;
  if (defect === "duplicate" && page.items[0].status === "available" && page.items[1].status === "available") page.items[1].recommendation.id = page.items[0].recommendation.id;
  if (defect === "expired-score") { page.state = "expired"; page.expiresAt = null; }
  await expect(fetchQueuePage({ incidentId: "county", start: "0", limit: "10" }, authority, new AbortController().signal, async () => Response.json(page))).rejects.toBeInstanceOf(Error);
});
it.each([401, 403, 409, 503])("hides raw %s error bodies", async status => {
  await expect(fetchQueuePage({ incidentId: "county", start: "0", limit: "10" }, authority, new AbortController().signal, async () => new Response("PRIVATE", { status }))).rejects.not.toHaveProperty("message", "PRIVATE");
});
