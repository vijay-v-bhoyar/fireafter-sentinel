import { createResponseBudget, OutboundResponseError } from "./bounded-response";
import { fetchOperationResponse } from "./refresh-operation";
import { InventoryCapacityError } from "./inventory-error";

export const ELEVATION_BATCH_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples";
type Point = readonly [number, number];
const key = ([x, y]: Point) => `${x},${y}`;

class ElevationHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null) {
    super("Elevation provider request failed.");
  }
}

function retryDelay(error: unknown): number | undefined {
  if (error instanceof OutboundResponseError && ["timeout", "network"].includes(error.code)) return 500;
  if (!(error instanceof ElevationHttpError) || ![408, 429, 500, 502, 503, 504].includes(error.status)) return;
  if (error.retryAfter === null) return 500;
  const delay = /^\d+$/.test(error.retryAfter) ? Number(error.retryAfter) * 1000
    : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(error.retryAfter)
      ? Date.parse(error.retryAfter) - Date.now() : NaN;
  // Never shorten a provider's requested backoff to fit this optional attempt.
  if (!Number.isFinite(delay) || delay > 3000) return;
  return Math.max(500, delay);
}

function waitForRetry(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Match by provider locationId AND coordinates, never by response ordering.
export function parseElevationSamples(payload: unknown, points: readonly Point[]): Map<string, number | undefined> {
  const invalid = () => new InventoryCapacityError("elevation_invalid");
  if (!payload || typeof payload !== "object" || "error" in payload || !("samples" in payload) ||
      !Array.isArray(payload.samples) || payload.samples.length !== points.length) throw invalid();
  const result = new Map<string, number | undefined>();
  const ids = new Set<number>();
  for (const sample of payload.samples) {
    const id = sample?.locationId;
    const point = points[id];
    const location = sample?.location;
    if (!Number.isInteger(id) || !point || ids.has(id) || !location ||
        location.spatialReference?.wkid !== 4326 ||
        !Number.isFinite(location.x) || !Number.isFinite(location.y) ||
        Math.abs(location.x - point[0]) > 1e-8 || Math.abs(location.y - point[1]) > 1e-8) throw invalid();
    ids.add(id);
    // Explicit NoData remains missing evidence, not a zero elevation.
    const raw = sample.value;
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    const noData = raw === "NoData";
    if (!noData && (!Number.isFinite(value) || value < -500 || value > 9000)) throw invalid();
    result.set(key(point), noData ? undefined : value);
  }
  return result;
}

export async function fetchElevationBatch(points: readonly Point[], fetchImpl: typeof fetch, signal: AbortSignal,
  options: { retryTransient?: boolean } = {}) {
  const unique = new Map<string, Point>();
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
        Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw new InventoryCapacityError("elevation_invalid");
    unique.set(key(point), point);
  }
  const locations = [...unique.values()];
  const batches: Point[][] = [];
  for (let offset = 0; offset < locations.length; offset += 64) batches.push(locations.slice(offset, offset + 64));
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const results = new Map<string, number | undefined>();
  let next = 0;
  let completed = 0;
  let requests = 0;
  let retries = 0;
  const started = performance.now();
  const worker = async () => {
    while (next < batches.length) {
      combined.throwIfAborted();
      const batch = batches[next++];
      const url = new URL(ELEVATION_BATCH_URL);
      url.search = new URLSearchParams({ f: "json", geometryType: "esriGeometryMultipoint",
        geometry: JSON.stringify({ points: batch, spatialReference: { wkid: 4326 } }),
        returnFirstValueOnly: "true", interpolation: "RSP_BilinearInterpolation" }).toString();
      const budget = createResponseBudget(256 * 1024, 15_000);
      for (let attempt = 0; ; attempt++) {
        combined.throwIfAborted();
        try {
          requests++;
          const response = await fetchOperationResponse(url, { signal: combined, cache: "no-store" }, budget, fetchImpl);
          if (!response.ok) throw new ElevationHttpError(response.status, response.headers.get("retry-after"));
          const values = parseElevationSamples(await response.json(), batch);
          for (const [coordinate, value] of values) results.set(coordinate, value);
          completed++;
          break;
        } catch (error) {
          const delay = options.retryTransient && attempt === 0 && !combined.aborted ? retryDelay(error) : undefined;
          if (delay === undefined) throw error;
          console.info("[fireafter] elevation batch retry", { points: batch.length,
            ...(error instanceof ElevationHttpError ? { httpStatus: error.status } : { reason: (error as OutboundResponseError).code }) });
          await waitForRetry(delay, combined);
          // Retain consumed bytes and the caller's deadline; only this bounded
          // request attempt gets another 15 seconds. Successful batches are not fetched again.
          budget.deadline = performance.now() + 15_000;
          retries++;
        }
      }
    }
  };
  const workers = Array.from({ length: Math.min(4, batches.length) }, worker);
  try {
    await Promise.all(workers);
    combined.throwIfAborted();
    return (point: Point) => results.get(key(point));
  } catch (error) {
    controller.abort();
    await Promise.allSettled(workers);
    if (error instanceof ElevationHttpError) console.warn("[fireafter] elevation provider response", { httpStatus: error.status });
    if (signal.aborted || error instanceof OutboundResponseError && error.code === "timeout") {
      throw new InventoryCapacityError("elevation_deadline");
    }
    if (error instanceof InventoryCapacityError) throw error;
    throw new InventoryCapacityError("elevation_unavailable");
  } finally {
    console.info("[fireafter] elevation batch processing", { points: points.length, uniquePoints: locations.length,
      batches: batches.length, completed, requests, retries, elapsedMs: Math.round(performance.now() - started) });
  }
}
