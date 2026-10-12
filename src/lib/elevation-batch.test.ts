import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchElevationBatch, parseElevationSamples } from "./elevation-batch";

const points: [number, number][] = [[-121.3864667, 35.916267], [-121.3864667, 35.920267]];
function payload(locations = points) {
  return { samples: locations.map(([x, y], locationId) => ({ locationId,
    location: { x, y, spatialReference: { wkid: 4326 } }, value: String(100 + locationId) })) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("county-wide elevation batches", () => {
  it("matches reordered responses by identity and validates geographic roundoff", () => {
    const response = payload();
    response.samples[0].location.y += 1e-14;
    response.samples.reverse();
    expect([...parseElevationSamples(response, points).values()]).toEqual([101, 100]);
  });

  it.each(["missing", "duplicate", "wrong-coordinate", "wrong-crs", "nodata-number", "blank", "nan", "error"])(
    "rejects %s evidence instead of assigning a fabricated elevation", (failure) => {
      const response = payload();
      if (failure === "missing") response.samples.pop();
      if (failure === "duplicate") response.samples[1] = response.samples[0];
      if (failure === "wrong-coordinate") response.samples[0].location.x += 0.01;
      if (failure === "wrong-crs") response.samples[0].location.spatialReference.wkid = 3857;
      if (failure === "nodata-number") response.samples[0].value = "-1000000";
      if (failure === "blank") response.samples[0].value = " ";
      if (failure === "nan") response.samples[0].value = "NaN";
      expect(() => parseElevationSamples(failure === "error" ? { error: { code: 500 } } : response, points))
        .toThrow(expect.objectContaining({ code: "elevation_invalid" }));
    });

  it("preserves explicit NoData as unavailable, not zero", () => {
    const response = payload();
    response.samples[0].value = "NoData";
    expect(parseElevationSamples(response, points).get(points[0].join(","))).toBeUndefined();
  });

  it("completes 2,000 points in 32 requests, with at most four in flight and no omitted points", async () => {
    let active = 0; let peak = 0;
    const locations = Array.from({ length: 2000 }, (_, i) => [-121 + i / 100000, 36] as [number, number]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve();
      const url = new URL(String(input));
      const geometry = JSON.parse(url.searchParams.get("geometry")!);
      expect(geometry.points.length).toBeLessThanOrEqual(64);
      expect(url.searchParams.get("geometryType")).toBe("esriGeometryMultipoint");
      active--;
      return Response.json(payload(geometry.points));
    });
    const read = await fetchElevationBatch(locations, fetchImpl, new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledTimes(32);
    expect(peak).toBeLessThanOrEqual(4);
    expect(locations.every(point => Number.isFinite(read(point)))).toBe(true);
  });

  it("shares identical coordinate lookups without collapsing asset identities", async () => {
    const fetchImpl = vi.fn(async () => Response.json(payload()));
    const read = await fetchElevationBatch([...points, ...points], fetchImpl, new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(read(points[0])).toBe(100);
  });

  it.each(["headers", "body"])("cancels stalled %s and rejects the entire operation", async phase => {
    vi.useFakeTimers();
    let canceled = 0;
    const fetchImpl: typeof fetch = (_url, init) => phase === "body"
      ? Promise.resolve(new Response(new ReadableStream({ cancel() { canceled++; } })))
      : new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { canceled++; reject(init.signal?.reason); }, { once: true });
      });
    const result = fetchElevationBatch(points, fetchImpl, new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await result).toMatchObject({ code: "elevation_deadline" });
    expect(canceled).toBeGreaterThan(0);
  });

  it("honors the outer deadline even when each batch responds within its own budget", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let canceled = 0;
    const fetchImpl: typeof fetch = (input, init) => new Promise((resolve, reject) => {
      const job = setTimeout(() => resolve(Response.json(payload(JSON.parse(new URL(String(input)).searchParams.get("geometry")!).points))), 12_000);
      init?.signal?.addEventListener("abort", () => { clearTimeout(job); canceled++; reject(init.signal?.reason); }, { once: true });
    });
    const locations = Array.from({ length: 1600 }, (_, i) => [-121 + i / 100000, 36] as [number, number]);
    const result = fetchElevationBatch(locations, fetchImpl, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(await result).toMatchObject({ code: "elevation_deadline" });
    expect(canceled).toBeGreaterThanOrEqual(4);
    clearTimeout(timer);
  });
});

describe("bounded background terrain retry", () => {
  it.each([408, 429, 500, 502, 503, 504])("recovers one transient HTTP %s without changing request coordinates", async status => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("provider unavailable", { status }))
      .mockResolvedValueOnce(Response.json(payload()));
    const pending = fetchElevationBatch(points, fetchImpl, new AbortController().signal, { retryTransient: true });
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const read = await pending;
    expect(read(points[0])).toBe(100);
    expect(String(fetchImpl.mock.calls[1][0])).toBe(String(fetchImpl.mock.calls[0][0]));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404, 413, 414, 501])("does not retry non-transient HTTP %s", async status => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not retryable", { status }));
    await expect(fetchElevationBatch(points, fetchImpl, new AbortController().signal, { retryTransient: true }))
      .rejects.toMatchObject({ code: "elevation_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors provider Retry-After without resetting the total caller deadline", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(Response.json(payload()));
    const pending = fetchElevationBatch(points, fetchImpl, new AbortController().signal, { retryTransient: true });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending)(points[1])).toBe(101);
  });

  it("honors an HTTP-date Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T08:00:00Z"));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 503,
      headers: { "retry-after": "Thu, 08 Oct 2026 08:00:02 GMT" } })).mockResolvedValueOnce(Response.json(payload()));
    const pending = fetchElevationBatch(points, fetchImpl, new AbortController().signal, { retryTransient: true });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending)(points[0])).toBe(100);
  });

  it.each(["120", "invalid", "-1"])("does not shorten or reinterpret Retry-After %s", async retryAfter => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("busy", { status: 429, headers: { "retry-after": retryAfter } }));
    await expect(fetchElevationBatch(points, fetchImpl, new AbortController().signal, { retryTransient: true }))
      .rejects.toMatchObject({ code: "elevation_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries one timed-out transport and settles its canceled request before succeeding", async () => {
    vi.useFakeTimers();
    let canceled = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { canceled++; reject(init.signal?.reason); }, { once: true });
    })).mockResolvedValueOnce(Response.json(payload()));
    const pending = fetchElevationBatch(points, fetchImpl, new AbortController().signal, { retryTransient: true });
    await vi.advanceTimersByTimeAsync(15_501);
    expect((await pending)(points[0])).toBe(100);
    expect(canceled).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows at most two attempts and never exposes partial values after repeated timeouts", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const pending = fetchElevationBatch(points, fetchImpl, new AbortController().signal, { retryTransient: true }).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_501);
    expect(await pending).toMatchObject({ code: "elevation_deadline" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([250, 16_000])("honors outer cancellation at %s ms during backoff or retry", async abortAt => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), abortAt);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => abortAt < 500
      ? Promise.resolve(new Response("busy", { status: 503 }))
      : new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    const pending = fetchElevationBatch(points, fetchImpl, controller.signal, { retryTransient: true }).catch(error => error);
    await vi.advanceTimersByTimeAsync(abortAt + 1);
    expect(await pending).toMatchObject({ code: "elevation_deadline" });
    expect(fetchImpl).toHaveBeenCalledTimes(abortAt < 500 ? 1 : 2);
    clearTimeout(timer);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never retries corrupt coordinate evidence", async () => {
    const invalid = payload();
    invalid.samples[0].location.x += 1;
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(invalid));
    await expect(fetchElevationBatch(points, fetchImpl, new AbortController().signal, { retryTransient: true }))
      .rejects.toMatchObject({ code: "elevation_invalid" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the combined byte budget across attempts", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("x".repeat(256 * 1024 - 100), { status: 503 }))
      .mockResolvedValueOnce(Response.json(payload()));
    const pending = fetchElevationBatch(points, fetchImpl, new AbortController().signal, { retryTransient: true }).catch(error => error);
    await vi.advanceTimersByTimeAsync(501);
    expect(await pending).toMatchObject({ code: "elevation_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not refetch a successful sibling batch when another batch retries", async () => {
    vi.useFakeTimers();
    const locations = Array.from({ length: 128 }, (_, i) => [-121 + i / 100000, 36] as [number, number]);
    const counts = new Map<string, number>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async input => {
      const batch = JSON.parse(new URL(String(input)).searchParams.get("geometry")!).points;
      const id = String(batch[0][0]);
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      return batch[0][0] === locations[0][0] && count === 1
        ? new Response("busy", { status: 503 }) : Response.json(payload(batch));
    });
    const pending = fetchElevationBatch(locations, fetchImpl, new AbortController().signal, { retryTransient: true });
    await vi.advanceTimersByTimeAsync(501);
    const read = await pending;
    expect(locations.every(point => Number.isFinite(read(point)))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(counts.get(String(locations[64][0]))).toBe(1);
  });
});
