// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InventoryViewportMap } from "./inventory-viewport-map";
import { MAP_VIEW_VERSION } from "@/lib/map-viewport-contract";
import { SOURCE_VIEW_VERSION } from "@/lib/source-viewport-contract";
import type { Incident } from "@/lib/types";
const incident = { id: "county", county: "Monterey", locationContext: { bbox: [-122, 35, -120, 37] } } as Incident;
const authority = { actorId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222" };
const revision = "33333333-3333-4333-8333-333333333333";
function sourceResponse(url: string) {
  const p = new URL(url, "http://localhost").searchParams;
  return Response.json({ version: SOURCE_VIEW_VERSION, incidentId: p.get("incidentId"), revision: p.get("revision"), layer: p.get("layer"),
    bbox: p.get("bbox")!.split(",").map(Number), zoom: Number(p.get("zoom")), mode: "unavailable", totalRecords: null,
    candidateRecords: 0, candidateChunks: 0, source: null, features: [] });
}
function response(url: string, count = 91511) {
  const params = new URL(url, "http://localhost").searchParams;
  const bbox = params.get("bbox")!.split(",").map(Number), zoom = Number(params.get("zoom"));
  const coordinates = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  return { version: MAP_VIEW_VERSION, incidentId: params.get("incidentId"), revision: params.get("revision"), bbox, zoom,
    totalStored: 91511, totalLocated: 91511, withheld: 0, inView: count, mode: count > 200 ? "clusters" : "points",
    items: count > 200 ? [{ kind: "cluster", id: "c2-2", count, coordinates }]
      : count ? [{ kind: "point", id: "44444444-4444-4444-8444-444444444444", name: "Bridge A", type: "Bridge", coordinates }] : [] };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("zooms clusters through bounded view requests, pans, fits county, and never calls the full map route", async () => {
  const fetchImpl = vi.fn((url: string) => Promise.resolve(url.includes("source-viewport") ? sourceResponse(url) : Response.json(response(url, url.includes("zoom=0") ? 91511 : 1))));
  const assetCalls = () => fetchImpl.mock.calls.filter(([url]) => url.startsWith("/api/map/viewport?"));
  vi.stubGlobal("fetch", fetchImpl); render(<InventoryViewportMap incident={incident} revision={revision} authority={authority} />);
  fireEvent.click(await screen.findByRole("button", { name: "Zoom into 91511 saved locations" }));
  expect(screen.queryByRole("button", { name: /Zoom into/ })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Bridge A" }));
  expect(new URL(assetCalls().at(-1)![0], "http://localhost").searchParams.get("zoom")).toBe("2");
  expect(screen.getByText(/Bridge A \| Bridge \| Saved location only/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pan east" }));
  await screen.findByRole("button", { name: "Inspect Bridge A" });
  const moved = new URL(assetCalls().at(-1)![0], "http://localhost").searchParams;
  expect(moved.get("bbox")).not.toBe("-121.5,35.5,-120.5,36.5");
  fireEvent.click(screen.getByRole("button", { name: "Fit county" }));
  await screen.findByRole("button", { name: "Zoom into 91511 saved locations" });
  expect(fetchImpl.mock.calls.every(([url]) => /^\/api\/map\/(source-)?viewport\?/.test(url))).toBe(true);
  expect(new Set(fetchImpl.mock.calls.filter(([url]) => url.includes("source-viewport")).map(([url]) => new URL(url, "http://localhost").searchParams.get("layer"))).size).toBe(3);
  expect(screen.getByText(/not live hazard scores/)).toBeTruthy(); expect(screen.getByText(/Source geometry loads by view/)).toBeTruthy();
});
it("aborts obsolete reads and ignores late replies after identity or revision replacement", async () => {
  const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal; url: string }> = [];
  vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => url.includes("source-viewport") ? Promise.resolve(sourceResponse(url))
    : new Promise<Response>(resolve => pending.push({ url, signal: options.signal!, resolve }))));
  const view = render(<InventoryViewportMap incident={incident} revision={revision} authority={authority} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  view.rerender(<InventoryViewportMap incident={incident} revision="55555555-5555-4555-8555-555555555555" authority={authority} />);
  await waitFor(() => expect(pending[0].signal.aborted).toBe(true));
  await waitFor(() => expect(pending).toHaveLength(2)); pending[0].resolve(Response.json(response(pending[0].url)));
  pending[1].resolve(Response.json(response(pending[1].url, 1)));
  await screen.findByRole("button", { name: "Inspect Bridge A" }); expect(screen.queryByRole("button", { name: /Zoom into/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await waitFor(() => expect(pending).toHaveLength(3));
  view.unmount(); await waitFor(() => expect(pending[2].signal.aborted).toBe(true));
});
it("shows a retryable safe failure and recovers without retaining stale points", async () => {
  let failed = false;
  const fetchImpl = vi.fn((url: string) => {
    if (url.includes("source-viewport")) return Promise.resolve(sourceResponse(url));
    if (!failed) { failed = true; return Promise.resolve(Response.json({ error: "PRIVATE_DATABASE" }, { status: 503 })); }
    return Promise.resolve(Response.json(response(url, 1)));
  });
  vi.stubGlobal("fetch", fetchImpl); render(<InventoryViewportMap incident={incident} revision={revision} authority={authority} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry view" }));
  await screen.findByRole("button", { name: "Inspect Bridge A" }); expect(screen.queryByText(/PRIVATE_DATABASE/)).toBeNull();
});
it("keeps invalid county bounds out of requests", () => {
  const fetchImpl = vi.fn(); vi.stubGlobal("fetch", fetchImpl);
  render(<InventoryViewportMap incident={{ ...incident, locationContext: undefined }} revision={revision} authority={authority} />);
  expect(screen.getByRole("alert").textContent).toContain("extent unavailable"); expect(fetchImpl).not.toHaveBeenCalled();
});
