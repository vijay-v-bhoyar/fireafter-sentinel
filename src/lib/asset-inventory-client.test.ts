import { expect, it, vi } from "vitest";
import { fetchAssetInventoryPage } from "./asset-inventory-client";
import { inventoryPage, inventoryUser } from "../test/asset-page-fixture";
const query = { incidentId: "county", start: "0", limit: "25" as const };
const authority = { actorId: inventoryUser.id, organizationId: inventoryUser.organizationId };
it("sends incident-bound authority and no-store for a validated complete page", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(inventoryPage()));
  expect(await fetchAssetInventoryPage(query, authority, new AbortController().signal, fetcher)).toEqual(inventoryPage());
  expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { "x-fireafter-actor": authority.actorId, "x-fireafter-organization": authority.organizationId } });
});
it.each(["incident", "revision", "limit", "position", "missing", "next", "extra"])("rejects %s contract drift", async defect => {
  const page = inventoryPage();
  if (defect === "incident") page.incidentId = "other";
  if (defect === "revision") page.revision = inventoryUser.id;
  if (defect === "limit") page.limit = 50;
  if (defect === "position") page.items[0].position = 2;
  if (defect === "missing") page.items.pop();
  if (defect === "next") page.nextStart = null;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(defect === "extra" ? { ...page, rawCredentials: "no" } : page));
  await expect(fetchAssetInventoryPage({ ...query, revision: inventoryPage().revision }, authority, new AbortController().signal, fetcher)).rejects.toBeTruthy();
});
it.each([401, 403, 409, 503])("reports a safe %s response", async status => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("PRIVATE", { status }));
  try { await fetchAssetInventoryPage(query, authority, new AbortController().signal, fetcher); throw new Error("Expected denial"); }
  catch (error) { expect(error).toMatchObject({ status }); expect(String(error)).not.toContain("PRIVATE"); }
});
