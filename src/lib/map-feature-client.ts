import { MAP_CAPACITY_CODE, MAP_STREAM_BYTES, MAP_STREAM_TYPE, MapCapacityError, MapStreamCollector, mapStreamFailure, type MapFeaturesResponse } from "./map-stream-contract";

export async function fetchMapFeatures(incidentId: string, caller: AbortSignal): Promise<MapFeaturesResponse> {
  const timeout = AbortSignal.timeout(60_000), signal = AbortSignal.any([caller, timeout]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const check = () => { if (signal.aborted) throw mapStreamFailure(); };
  let abort: (() => void) | undefined;
  const canceled = new Promise<never>((_, reject) => {
    abort = () => { void reader?.cancel().catch(() => {}); reject(mapStreamFailure()); };
    signal.addEventListener("abort", abort, { once: true });
  });
  // fetch/read mocks and a stalled transport must not extend the full-body deadline.
  try {
    check();
    response = await Promise.race([fetch(`/api/map/features?incidentId=${encodeURIComponent(incidentId)}`, {
      signal, cache: "no-store", credentials: "same-origin", headers: { Accept: MAP_STREAM_TYPE },
    }), canceled]);
    check();
    if (response.status === 503 && response.headers.get("X-FireAfter-Map-Error") === MAP_CAPACITY_CODE) throw new MapCapacityError();
    if (!response.ok || !response.body) throw mapStreamFailure();
    const streamed = response.headers.get("content-type")?.split(";")[0].trim() === MAP_STREAM_TYPE;
    if (!streamed && response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw mapStreamFailure();
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true }), collector = new MapStreamCollector(incidentId);
    let received = 0, pending = "", sinceYield = 0, yieldedAt = performance.now();
    const yieldDue = () => sinceYield >= 256 * 1024 || performance.now() - yieldedAt >= 8;
    const yieldWork = async () => {
      await Promise.race([new Promise<void>(resolve => setTimeout(resolve, 0)), canceled]);
      check(); sinceYield = 0; yieldedAt = performance.now();
    };
    for (;;) {
      check();
      const chunk = await Promise.race([reader.read(), canceled]); check();
      if (chunk.done) break;
      received += chunk.value.byteLength; sinceYield += chunk.value.byteLength;
      if (received > MAP_STREAM_BYTES) throw mapStreamFailure();
      pending += decoder.decode(chunk.value, { stream: true });
      if (streamed) {
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line) throw mapStreamFailure();
          collector.accept(JSON.parse(line));
          if (yieldDue()) await yieldWork();
        }
      }
      // An incomplete record (or legacy JSON) must yield before its newline arrives too.
      if (yieldDue()) await yieldWork();
    }
    pending += decoder.decode(); check();
    if (streamed) {
      if (pending) throw mapStreamFailure();
      return collector.finish();
    }
    // Rolling deployment compatibility: bounded legacy JSON, never a second request.
    const legacy = JSON.parse(pending) as MapFeaturesResponse;
    if (legacy.incidentId !== incidentId) throw mapStreamFailure();
    return legacy;
  } catch (error) { throw error instanceof MapCapacityError ? error : mapStreamFailure(); }
  finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}
