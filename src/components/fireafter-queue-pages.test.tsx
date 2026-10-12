// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FireAfterDashboard } from "./fireafter-dashboard";
import { queueBundle, queuePage } from "../test/queue-page-fixture";
import { createTestStorage } from "../test/browser-storage";
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("localStorage", createTestStorage()); vi.stubGlobal("fetch", fetcher); fetcher.mockImplementation(async input => {
  const url = new URL(String(input), "https://app.test"); if (url.pathname !== "/api/queue/page") throw new Error(`Unexpected request ${url.pathname}`);
  return Response.json(queuePage(Number(url.searchParams.get("start")), Number(url.searchParams.get("limit"))));
}); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("pages the actual dashboard with full stored totals and no eager map request", async () => {
  render(<FireAfterDashboard bundle={queueBundle()} initialView="queue" />);
  expect(screen.getByText("26 stored queue positions")).toBeTruthy(); expect(screen.queryByText("No crossings loaded")).toBeNull();
  expect(screen.getAllByRole("heading", { level: 3 }).slice(0, 10).map(node => node.textContent)).toEqual(Array.from({ length: 10 }, (_, i) => `Bridge ${i + 1}`));
  expect(screen.getByRole("link", { name: "Open Map View" }).getAttribute("href")).toBe("/map?incidentId=county");
  fireEvent.click(screen.getByRole("button", { name: "Next queue page" })); await screen.findByRole("heading", { name: "Bridge 20" });
  expect(String(fetcher.mock.calls[0][0])).toContain("start=10"); expect(String(fetcher.mock.calls[0][0])).toContain("state=current");
  fireEvent.click(screen.getByRole("button", { name: "Next queue page" })); await screen.findByRole("heading", { name: "Bridge 26" });
  expect((screen.getByRole("button", { name: "Next queue page" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous queue page" })); await screen.findByRole("heading", { name: "Bridge 20" });
  fireEvent.change(screen.getByRole("combobox", { name: "Queue page size" }), { target: { value: "1" } });
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Bridge 20" })).toBeNull());
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("/api/queue/page?"))).toBe(true);
});
it("explains withheld slots without claiming an empty county", () => {
  const page = queuePage(0, 1); page.items[0] = { position: 1, status: "withheld", reason: "outside-county" };
  render(<FireAfterDashboard bundle={queueBundle(page)} initialView="queue" />);
  expect(screen.getByText(/Position 1 withheld/)).toBeTruthy(); expect(screen.queryByText(/No source-backed recommendations yet/)).toBeNull();
});
it("hides old cards and recovers from failure with a smaller page", async () => {
  fetcher.mockResolvedValueOnce(new Response("PRIVATE", { status: 503 })); render(<FireAfterDashboard bundle={queueBundle()} initialView="queue" />);
  fireEvent.click(screen.getByRole("button", { name: "Next queue page" })); await screen.findByRole("alert");
  expect(screen.queryByRole("heading", { name: "Bridge 2" })).toBeNull(); expect(screen.getByRole("alert").textContent).not.toContain("PRIVATE");
  fireEvent.change(screen.getByRole("combobox", { name: "Queue page size" }), { target: { value: "1" } });
  await screen.findAllByRole("heading", { name: "Bridge 1", level: 3 }); expect(screen.queryByRole("alert")).toBeNull();
});
it("withdraws stale order after open-tab expiry and requires restart", async () => {
  vi.useFakeTimers(); const page = queuePage(); page.expiresAt = new Date(Date.now() + 500).toISOString();
  render(<FireAfterDashboard bundle={queueBundle(page)} initialView="queue" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(15001); });
  expect(screen.getByRole("alert").textContent).toContain("Evidence expired"); expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  expect((screen.getByRole("button", { name: "Next queue page" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Start from first page" }) as HTMLButtonElement).disabled).toBe(false);
});
it("aborts a pending page and discards its response when the authority-keyed dashboard remounts", async () => {
  let release!: (value: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = render(<FireAfterDashboard key="first-authority" bundle={queueBundle()} initialView="queue" />);
  fireEvent.click(screen.getByRole("button", { name: "Next queue page" })); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const bundle = queueBundle(); bundle.currentUser = { ...bundle.currentUser!, id: "10000000-0000-4000-8000-000000000006" };
  view.rerender(<FireAfterDashboard key="second-authority" bundle={bundle} initialView="queue" />);
  await waitFor(() => expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true));
  await act(async () => release(Response.json(queuePage(10))));
  expect(screen.queryByRole("heading", { name: "Bridge 20" })).toBeNull(); expect(screen.queryByRole("alert")).toBeNull();
});
