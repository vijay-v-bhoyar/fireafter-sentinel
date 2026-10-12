import { coordinateInBbox } from "./geo";
import { prepareRingClassifier, geometryBudget, parseArcgisBasinGeometry, validateBasinGeometry, type BasinGeometry, type Position } from "./pwfdf-geometry";
import type { Incident } from "./types";

export class CountyScopeError extends Error {
  constructor() {
    super("County boundary could not be verified within the processing limit. Select the county again or ask a GIS reviewer to inspect its geometry; no bounding-box replacement was used.");
    this.name = "CountyScopeError";
  }
}

export function normalizeCountyBoundary(value: unknown): BasinGeometry {
  try {
    // Older TIGER records stored Esri rings as a Polygon, including disconnected
    // islands. Reconstruct shell/hole topology losslessly, not by ring order.
    if (value && typeof value === "object" && !("crs" in value) && "type" in value && value.type === "Polygon" && "coordinates" in value) {
      return parseArcgisBasinGeometry(value.coordinates);
    }
    return validateBasinGeometry(value);
  } catch {
    throw new CountyScopeError();
  }
}

export function countyQueryGeometry(value: unknown, bbox: [number, number, number, number]) {
  try {
    const boundary = normalizeCountyBoundary(value);
    const inputRings = boundary.type === "Polygon" ? boundary.coordinates : boundary.coordinates.flat();
    // The topology parser gives CCW shells/CW holes. Esri query polygons need
    // the opposite winding; reversing preserves every coordinate and island.
    const normalized = parseArcgisBasinGeometry(inputRings);
    const polygons = normalized.type === "Polygon" ? [normalized.coordinates] : normalized.coordinates;
    const rings = polygons.flatMap(polygon => polygon.map(ring => [...ring].reverse()));
    if (rings.some(ring => ring.some(point => !coordinateInBbox(point, bbox, 0)))) throw new CountyScopeError();
    return { rings, spatialReference: { wkid: 4326 } };
  } catch { throw new CountyScopeError(); }
}

export function prepareCountyScope(incident: Pick<Incident, "locationContext">) {
  const location = incident.locationContext;
  const bbox = location?.bbox ? [...location.bbox] as [number, number, number, number] : undefined;
  if (!location?.boundary) {
    if (location?.sourceKey === "tigerweb-counties") throw new CountyScopeError();
    // Non-provider fixtures/legacy study areas have only an explicitly stored extent.
    return { boundary: undefined, contains: (point: Position) => Boolean(bbox && coordinateInBbox(point, bbox)) };
  }
  const boundary = normalizeCountyBoundary(location.boundary);
  const polygons = boundary.type === "Polygon" ? [boundary.coordinates] : boundary.coordinates;
  const preparationBudget = geometryBudget();
  const classifiers = polygons.map(polygon => polygon.map(ring => prepareRingClassifier(ring, preparationBudget)));
  const cache = new Map<string, boolean>();
  const cacheKeys = new Array<string>(20_000);
  let nextCacheSlot = 0;
  let queries = 0;
  const deadline = performance.now() + 5_000;
  const contains = (point: Position) => {
    if (point.length !== 2 || !point.every(Number.isFinite) || !bbox || !coordinateInBbox(point, bbox, 0)) return false;
    const key = `${point[0]},${point[1]}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (++queries > 100_000 || performance.now() > deadline) throw new CountyScopeError();
    // Bound each query separately. Sharing a basin-linkage work budget across
    // thousands of county assets rejects otherwise valid complete inventories.
    const budget = geometryBudget();
    const result = classifiers.some((polygon) => {
      const shell = polygon[0](point, budget);
      return shell === 0 || (shell === 1 && polygon.slice(1).every(hole => hole(point, budget) !== 1));
    });
    // Cache capacity is a memory bound, not an inventory truncation rule.
    // Evicted points are recomputed under the same deadline and query budget.
    // A fresh Map iterator scans deleted slots after sustained eviction. Keep
    // insertion order in a bounded ring so FIFO eviction remains constant-time.
    if (cache.size >= cacheKeys.length) cache.delete(cacheKeys[nextCacheSlot]);
    cacheKeys[nextCacheSlot] = key;
    nextCacheSlot = (nextCacheSlot + 1) % cacheKeys.length;
    cache.set(key, result);
    return result;
  };
  return { boundary: structuredClone(boundary), contains };
}
