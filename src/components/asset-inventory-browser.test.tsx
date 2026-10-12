// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssetInventoryBrowser } from "./asset-inventory-browser";
import { inventoryPage, inventoryUser as user } from "../test/asset-page-fixture";
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); fetcher.mockImplementation(async input => {
  const params = new URL(String(input), "https://app.test").searchParams;
  return Response.json(inventoryPage(Number(params.get("start")), Number(params.get("limit"))));
}); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps incident scope, page order and published revision across next/previous/jump", async () => {
  render(<AssetInventoryBrowser incidentId="county" user={user} />); await screen.findByText("Bridge 1");
  expect(screen.getByRole("link", { name: "Assets & Upload" }).getAttribute("href")).toBe("/assets?incidentId=county");
  fireEvent.click(screen.getByRole("button", { name: "Next page" })); await screen.findByText("Bridge 26");
  expect(String(fetcher.mock.calls.at(-1)![0])).toContain(`revision=${inventoryPage().revision}`);
  expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous page" })); await screen.findByText("Bridge 1");
  fireEvent.change(screen.getByRole("textbox", { name: "Start at record" }), { target: { value: "26" } });
  fireEvent.click(screen.getByRole("button", { name: "Go to record" })); await screen.findByText("Bridge 26");
  fireEvent.click(screen.getByRole("button", { name: "Latest inventory" })); await screen.findByText("Bridge 1");
  expect(String(fetcher.mock.calls.at(-1)![0])).not.toContain("revision=");
});
it("recovers from a failed page using a smaller size without claiming zero assets", async () => {
  fetcher.mockResolvedValueOnce(new Response("PRIVATE", { status: 503 }));
  render(<AssetInventoryBrowser incidentId="county" user={user} />); expect((await screen.findByRole("alert")).textContent).not.toContain("PRIVATE");
  expect(screen.queryByText(/No stored asset/)).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Records per page" }), { target: { value: "1" } });
  await screen.findByText("Bridge 1"); expect(screen.queryByText("Bridge 2")).toBeNull();
});
it("explains withheld slots and renders stored evidence only as text", async () => {
  const page = inventoryPage(0, 25, 2); page.items[1] = { position: 2, status: "withheld", reason: "outside-county" };
  if (page.items[0].status === "available") page.items[0].asset.sourceUrl = "javascript:alert(1)";
  fetcher.mockResolvedValue(Response.json(page)); render(<AssetInventoryBrowser incidentId="county" user={user} />);
  await screen.findByText("Record 2: withheld"); expect(screen.getByText(/Totals count saved manifest/)).toBeTruthy();
  expect(screen.queryByRole("link", { name: /javascript/ })).toBeNull();
});
it("discards late responses when identity or incident changes", async () => {
  let release!: (value: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockImplementation(async () => Response.json({ ...inventoryPage(0, 25, 0), incidentId: "other", canonicalIncidentId: "other" }));
  const view = render(<AssetInventoryBrowser incidentId="county" user={user} />); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  view.rerender(<AssetInventoryBrowser incidentId="other" user={{ ...user, id: user.organizationId }} />);
  await screen.findByText(/No stored asset records/); release(Response.json(inventoryPage()));
  await waitFor(() => expect(screen.queryByText("Bridge 1")).toBeNull());
});
