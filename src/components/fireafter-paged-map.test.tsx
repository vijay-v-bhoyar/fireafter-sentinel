// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FireAfterDashboard } from "./fireafter-dashboard";
import { queueBundle, queuePage } from "../test/queue-page-fixture";
import { createTestStorage } from "../test/browser-storage";
import { installCanvasSurface } from "../test/canvas-surface";
import { mapStreamResponse } from "../lib/map-stream-response";
import { projectBundleFreshness } from "../lib/source-freshness";
vi.mock("next/navigation", () => ({ usePathname: () => "/map", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const fetcher = vi.fn<typeof fetch>();
const empty = () => ({ type: "FeatureCollection", features: [] });
const geometry = () => ({ incidentId: "county", county: empty(), roads: empty(), hydrography: empty(), pwfdfBasins: empty(), assets: empty(), recommendations: empty() });
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("localStorage", createTestStorage()); vi.stubGlobal("fetch", fetcher); installCanvasSurface();
  fetcher.mockImplementation(async input => {
    expect(String(input)).toBe("/api/map/features?incidentId=county"); return mapStreamResponse(geometry());
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("opens a 91,511-position map page with explicit partial priority scope and a separate complete-layer request", async () => {
  const bundle = queueBundle(queuePage(0, 10, 91511));
  render(<FireAfterDashboard bundle={bundle} initialView="map" />);
  expect(screen.getByText("91,511 stored queue positions")).toBeTruthy();
  expect(screen.getByText(/Initial priority page: 10 stored positions, 10 available and 0 withheld/)).toBeTruthy();
  expect(screen.queryByText("No crossings loaded")).toBeNull();
  expect(screen.getByRole("link", { name: "Browse the complete Action Queue" }).getAttribute("href")).toBe("/?incidentId=county");
  await waitFor(() => expect(screen.queryByText("Loading current source geometry.")).toBeNull());
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not renumber a withheld priority as another asset's rank", async () => {
  const page = queuePage(); page.items[0] = { position: 1, status: "withheld", reason: "unverified-geometry" };
  const bundle = queueBundle(page); bundle.sourceSnapshots = [];
  render(<FireAfterDashboard bundle={projectBundleFreshness(bundle)} initialView="map" />);
  const priority = screen.getByRole("button", { name: /2\. Bridge 2/ }); expect(priority).toBeTruthy();
  expect(screen.queryByRole("button", { name: /1\. Bridge 2/ })).toBeNull();
  const marker = screen.getByRole("button", { name: "Select Bridge 2" }); expect(marker.textContent).toBe("2");
  expect(screen.getByText(/10 stored positions, 9 available and 1 withheld/)).toBeTruthy();
  const sidebar = screen.getByRole("heading", { name: "Selected Map Priorities" }).closest("section")!;
  expect(within(sidebar).getAllByRole("button").map(button => button.querySelector("p")?.textContent)).toEqual([
    "2. Bridge 2", "3. Bridge 3", "4. Bridge 4", "5. Bridge 5", "6. Bridge 6",
  ]);
  fireEvent.click(priority); expect(marker.className).toContain("border-white");
  await waitFor(() => expect(screen.queryByText("Loading current source geometry.")).toBeNull());
});

it("retains the server-validated boundary even if the complete geometry request fails, without claiming loaded vectors", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); fetcher.mockResolvedValue(new Response("PRIVATE", { status: 503 }));
  const bundle = queueBundle(); bundle.incident.locationContext = { id: "county", county: "County", state: "CA", label: "County, CA", centroid: [-118.5, 34.5], bbox: [-119, 34, -118, 35], fips: "06037", fireWeatherZone: "", population: 0, wildfireContext: "Context", boundary: {
    type: "Polygon", coordinates: [[[-119, 34], [-118, 34], [-118, 35], [-119, 35], [-119, 34]]] } };
  const view = render(<FireAfterDashboard bundle={bundle} initialView="map" />);
  expect(view.container.querySelector('path[fill-rule="evenodd"]')).not.toBeNull();
  await screen.findByRole("button", { name: "Retry map" });
  expect(screen.getByText("Road Network").parentElement?.textContent).not.toMatch(/loaded$/);
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
});

it("does not silently retry a failed bounded page as an aggregate map fetch", async () => {
  const bundle = { ...queueBundle(), dataAvailability: "unavailable" as const, queuePage: undefined, recommendations: [], assets: [] };
  render(<FireAfterDashboard bundle={bundle} initialView="map" />);
  expect(screen.getByRole("alert", { name: "Live incident data unavailable" })).toBeTruthy();
  expect(screen.queryByText("Selected Map Priorities")).toBeNull(); await act(async () => {}); expect(fetcher).not.toHaveBeenCalled();
});

it("withdraws paged priority markers when evidence expires while the map remains open", async () => {
  vi.useFakeTimers(); const page = queuePage(); page.expiresAt = new Date(Date.now() + 500).toISOString();
  render(<FireAfterDashboard bundle={queueBundle(page)} initialView="map" />);
  expect(screen.getByRole("button", { name: "Select Bridge 1" })).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(15001); });
  expect(screen.getByRole("alert").textContent).toContain("Priority evidence expired");
  expect(screen.queryByRole("button", { name: "Select Bridge 1" })).toBeNull();
  expect(screen.getByRole("link", { name: "Browse the complete Action Queue" })).toBeTruthy();
});
