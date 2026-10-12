// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OperationalMap } from "./fireafter-dashboard";
import type { Incident, SourceSnapshot } from "@/lib/types";
import { installCanvasSurface } from "../test/canvas-surface";
import { mapStreamResponse } from "@/lib/map-stream-response";
import { MAP_CAPACITY_CODE } from "@/lib/map-stream-contract";

let surface: ReturnType<typeof installCanvasSurface>;
beforeEach(() => { surface = installCanvasSurface(); });

const incident: Incident = {
  id: "incident-test", locationId: "county-test", county: "Test County", state: "CA", title: "Test", code: "TEST",
  status: "Monitoring", stormWindow: "48 hours", rainfallForecast: "Unavailable", lastRefresh: "Checked",
  dataFreshness: "Low", activeAlerts: 0, selectedFire: { name: "No selected fire", acres: 0, perimeterUpdated: "Unknown", source: "Unavailable" },
  locationContext: { id: "county-test", county: "Test County", state: "CA", label: "Test County, CA", centroid: [-119, 34],
    bbox: [-120, 33, -118, 35], fips: "06001", fireWeatherZone: "CAZ001", population: 0, wildfireContext: "Test only" },
};
const source: SourceSnapshot = { id: "source-test", incidentId: incident.id, sourceName: "TIGERweb", sourceKey: "tiger-roads",
  fetchedAt: "2026-09-12T00:00:00Z", sourceUpdatedAt: "2026-09-12T00:00:00Z", status: "online", stale: false, freshnessLabel: "Checked", detail: "Loaded" };

function response(lines: unknown[][][] = [[[-120, 33], [-118, 35]]]) {
  const empty = () => ({ type: "FeatureCollection", features: [] });
  return { incidentId: incident.id, county: empty(), hydrography: empty(), pwfdfBasins: empty(), assets: empty(), recommendations: empty(),
    roads: { type: "FeatureCollection", features: lines.map((coordinates) => ({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: {} })) } };
}
function props(sources = [source]) { return { incident, sources, recommendations: [], onSelect: vi.fn() }; }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("operational map geometry", () => {
  it("explains the complete-map capacity failure, offers the queue, and clears it after recovery", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503, headers: { "X-FireAfter-Map-Error": MAP_CAPACITY_CODE } }))
      .mockImplementation(() => Promise.resolve(Response.json(response())));
    vi.stubGlobal("fetch", fetchImpl); vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<OperationalMap {...props()} />);
    expect((await screen.findByRole("link", { name: "Open Action Queue" })).getAttribute("href")).toContain(incident.id);
    expect(screen.getByText(/Retrying unchanged data will not resolve/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry map" }));
    await screen.findByRole("img", { name: "1 road parts; 2 vertices drawn" });
    expect(screen.queryByRole("link", { name: "Open Action Queue" })).toBeNull();
  });
  it("draws the real streamed response only after completion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mapStreamResponse(response())));
    render(<OperationalMap {...props()} />);
    await screen.findByRole("img", { name: "1 road parts; 2 vertices drawn" });
    expect(screen.queryByRole("button", { name: "Retry map" })).toBeNull();
  });
  it("aborts the outstanding network read on unmount", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options) => { requestSignal = options.signal; return new Promise(() => {}); }));
    const view = render(<OperationalMap {...props()} />); expect(requestSignal?.aborted).toBe(false);
    view.unmount(); expect(requestSignal?.aborted).toBe(true);
  });
  it("renders multipart county shells and holes without filling the holes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response())));
    const county = { ...incident, locationContext: { ...incident.locationContext!, boundary: {
      type: "MultiPolygon" as const, coordinates: [[
        [[-120, 33], [-119, 33], [-119, 35], [-120, 35], [-120, 33]],
        [[-119.8, 33.2], [-119.2, 33.2], [-119.2, 33.8], [-119.8, 33.8], [-119.8, 33.2]],
      ], [[[-118.8, 34], [-118.2, 34], [-118.2, 34.8], [-118.8, 34.8], [-118.8, 34]]]] as [number, number][][][],
    } } };
    const view = render(<OperationalMap {...props()} incident={county} />);
    const path = view.container.querySelector('path[fill-rule="evenodd"]')!;
    expect(path.getAttribute("d")?.match(/M/g)).toHaveLength(3);
    expect(path.getAttribute("d")?.match(/Z/g)).toHaveLength(3);
    await waitFor(() => expect(screen.queryByText("Loading current source geometry.")).toBeNull());
  });

  it("keeps all dark map summaries in the light-text chrome palette", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response())));
    render(<OperationalMap {...props()} />);
    await waitFor(() => expect(screen.getByText("1 / 6")).toBeTruthy());
    for (const label of ["Weather Outlook", "Layers Loaded", "Key Alerts"]) {
      const card = screen.getByText(label).closest(".ops-chrome");
      expect(card, label).not.toBeNull();
      expect(card!.classList.contains("text-slate-100")).toBe(true);
      expect(card!.classList.contains("bg-[var(--ops-inset)]")).toBe(true);
      expect(card!.querySelector("p")?.classList.contains("text-slate-300")).toBe(true);
    }
  });
  it("renders every multipart basin ring including holes with one even-odd path per basin", async () => {
    const data = response();
    const ring = [[-120, 33], [-118, 33], [-118, 35], [-120, 35], [-120, 33]];
    const hole = [[-119.8, 33.2], [-119.2, 33.2], [-119.2, 33.8], [-119.8, 33.8], [-119.8, 33.2]];
    const island = [[-119.7, 33.3], [-119.3, 33.3], [-119.3, 33.7], [-119.7, 33.7], [-119.7, 33.3]];
    Object.assign(data.pwfdfBasins, { features: [{ properties: { id: "basin-1", combinedHazard: "High" },
      geometry: { type: "MultiPolygon", coordinates: [[ring, hole], [island]] } }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    const view = render(<OperationalMap {...props()} />);
    await waitFor(() => expect(view.container.querySelectorAll('path[fill-rule="evenodd"]')).toHaveLength(1));
    const path = view.container.querySelector('path[fill-rule="evenodd"]')!;
    expect(path.getAttribute("d")?.match(/M/g)).toHaveLength(3);
    expect(path.getAttribute("d")?.match(/Z/g)).toHaveLength(3);
    expect(path.getAttribute("d")).toContain("0,100 L100,100 L100,0 L0,0");
    expect(screen.getByRole("img", { name: /1 USGS debris-flow basin source features/ })).toBeTruthy();
    expect(screen.getByText("USGS Debris-Flow Basins").parentElement?.textContent).toMatch(/Basinsloaded$/);
    expect(await screen.findByText("2 / 6")).toBeTruthy();
  });

  it.each(["bad_vertex", "unknown_hazard", "server_warning", "late_bad_basin", "duplicate", "over_budget"])("withholds the whole basin layer and announces %s", async mode => {
    const data = response();
    const valid = { properties: { id: "basin-1", combinedHazard: "High" }, geometry: { type: "Polygon", coordinates:
      [[[-120, 33], [-118, 33], [-118, 35], [-120, 35], [-120, 33]]] } };
    const bad = structuredClone(valid);
    if (mode === "unknown_hazard") bad.properties.combinedHazard = "unexpected";
    else bad.geometry.coordinates[0][2] = [Number.NaN, 34];
    Object.assign(data.pwfdfBasins, { features: mode === "server_warning" ? [] : mode === "late_bad_basin" ? [valid, { ...bad, properties: { ...bad.properties, id: "bad" } }] : [bad],
      warning: mode === "server_warning" ? "Provider validation failed" : undefined });
    if (mode === "duplicate") Object.assign(data.pwfdfBasins, { features: [valid, structuredClone(valid)] });
    if (mode === "over_budget") Object.assign(data.pwfdfBasins, { features: Array.from({ length: 501 }, (_, id) =>
      ({ ...valid, properties: { ...valid.properties, id: `basin-${id}` } })) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    const view = render(<OperationalMap {...props()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/PWFDF layer unavailable/));
    expect(view.container.querySelectorAll('path[fill-rule="evenodd"]')).toHaveLength(0);
    expect(screen.getByText("USGS Debris-Flow Basins").parentElement?.textContent).toMatch(/not available$/);
    expect(await screen.findByText("1 / 6")).toBeTruthy();
  });

  it("renders complete lines at their real projected coordinates without marker clamping or a rendering cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response(Array.from({ length: 160 }, () => [[-120, 33], [-118, 35]])))));
    const view = render(<OperationalMap {...props()} />);
    const canvas = await screen.findByRole("img", { name: "160 road parts; 320 vertices drawn" }) as HTMLCanvasElement;
    const pen = surface.pens.get(canvas)!;
    expect(pen.stroke).toHaveBeenCalledTimes(160); expect(pen.moveTo).toHaveBeenCalledWith(0, 100); expect(pen.lineTo).toHaveBeenCalledWith(100, 0);
    expect(view.container.querySelectorAll("polyline")).toHaveLength(0);
  });

  it("does not bridge invalid interior vertices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response([[[-120, 33], [null, 34], [-118, 35]]]))));
    const view = render(<OperationalMap {...props()} />);
    await waitFor(() => expect(screen.queryByText("Loading current source geometry.")).toBeNull());
    await screen.findByRole("button", { name: "Retry road drawing" });
    expect(view.container.querySelectorAll("polyline")).toHaveLength(0);
    expect(screen.getByText("Road Network").parentElement?.textContent).toMatch(/not available$/);
    expect(screen.getByText("0 / 6")).toBeTruthy();
  });

  it("distinguishes valid empty geometry from unavailable or loading evidence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response([]))));
    const view = render(<OperationalMap {...props()} />);
    await waitFor(() => expect(screen.queryByText("Loading current source geometry.")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("USGS Debris-Flow Basins").parentElement?.textContent).toMatch(/not available$/);
    expect(screen.getByText("0 / 6")).toBeTruthy();
    expect(view.container.querySelectorAll('path[fill-rule="evenodd"]')).toHaveLength(0);
  });

  it("hides prior geometry while reloading a new source revision for the same incident", async () => {
    let finish!: (value: Response) => void;
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(response())).mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<OperationalMap {...props()} />);
    await screen.findByRole("img", { name: "1 road parts; 2 vertices drawn" });
    view.rerender(<OperationalMap {...props([{ ...source, freshnessLabel: "One minute ago" }])} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.rerender(<OperationalMap {...props([{ ...source, fetchedAt: "2026-09-12T01:00:00Z" }])} />);
    expect(view.container.querySelectorAll("polyline")).toHaveLength(0);
    expect(screen.getByText("Road Network").parentElement?.textContent).toMatch(/loading$/);
    expect(screen.getByText("0 / 6")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { finish(Response.json(response([[[-119, 33], [-119, 35]]]))); });
    const canvas = await screen.findByRole("img", { name: "1 road parts; 2 vertices drawn" }) as HTMLCanvasElement;
    expect(surface.pens.get(canvas)!.moveTo).toHaveBeenLastCalledWith(50, 100);
    expect(surface.pens.get(canvas)!.lineTo).toHaveBeenLastCalledWith(50, 0);
  });

  it("shows a genuine retry after failed geometry loading instead of stale vectors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(Response.json(response()));
    vi.stubGlobal("fetch", fetchMock);
    render(<OperationalMap {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry map" }));
    await screen.findByRole("img", { name: "1 road parts; 2 vertices drawn" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry map" })).toBeNull();
  });
});
