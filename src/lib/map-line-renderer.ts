export type MapLineCollection = { features: Array<{ geometry?: { type?: string; coordinates?: unknown } }>; warning?: string };
export type MapLineState = { status: "drawing" | "ready" | "unavailable"; parts: number; vertices: number };
export type MapBounds = [number, number, number, number];
type Pen = Pick<CanvasRenderingContext2D, "beginPath" | "moveTo" | "lineTo" | "stroke" | "clearRect">;

/** Cooperative rendering, not simplification. A caller keeps the canvas hidden until ready. */
export function drawMapLineCollection(input: {
  collection: MapLineCollection; bounds: MapBounds; width: number; height: number;
  pen: Pen; onState: (state: MapLineState) => void;
  schedule?: (step: FrameRequestCallback) => number; cancel?: (id: number) => void; now?: () => number;
}) {
  const { collection, bounds, width, height, pen, onState } = input;
  const schedule = input.schedule ?? requestAnimationFrame, cancel = input.cancel ?? cancelAnimationFrame, now = input.now ?? (() => performance.now());
  let stopped = false, frame = 0, part = 0, vertex = 0, vertices = 0, lastReport = now();
  let path: unknown[] | undefined, priorLongitude: number | undefined;
  const clear = () => pen.clearRect(0, 0, width, height);
  const fail = () => { stopped = true; clear(); onState({ status: "unavailable", parts: 0, vertices: 0 }); };
  const [west, south, east, north] = bounds;
  const valid = Array.isArray(collection?.features) && !collection.warning && bounds.every(Number.isFinite) &&
    west >= -180 && east <= 180 && south >= -90 && north <= 90 && west < east && south < north &&
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  const step = () => {
    if (stopped) return;
    const until = now() + 4; let processed = 0;
    try {
      while (part < collection.features.length) {
        if (!path) {
          const geometry = collection.features[part]?.geometry;
          if (geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) { fail(); return; }
          path = geometry.coordinates; vertex = 0; priorLongitude = undefined; pen.beginPath();
        }
        const point = path[vertex];
        if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== "number" || typeof point[1] !== "number" ||
          !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90 ||
          (priorLongitude !== undefined && Math.abs(point[0] - priorLongitude) > 180)) { fail(); return; }
        const x = (point[0] - west) / (east - west) * width, y = (1 - (point[1] - south) / (north - south)) * height;
        if (!Number.isFinite(x) || !Number.isFinite(y)) { fail(); return; }
        if (vertex === 0) pen.moveTo(x, y); else pen.lineTo(x, y);
        priorLongitude = point[0]; vertex++; vertices++; processed++;
        if (vertex === path.length) { pen.stroke(); part++; path = undefined; }
        if (processed >= 4096 || (processed % 32 === 0 && now() >= until)) break;
      }
      if (part === collection.features.length) { stopped = true; onState({ status: "ready", parts: part, vertices }); return; }
      if (now() - lastReport >= 250) { lastReport = now(); onState({ status: "drawing", parts: part, vertices }); }
      frame = schedule(step);
    } catch { fail(); }
  };
  clear(); onState({ status: "drawing", parts: 0, vertices: 0 });
  if (!valid) fail(); else frame = schedule(step);
  return () => { stopped = true; cancel(frame); clear(); };
}
