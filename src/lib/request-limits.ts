export const STANDARD_MUTATION_BODY_BYTES = 32 * 1024;
export const ASSET_IMPORT_BODY_BYTES = 1_100_000;
export const ASSET_IMPORT_CONTENT_CHARS = 1_000_000;
export const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 10_000;

const bodyFailures = {
  body_too_large: { status: 413, message: "Request payload too large" },
  body_timeout: { status: 408, message: "Request body timed out. Check your connection before retrying." },
  body_interrupted: { status: 400, message: "Request body was interrupted. Check your connection before retrying." },
  body_encoding: { status: 415, message: "Compressed request bodies are not supported. Send an uncompressed request." },
} as const;

export class RequestBodyError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof bodyFailures) {
    super(bodyFailures[code].message);
    this.name = "RequestBodyError";
    this.status = bodyFailures[code].status;
  }
}

export class RequestTooLargeError extends RequestBodyError {
  constructor() {
    super("body_too_large");
    this.name = "RequestTooLargeError";
  }
}

export function requestExceedsLimit(request: Request, maxBytes: number) {
  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return false;
  if (!/^\d+$/.test(rawLength)) return true;

  const length = Number(rawLength);
  return !Number.isSafeInteger(length) || length > maxBytes;
}

export function assertTextWithinLimit(value: string, maxChars: number) {
  if (value.length > maxChars) throw new RequestTooLargeError();
}

export function requestBodyTimeoutMs(value: unknown = process.env.FIREAFTER_REQUEST_BODY_TIMEOUT_MS) {
  const configured = Number(value);
  return Number.isSafeInteger(configured) && configured >= 250 && configured <= 30_000
    ? configured : DEFAULT_REQUEST_BODY_TIMEOUT_MS;
}

export function requestBodyFailure(error: unknown, tooLargeMessage: string) {
  if (!(error instanceof RequestBodyError)) return null;
  console.warn("[fireafter] request body rejected", { code: error.code, status: error.status });
  return { status: error.status, message: error instanceof RequestTooLargeError ? tooLargeMessage : error.message };
}

export async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<Response> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ASSET_IMPORT_BODY_BYTES) {
    throw new RangeError("Invalid request body byte budget");
  }
  const reader = request.body?.getReader();
  const timeoutMs = requestBodyTimeoutMs();
  const deadline = performance.now() + timeoutMs;
  let complete = false;
  try {
    if (request.signal.aborted) throw new RequestBodyError("body_interrupted");
    if (requestExceedsLimit(request, maxBytes)) throw new RequestTooLargeError();
    const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity") throw new RequestBodyError("body_encoding");
    if (!reader) return new Response(null, { headers: { "content-type": request.headers.get("content-type") ?? "" } });

    // A fixed buffer also bounds metadata when a sender streams one byte at a time.
    const bytes = new Uint8Array(maxBytes);
    let size = 0;
    while (true) {
      if (request.signal.aborted) throw new RequestBodyError("body_interrupted");
      if (performance.now() >= deadline) throw new RequestBodyError("body_timeout");
      const chunk = await readChunkBeforeDeadline(reader, request.signal, deadline);
      if (request.signal.aborted) throw new RequestBodyError("body_interrupted");
      if (performance.now() >= deadline) throw new RequestBodyError("body_timeout");
      if (chunk.done) break;
      // Web streams can supply bytes from a different realm (including Node/DOM bridges).
      if (!ArrayBuffer.isView(chunk.value) || Object.prototype.toString.call(chunk.value) !== "[object Uint8Array]") {
        throw new RequestBodyError("body_interrupted");
      }
      if (chunk.value.byteLength > maxBytes - size) throw new RequestTooLargeError();
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    complete = true;
    return new Response(bytes.subarray(0, size), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    });
  } catch (error) {
    throw error instanceof RequestBodyError ? error : new RequestBodyError("body_interrupted");
  } finally {
    // Cancellation itself can hang on a broken transport; it must not hold the route.
    if (reader && !complete) void reader.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

async function readChunkBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, deadline: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      abort = () => reject(new RequestBodyError("body_interrupted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      timer = setTimeout(() => reject(new RequestBodyError("body_timeout")), Math.max(0, deadline - performance.now()));
      reader.read().then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
