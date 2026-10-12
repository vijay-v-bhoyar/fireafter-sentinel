import type { MapBounds } from "./map-viewport-contract";

export function viewportBounds(extent: MapBounds, zoom: number, center?: [number, number]): MapBounds {
  const [w, s, e, n] = extent;
  const width = Math.max(0.000002, (e - w) / 2 ** zoom), height = Math.max(0.000002, (n - s) / 2 ** zoom);
  const x = Math.max(w + width / 2, Math.min(e - width / 2, center?.[0] ?? (w + e) / 2));
  const y = Math.max(s + height / 2, Math.min(n - height / 2, center?.[1] ?? (s + n) / 2));
  return [x - width / 2, y - height / 2, x + width / 2, y + height / 2];
}
export function viewportPosition(point: [number, number], [w, s, e, n]: MapBounds) {
  return { left: `${(point[0] - w) / (e - w) * 100}%`, top: `${(n - point[1]) / (n - s) * 100}%` };
}
