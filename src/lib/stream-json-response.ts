import "server-only";
import { MAP_STREAM_BYTES, MapCapacityError } from "./map-stream-contract";

// Serialize/validate before sending headers, then stream without omitting any geometry.
export function streamJsonResponse(value: unknown, signal?: AbortSignal): Response {
  let bytes: Uint8Array | null = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > MAP_STREAM_BYTES) throw new MapCapacityError();
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) { bytes = null; controller.error(new Error("Map response canceled")); return; }
      if (!bytes || offset >= bytes.length) { bytes = null; controller.close(); return; }
      const end = Math.min(offset + 64 * 1024, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() { bytes = null; },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}
