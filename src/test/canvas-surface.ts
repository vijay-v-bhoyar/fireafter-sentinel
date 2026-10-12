import { vi } from "vitest";

/** jsdom has no rasterizer; browser verification is separate from these lifecycle spies. */
export function installCanvasSurface() {
  const pens = new Map<HTMLCanvasElement, ReturnType<typeof createPen>>();
  const observers = new Set<() => void>();
  let size = { width: 100, height: 100 };
  function createPen() { return { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(), isContextLost: vi.fn(() => false), strokeStyle: "", lineWidth: 1 }; }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (!pens.has(this)) pens.set(this, createPen());
    return pens.get(this)! as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ ...size, x: 0, y: 0, left: 0, top: 0, bottom: size.height, right: size.width, toJSON: () => ({}) }));
  vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) => setTimeout(() => step(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  });
  return { pens, observers, resize: (width: number, height: number) => { size = { width, height }; observers.forEach(callback => callback()); } };
}
