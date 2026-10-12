export type Position = [number, number];
export type BasinGeometry = { type: "Polygon"; coordinates: Position[][] } |
  { type: "MultiPolygon"; coordinates: Position[][][] };
export type GeometryBudget = { vertices: number; work: number };
export const PWFDF_GEOMETRY_LIMITS = { vertices: 100_000, work: 2_000_000 } as const;
export const PWFDF_GEOMETRY_VERSION = "2026-10-02-basin-topology-v2";
export const PWFDF_ANALYSIS_GEOMETRY_VERSION = "2026-09-14-provider-resolution-v1";
export const PWFDF_ANALYSIS_GEOMETRY_FAILURE = "pwfdf_analysis_geometry_unverified";
export const PWFDF_ANALYSIS_GEOMETRY_MESSAGE = "PWFDF acquisition geometry is unverified. Refresh the real provider assessment without request-side generalization or rounding before using basin geometry or linkage; historical evidence has not been changed.";
const zero = BigInt(0), one = BigInt(1);

export class PwfdfGeometryError extends Error {
  constructor(readonly code: "pwfdf_geometry_invalid" | "pwfdf_geometry_budget" = "pwfdf_geometry_invalid") {
    super(code === "pwfdf_geometry_budget"
      ? "PWFDF geometry exceeds the validation budget. Ask an operator to review provider complexity; no partial basin collection was accepted."
      : "PWFDF requires valid polygon geometry. Ask a GIS reviewer to inspect ring topology, 2D WGS84 coordinates and antimeridian edges; no repaired or partial geometry was used.");
    this.name = "PwfdfGeometryError";
  }
}

export const geometryBudget = (): GeometryBudget => ({ vertices: 0, work: 0 });
function charge(budget: GeometryBudget, count = 1) {
  budget.work += count;
  if (budget.work > PWFDF_GEOMETRY_LIMITS.work) throw new PwfdfGeometryError("pwfdf_geometry_budget");
}
function same(a: Position, b: Position) { return a[0] === b[0] && a[1] === b[1]; }
function onSegment(a: Position, b: Position, p: Position) {
  return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

// Exact IEEE-754 values in common units of 2^-1074; never round differences first.
function exact(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> BigInt(52)) & BigInt(2047));
  const fraction = bits & ((one << BigInt(52)) - one);
  const magnitude = exponent === 0 ? fraction : ((one << BigInt(52)) | fraction) << BigInt(exponent - 1);
  return bits >> BigInt(63) ? -magnitude : magnitude;
}

function orientation(a: Position, b: Position, c: Position): number {
  const left = (a[0] - c[0]) * (b[1] - c[1]);
  const right = (a[1] - c[1]) * (b[0] - c[0]);
  const det = left - right;
  const scale = Math.abs(left) + Math.abs(right);
  if (scale >= 2 ** -900 && Math.abs(det) > scale * Number.EPSILON * 8) return Math.sign(det);
  const value = (exact(a[0]) - exact(c[0])) * (exact(b[1]) - exact(c[1])) -
    (exact(a[1]) - exact(c[1])) * (exact(b[0]) - exact(c[0]));
  return value > zero ? 1 : value < zero ? -1 : 0;
}

function intersects(a: Position, b: Position, c: Position, d: Position) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
      Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
  const x = orientation(a, b, c), y = orientation(a, b, d), z = orientation(c, d, a), w = orientation(c, d, b);
  return (x === 0 && onSegment(a, b, c)) || (y === 0 && onSegment(a, b, d)) ||
    (z === 0 && onSegment(c, d, a)) || (w === 0 && onSegment(c, d, b)) || (x * y < 0 && z * w < 0);
}

/** Boundary is distinct from inside; linkage must not assert containment on an edge. */
export function classifyRing(point: Position, ring: Position[], budget = geometryBudget()): -1 | 0 | 1 {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    charge(budget);
    const a = ring[i], b = ring[i + 1];
    const side = orientation(a, b, point);
    if (side === 0 && onSegment(a, b, point)) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && (side > 0) === (b[1] > a[1])) inside = !inside;
  }
  return inside ? 1 : -1;
}

/** Index complete edges, not simplified geometry, for repeated county queries. */
export function prepareRingClassifier(ring: Position[], budget = geometryBudget()) {
  const edges = ring.slice(0, -1).map((point, i) => {
    charge(budget);
    const a: Position = [point[0], point[1]], b: Position = [ring[i + 1][0], ring[i + 1][1]];
    return { a, b, south: Math.min(a[1], b[1]), north: Math.max(a[1], b[1]), east: Math.max(a[0], b[0]) };
  }).sort((a, b) => { charge(budget); return (a.south + a.north) - (b.south + b.north); });
  type Node = { south: number; north: number; east: number; from: number; to: number; left?: Node; right?: Node };
  const build = (from: number, to: number): Node => {
    charge(budget);
    if (to - from <= 16) {
      const node: Node = { south: Infinity, north: -Infinity, east: -Infinity, from, to };
      for (let i = from; i < to; i++) {
        charge(budget);
        node.south = Math.min(node.south, edges[i].south); node.north = Math.max(node.north, edges[i].north);
        node.east = Math.max(node.east, edges[i].east);
      }
      return node;
    }
    const middle = Math.floor((from + to) / 2), left = build(from, middle), right = build(middle, to);
    return { south: Math.min(left.south, right.south), north: Math.max(left.north, right.north),
      east: Math.max(left.east, right.east), from, to, left, right };
  };
  const root = build(0, edges.length);
  return (point: Position, queryBudget = geometryBudget()): -1 | 0 | 1 => {
    if (point.length !== 2 || !point.every(Number.isFinite)) return -1;
    let inside = false;
    const pending = [root];
    while (pending.length) {
      charge(queryBudget);
      const node = pending.pop()!;
      if (point[1] < node.south || point[1] > node.north || point[0] > node.east) continue;
      if (node.left && node.right) { pending.push(node.left, node.right); continue; }
      for (let i = node.from; i < node.to; i++) {
        charge(queryBudget);
        const { a, b, south, north, east } = edges[i];
        if (point[1] < south || point[1] > north || point[0] > east) continue;
        const side = orientation(a, b, point);
        if (side === 0 && onSegment(a, b, point)) return 0;
        if ((a[1] > point[1]) !== (b[1] > point[1]) && (side > 0) === (b[1] > a[1])) inside = !inside;
      }
    }
    return inside ? 1 : -1;
  };
}

type Bounds = { west: number; south: number; east: number; north: number };
function bounds(ring: Position[], budget: GeometryBudget): Bounds {
  const result = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  for (const [x, y] of ring) {
    charge(budget);
    result.west = Math.min(result.west, x); result.east = Math.max(result.east, x);
    result.south = Math.min(result.south, y); result.north = Math.max(result.north, y);
  }
  return result;
}

/** A private snapshot index avoids repeated vertex scans without caching mutable input. */
export function prepareBasinContainment(geometry: BasinGeometry, budget = geometryBudget()) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const prepared = polygons.map(polygon => polygon.map(ring => ({
    ring: ring.map(point => [point[0], point[1]] as Position), bounds: bounds(ring, budget),
  })));
  const classify = (point: Position, item: (typeof prepared)[number][number]) => {
    charge(budget);
    const b = item.bounds;
    return point[0] < b.west || point[0] > b.east || point[1] < b.south || point[1] > b.north
      ? -1 : classifyRing(point, item.ring, budget);
  };
  return (point: Position): boolean => {
    if (point.length !== 2 || !point.every(Number.isFinite)) return false;
    return prepared.some(polygon => polygon.length && classify(point, polygon[0]) === 1 &&
      polygon.slice(1).every(hole => classify(point, hole) === -1));
  };
}

export function containsBasinPoint(point: Position, geometry: BasinGeometry, budget = geometryBudget()): boolean {
  return prepareBasinContainment(geometry, budget)(point);
}

function ringsFrom(value: unknown, budget: GeometryBudget): Position[][] {
  if (!Array.isArray(value) || !value.length || value.length > PWFDF_GEOMETRY_LIMITS.vertices / 4) throw new PwfdfGeometryError();
  return value.map(raw => {
    if (!Array.isArray(raw) || raw.length < 4) throw new PwfdfGeometryError();
    budget.vertices += raw.length;
    if (budget.vertices > PWFDF_GEOMETRY_LIMITS.vertices) throw new PwfdfGeometryError("pwfdf_geometry_budget");
    const ring = raw.map((p): Position => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(n => typeof n === "number" && Number.isFinite(n)) ||
          Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) throw new PwfdfGeometryError();
      return [p[0], p[1]];
    });
    if (!same(ring[0], ring[ring.length - 1])) throw new PwfdfGeometryError();
    for (let i = 0; i < ring.length - 1; i++) {
      if (same(ring[i], ring[i + 1]) || Math.abs(ring[i][0] - ring[i + 1][0]) > 180) throw new PwfdfGeometryError();
    }
    return ring;
  });
}

function signedArea(ring: Position[], budget: GeometryBudget): bigint {
  let area = zero;
  const x = exact(ring[0][0]), y = exact(ring[0][1]);
  for (let i = 0; i < ring.length - 1; i++) {
    charge(budget);
    area += (exact(ring[i][0]) - x) * (exact(ring[i + 1][1]) - y) -
      (exact(ring[i + 1][0]) - x) * (exact(ring[i][1]) - y);
  }
  if (area === zero) throw new PwfdfGeometryError();
  return area;
}

// ArcGIS permits self-touch at vertices. Split only at identical provider
// vertices: every original edge is retained exactly, never snapped or simplified.
function splitVertexTouches(ring: Position[], budget: GeometryBudget): Position[][] {
  const path: Position[] = [];
  const seen = new Map<string, number>();
  const result: Position[][] = [];
  for (const point of ring) {
    charge(budget);
    const key = `${point[0]},${point[1]}`;
    const start = seen.get(key);
    if (start === undefined) { seen.set(key, path.length); path.push(point); continue; }
    const cycle = [...path.slice(start), point];
    if (cycle.length < 4) throw new PwfdfGeometryError();
    result.push(cycle);
    for (let i = start + 1; i < path.length; i++) seen.delete(`${path[i][0]},${path[i][1]}`);
    path.length = start + 1;
  }
  if (path.length !== 1) throw new PwfdfGeometryError();
  budget.vertices += result.length - 1;
  if (budget.vertices > PWFDF_GEOMETRY_LIMITS.vertices) throw new PwfdfGeometryError("pwfdf_geometry_budget");
  return result;
}

function onlyEndpointContact(a: Position, b: Position, c: Position, d: Position): boolean {
  const shared = same(a, c) || same(a, d) ? a : same(b, c) || same(b, d) ? b : undefined;
  if (!shared) return false;
  const first = same(a, shared) ? b : a, last = same(c, shared) ? d : c;
  return orientation(first, shared, last) !== 0 ||
    (!onSegment(first, shared, last) && !onSegment(shared, last, first));
}

function validateVertexContacts(rings: Position[][], budget: GeometryBudget) {
  const visits = new Map<string, { ring: number; point: Position; before: Position; after: Position }[]>();
  rings.forEach((ring, index) => {
    for (let i = 0; i < ring.length - 1; i++) {
      charge(budget);
      const point = ring[i], key = `${point[0]},${point[1]}`;
      const peers = visits.get(key) ?? [];
      if (peers.some(peer => peer.ring === index)) throw new PwfdfGeometryError();
      peers.push({ ring: index, point, before: ring[(i + ring.length - 2) % (ring.length - 1)], after: ring[i + 1] });
      visits.set(key, peers);
    }
  });
  for (const peers of visits.values()) for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) {
    charge(budget);
    const origin = peers[i].point;
    const half = (point: Position) => Number(point[1] < origin[1] || point[1] === origin[1] && point[0] < origin[0]);
    const rays = [peers[i].before, peers[i].after, peers[j].before, peers[j].after]
      .map((point, index) => ({ point, owner: Math.floor(index / 2) }))
      .sort((a, b) => half(a.point) - half(b.point) || -orientation(origin, a.point, b.point));
    // Alternating rays cross at the vertex; grouped rays only touch.
    if (rays.every((ray, index) => ray.owner !== rays[(index + 1) % 4].owner)) throw new PwfdfGeometryError();
  }
}

function ringInside(inner: Position[], outer: Position[], budget: GeometryBudget) {
  for (const point of inner.slice(0, -1)) {
    const side = classifyRing(point, outer, budget);
    if (side !== 0) return side === 1;
  }
  // All inner vertices can touch the shell. Classify an exact dyadic midpoint
  // without rounding subnormal coordinates onto the boundary.
  const px = exact(inner[0][0]) + exact(inner[1][0]);
  const py = exact(inner[0][1]) + exact(inner[1][1]);
  let inside = false;
  for (let i = 0; i < outer.length - 1; i++) {
    charge(budget);
    const ax = exact(outer[i][0]) * BigInt(2), ay = exact(outer[i][1]) * BigInt(2);
    const bx = exact(outer[i + 1][0]) * BigInt(2), by = exact(outer[i + 1][1]) * BigInt(2);
    const det = (ax - px) * (by - py) - (ay - py) * (bx - px);
    if ((ay > py) !== (by > py) && (det > zero) === (by > ay)) inside = !inside;
  }
  return inside;
}

function topology(rings: Position[][], budget: GeometryBudget) {
  const areas = rings.map(ring => signedArea(ring, budget));
  const boxes = rings.map(ring => bounds(ring, budget));
  const edges = rings.flatMap((ring, r) => ring.slice(0, -1).map((a, i) => {
    const b = ring[i + 1];
    return { a, b, r, i, west: Math.min(a[0], b[0]), east: Math.max(a[0], b[0]),
      south: Math.min(a[1], b[1]), north: Math.max(a[1], b[1]) };
  })).sort((a, b) => a.west - b.west || a.east - b.east || a.r - b.r || a.i - b.i);
  let active: typeof edges = [];
  for (const edge of edges) {
    const retained: typeof edges = [];
    for (const prior of active) {
      charge(budget);
      if (prior.east < edge.west) continue;
      retained.push(prior);
      if (prior.north < edge.south || edge.north < prior.south || !intersects(edge.a, edge.b, prior.a, prior.b)) continue;
      const adjacent = edge.r === prior.r && (Math.abs(edge.i - prior.i) === 1 ||
        Math.abs(edge.i - prior.i) === rings[edge.r].length - 2);
      if ((!adjacent && edge.r === prior.r) || !onlyEndpointContact(edge.a, edge.b, prior.a, prior.b)) throw new PwfdfGeometryError();
    }
    retained.push(edge);
    active = retained;
  }
  validateVertexContacts(rings, budget);
  const magnitude = areas.map(area => area < zero ? -area : area);
  const parents = rings.map((ring, index) => {
    let parent = -1;
    for (let other = 0; other < rings.length; other++) {
      charge(budget);
      const inner = boxes[index], outer = boxes[other];
      if (index !== other && magnitude[other] > magnitude[index] &&
          inner.west >= outer.west && inner.east <= outer.east && inner.south >= outer.south && inner.north <= outer.north &&
          ringInside(ring, rings[other], budget) &&
          (parent === -1 || magnitude[other] < magnitude[parent])) parent = other;
    }
    return parent;
  });
  const depths = parents.map(parent => {
    let depth = 0;
    for (let p = parent; p !== -1; p = parents[p]) { charge(budget); depth++; }
    return depth;
  });
  return { parents, depths, areas };
}

export function parseArcgisBasinGeometry(value: unknown, budget = geometryBudget()): BasinGeometry {
  const rings = ringsFrom(value, budget).flatMap(ring => splitVertexTouches(ring, budget));
  const { parents, depths, areas } = topology(rings, budget);
  const polygons: Position[][][] = [];
  for (let index = 0; index < rings.length; index++) {
    if (depths[index] % 2) continue;
    const shell = areas[index] > zero ? rings[index] : [...rings[index]].reverse();
    const holes = rings.flatMap((ring, child) => {
      charge(budget);
      return parents[child] === index ? [areas[child] < zero ? ring : [...ring].reverse()] : [];
    });
    polygons.push([shell, ...holes]);
  }
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons };
}

export function validateBasinGeometry(value: unknown, budget = geometryBudget()): BasinGeometry {
  if (!value || typeof value !== "object" || !("type" in value) || !("coordinates" in value) || "crs" in value) throw new PwfdfGeometryError();
  const raw = value.type === "Polygon" ? [value.coordinates] : value.type === "MultiPolygon" ? value.coordinates : null;
  if (!Array.isArray(raw) || !raw.length || raw.length > PWFDF_GEOMETRY_LIMITS.vertices / 4) throw new PwfdfGeometryError();
  const polygons = raw.map(rings => ringsFrom(rings, budget));
  const rings = polygons.flat();
  const { parents, depths } = topology(rings, budget);
  let index = 0;
  for (const polygon of polygons) {
    const shell = index++;
    if (depths[shell] % 2 !== 0) throw new PwfdfGeometryError();
    for (let hole = 1; hole < polygon.length; hole++, index++) if (parents[index] !== shell) throw new PwfdfGeometryError();
  }
  return value.type === "Polygon" ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons };
}
