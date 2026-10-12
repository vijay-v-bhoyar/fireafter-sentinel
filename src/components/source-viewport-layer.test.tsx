// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SourceViewportLayer, sourceViewportLines } from "./source-viewport-layer";
import { SOURCE_VIEW_VERSION, type SourceViewportQuery, type SourceViewportResponse } from "@/lib/source-viewport-contract";
import { installCanvasSurface } from "../test/canvas-surface";
let host: HTMLDivElement;
beforeEach(() => { installCanvasSurface(); host = document.createElement("div"); document.body.append(host); });
afterEach(() => { cleanup(); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const query: SourceViewportQuery = { incidentId: "county", revision: "33333333-3333-4333-8333-333333333333", bbox: "-122,35,-120,37", zoom: "0", layer: "tiger-roads" };
const authority = { actorId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222" };
function body(q = query): SourceViewportResponse {
  return { version: SOURCE_VIEW_VERSION, incidentId: q.incidentId, revision: q.revision, layer: q.layer, bbox: [-122, 35, -120, 37], zoom: Number(q.zoom), mode: "ready",
    totalRecords: 100, candidateRecords: 2, candidateChunks: 1, source: { rowId: "44444444-4444-4444-8444-444444444444", name: "Census TIGERweb", url: "https://tigerweb.geo.census.gov/",
      fetchedAt: "2026-01-01", sourceUpdatedAt: "2025-01-01", timeBasis: "provider", current: false, freshness: "Check expired", detail: "Complete saved records", warnings: ["Not field verified"] },
    features: [{ id: "44444444-4444-4444-8444-444444444444:4", position: 4, sourceFeatureId: "id-4", name: "Road 4", category: null,
      sourceUrl: "https://tigerweb.geo.census.gov/", geometry: { type: "MultiLineString", coordinates: [[[-121.5, 35.5], [-121, 36]], [[-120.5, 36.5], [-120.4, 36.6]]] } }] };
}
const props = () => ({ query, authority, host, bounds: [-122, 35, -120, 37] as [number, number, number, number] });
it("draws all disconnected paths in a portal and keeps source limitations visible", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body())));
  render(<SourceViewportLayer {...props()} />);
  await screen.findByRole("img", { name: "2 road parts; 4 vertices drawn" });
  expect(host.querySelector("canvas")!.style.visibility).toBe("visible");
  expect(screen.getByText(/1 records overlap this view of 100 saved/)).toBeTruthy();
  fireEvent.click(screen.getByText("Source details"));
  expect(screen.getByText(/not a current hazard ranking/)).toBeTruthy();
  expect(screen.getByText("Not field verified")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Roads" }));
  expect(host.querySelector("canvas")).toBeNull(); expect(screen.getByText("Layer off.")).toBeTruthy();
});
it("hides geometry immediately on view change, aborts old requests and ignores late responses", async () => {
  const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>(resolve => pending.push({ resolve, signal: options.signal! }))));
  const view = render(<SourceViewportLayer {...props()} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  view.rerender(<SourceViewportLayer {...props()} query={{ ...query, zoom: "1" }} />);
  expect(host.querySelector("canvas")).toBeNull(); await waitFor(() => expect(pending[0].signal.aborted).toBe(true));
  await waitFor(() => expect(pending).toHaveLength(2));
  pending[0].resolve(Response.json(body())); pending[1].resolve(Response.json(body({ ...query, zoom: "1" })));
  await screen.findByRole("img", { name: /4 vertices drawn/ });
  view.rerender(<SourceViewportLayer {...props()} query={{ ...query, zoom: "2" }} />);
  expect(host.querySelector("canvas")).toBeNull();
  await waitFor(() => expect(pending).toHaveLength(3)); view.unmount(); await waitFor(() => expect(pending[2].signal.aborted).toBe(true));
});
it.each(["zoom_required", "unavailable"] as const)("does not draw a %s layer", async mode => {
  const data = { ...body(), mode, features: [], ...(mode === "unavailable" ? { totalRecords: null, candidateRecords: 0, candidateChunks: 0 } : {}) };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
  render(<SourceViewportLayer {...props()} />);
  await screen.findByText(mode === "zoom_required" ? /Zoom in to load this view without truncation/ : /No verified indexed geometry/);
  expect(host.querySelector("canvas")).toBeNull();
});
it("offers a retry without exposing error bodies or retaining stale geometry", async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ error: "PRIVATE_DATABASE" }, { status: 503 })).mockImplementation(() => Promise.resolve(Response.json(body())));
  vi.stubGlobal("fetch", fetchImpl); render(<SourceViewportLayer {...props()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry roads" }));
  await screen.findByRole("img", { name: /4 vertices drawn/ }); expect(screen.queryByText(/PRIVATE_DATABASE/)).toBeNull();
});
it("keeps basin holes and disconnected polygon boundaries in the drawing input", () => {
  const data = body();
  const ring = [[-122, 35], [-121, 35], [-121, 36], [-122, 35]] as [number, number][];
  data.features[0].geometry = { type: "MultiPolygon", coordinates: [[ring, ring], [ring]] };
  const collection = sourceViewportLines(data);
  expect(collection.features).toHaveLength(3);
  expect(collection.features.every(feature => feature.geometry?.coordinates === ring)).toBe(true);
});
