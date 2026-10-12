// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HistoryExplorer } from "./history-explorer";
const id = "10000000-0000-4000-8000-000000000001";
const user = { id, organizationId: id, role: "analyst" as const, email: "test@example.test" };
const entry = { id, createdAt: "2026-09-14T00:00:00.000001Z", type: "annotate", actorId: id, actorName: "County reviewer", summary: "Retired crossing decision" };
const page = { incidentId: "county", databaseIncidentId: id, canonicalIncidentId: "county", lane: "actions", limit: 25,
  commandId: null, entries: [entry], nextCursor: "next" };
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("returns from retained history to the same incident on every workspace page", async () => {
  fetcher.mockResolvedValue(Response.json({ ...page, nextCursor: null }));
  render(<HistoryExplorer incidentId="county" user={user} />);
  await screen.findByText("Retired crossing decision");
  for (const [label, path] of [["Action Queue", "/"], ["Map View", "/map"], ["Assets", "/assets"], ["Settings", "/settings"]]) {
    expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(`${path}?incidentId=county`);
  }
});
it("paginates older records and supports previous/latest without accumulating private payloads", async () => {
  fetcher.mockImplementation(async input => String(input).includes("cursor=next") ? Response.json({ ...page, entries: [{ ...entry, id: id.replace(/1$/, "2"), summary: "Older retained record" }], nextCursor: null }) : Response.json(page));
  render(<HistoryExplorer incidentId="county" user={user} />);
  await screen.findByText("Retired crossing decision"); fireEvent.click(screen.getByRole("button", { name: "Older records" }));
  await screen.findByText("Older retained record"); expect(screen.queryByText("Retired crossing decision")).toBeNull();
  expect((screen.getByRole("button", { name: "Older records" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous page" })); await screen.findByText("Retired crossing decision");
  fireEvent.click(screen.getByRole("button", { name: "Latest records" })); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
});
it("retains failure guidance and retries the failed page without calling it empty", async () => {
  fetcher.mockResolvedValueOnce(new Response("PRIVATE", { status: 503 })).mockResolvedValue(Response.json({ ...page, entries: [], nextCursor: null }));
  render(<HistoryExplorer incidentId="county" user={user} />);
  expect((await screen.findByRole("alert")).textContent).not.toContain("PRIVATE"); expect(screen.queryByText(/No retained records/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry history" })); await screen.findByText(/No retained records on this page/);
});
it("rejects invalid command IDs before dispatch and clears the filter", async () => {
  fetcher.mockImplementation(async () => Response.json({ ...page, nextCursor: null }));
  render(<HistoryExplorer incidentId="county" user={user} />); await screen.findByText("Retired crossing decision");
  fireEvent.change(screen.getByRole("textbox", { name: "Command ID (optional)" }), { target: { value: "not-a-uuid" } });
  fireEvent.click(screen.getByRole("button", { name: "Find command" })); await screen.findByText(/Enter a valid command UUID/); expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" })); await screen.findByText("Retired crossing decision"); expect(fetcher).toHaveBeenCalledTimes(2);
});
it("switches streams and page sizes with no previous cursor", async () => {
  fetcher.mockImplementation(async input => { const query = new URL(String(input), "https://app.test").searchParams;
    return Response.json({ ...page, lane: query.get("lane"), limit: Number(query.get("limit")), nextCursor: null }); });
  render(<HistoryExplorer incidentId="county" user={user} />); await screen.findByText("Retired crossing decision");
  fireEvent.change(screen.getByRole("combobox", { name: "Records" }), { target: { value: "audit" } }); await screen.findByText("Retired crossing decision");
  fireEvent.change(screen.getByRole("combobox", { name: "Page size" }), { target: { value: "1" } }); await screen.findByText("Retired crossing decision");
  expect(String(fetcher.mock.calls.at(-1)![0])).toContain("lane=audit&limit=1"); expect(String(fetcher.mock.calls.at(-1)![0])).not.toContain("cursor");
});
it("never publishes a late response after actor or incident changes", async () => {
  let release!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockImplementation(async () => Response.json({ ...page, incidentId: "other", canonicalIncidentId: "other", entries: [], nextCursor: null }));
  const view = render(<HistoryExplorer incidentId="county" user={user} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  view.rerender(<HistoryExplorer incidentId="other" user={{ ...user, id: id.replace(/1$/, "2") }} />);
  await screen.findByText(/No retained records on this page/); release(Response.json(page));
  await waitFor(() => expect(screen.queryByText("Retired crossing decision")).toBeNull());
});
it("reads evidence only on demand and keeps evidence errors separate from pagination", async () => {
  fetcher.mockImplementation(async input => String(input).includes("recordId=") ? new Response("PRIVATE", { status: 503 }) : Response.json(page));
  render(<HistoryExplorer incidentId="county" user={user} />); await screen.findByText("Retired crossing decision");
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Read recorded evidence" }));
  expect((await screen.findByRole("alert")).textContent).not.toContain("PRIVATE");
  expect((screen.getByRole("button", { name: "Older records" }) as HTMLButtonElement).disabled).toBe(false);
});
