// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MapLineCanvas } from "./map-line-canvas";
import { installCanvasSurface } from "../test/canvas-surface";
import type { MapBounds, MapLineCollection } from "../lib/map-line-renderer";

let surface: ReturnType<typeof installCanvasSurface>;
beforeEach(() => { surface = installCanvasSurface(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const data = (): MapLineCollection => ({ features: [{ geometry: { type: "LineString", coordinates: [[-120, 33], [-118, 35]] } }] });
const props = () => ({ collection: data(), bounds: [-120, 33, -118, 35] as MapBounds, label: "road", color: "white", width: 0.3, onState: vi.fn() });
it("keeps partial work hidden, reports complete exact counts and draws on a real-sized surface", async () => {
  const p = props(), view = render(<MapLineCanvas {...p} />), canvas = view.container.querySelector("canvas")!;
  expect(canvas.style.visibility).toBe("hidden");
  await screen.findByRole("img", { name: "1 road parts; 2 vertices drawn" }); expect(canvas.style.visibility).toBe("visible");
  expect(surface.pens.get(canvas)!.moveTo).toHaveBeenCalledWith(0, 100); expect(surface.pens.get(canvas)!.lineTo).toHaveBeenCalledWith(100, 0);
  expect(p.onState).toHaveBeenLastCalledWith(p.collection, { status: "ready", parts: 1, vertices: 2 });
});
it("does not redraw when only a parent callback changes", async () => {
  const p = props(), view = render(<MapLineCanvas {...p} />); await screen.findByRole("img", { name: /2 vertices drawn/ });
  const canvas = view.container.querySelector("canvas")!, pen = surface.pens.get(canvas)!;
  view.rerender(<MapLineCanvas {...p} onState={vi.fn()} />); expect(pen.stroke).toHaveBeenCalledOnce();
});
it("immediately hides old geometry and cancels the old job when a new collection arrives", async () => {
  const p = props(), view = render(<MapLineCanvas {...p} />); await screen.findByRole("img", { name: /2 vertices drawn/ });
  const canvas = view.container.querySelector("canvas")!;
  view.rerender(<MapLineCanvas {...p} collection={{ features: [{ geometry: { type: "LineString", coordinates: [[-119, 34], [null, 35]] } }] }} />);
  expect(canvas.style.visibility).toBe("hidden"); await screen.findByRole("button", { name: "Retry road drawing" });
  expect(canvas.dataset.parts).toBe("0"); expect(canvas.style.visibility).toBe("hidden");
});
it("redraws on resize and removes its observer on unmount", async () => {
  const view = render(<MapLineCanvas {...props()} />); await screen.findByRole("img", { name: /2 vertices drawn/ });
  const canvas = view.container.querySelector("canvas")!, pen = surface.pens.get(canvas)!;
  act(() => surface.resize(300, 200)); expect(canvas.style.visibility).toBe("hidden");
  await screen.findByRole("img", { name: /2 vertices drawn/ }); expect(pen.lineTo).toHaveBeenLastCalledWith(300, 0);
  expect(pen.moveTo).toHaveBeenLastCalledWith(0, 200); view.unmount(); expect(surface.observers.size).toBe(0);
});
it("fails closed on context loss and redraws only after recovery", async () => {
  const view = render(<MapLineCanvas {...props()} />); await screen.findByRole("img", { name: /2 vertices drawn/ });
  const canvas = view.container.querySelector("canvas")!;
  surface.pens.get(canvas)!.isContextLost.mockReturnValue(true);
  fireEvent(canvas, new Event("contextlost", { cancelable: true })); expect(canvas.style.visibility).toBe("hidden");
  expect(screen.getByRole("button", { name: "Retry road drawing" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry road drawing" }));
  expect(canvas.style.visibility).toBe("hidden"); expect(canvas.dataset.renderStatus).toBe("unavailable");
  surface.pens.get(canvas)!.isContextLost.mockReturnValue(false);
  fireEvent(canvas, new Event("contextrestored")); await screen.findByRole("img", { name: /2 vertices drawn/ });
});
it("offers a real retry if drawing is temporarily unavailable", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValueOnce(null);
  render(<MapLineCanvas {...props()} />); fireEvent.click(await screen.findByRole("button", { name: "Retry road drawing" }));
  await screen.findByRole("img", { name: /2 vertices drawn/ });
});
it("does not allocate an oversized backing surface", async () => {
  surface.resize(10000, 10000); const view = render(<MapLineCanvas {...props()} />);
  await screen.findByRole("button", { name: "Retry road drawing" });
  expect(view.container.querySelector("canvas")!.width).toBe(300); expect(surface.pens.size).toBe(0);
});
it("waits for a hidden element to acquire dimensions", async () => {
  surface.resize(0, 0); render(<MapLineCanvas {...props()} />); expect(surface.pens.size).toBe(0);
  act(() => surface.resize(100, 100)); await waitFor(() => expect(screen.getByRole("img", { name: /2 vertices drawn/ })).toBeTruthy());
});
