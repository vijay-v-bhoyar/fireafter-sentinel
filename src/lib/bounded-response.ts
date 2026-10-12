export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const failures = {
  timeout: "Upstream response exceeded its full-body deadline.",
  too_large: "Upstream response exceeded its byte budget; no partial response was accepted.",
  aborted: "Upstream request was canceled; any earlier write outcome must be reconciled.",
  network: "Upstream response could not be completed; any write outcome is unconfirmed.",
  invalid_response: "Upstream response did not satisfy the transport contract.",
  invalid_config: "Upstream response budget is invalid.",
} as const;

export class OutboundResponseError extends Error {
  constructor(readonly code: keyof typeof failures) {
    super(failures[code]);
    this.name = "OutboundResponseError";
  }
}

export type ResponseBudget = { deadline: number; remainingBytes: number };

export function responseByteLimit(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1024 && parsed <= MAX_RESPONSE_BYTES
    ? parsed : DEFAULT_MAX_RESPONSE_BYTES;
}

export function createResponseBudget(maxBytes: number, timeoutMs: number): ResponseBudget {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new OutboundResponseError("invalid_config");
  }
  return { deadline: performance.now() + timeoutMs, remainingBytes: maxBytes };
}

export async function fetchBoundedResponse(
  input: RequestInfo | URL, init: RequestInit | undefined,
  budget: ResponseBudget, fetchImpl: typeof fetch = fetch,
  consumeBytes?: (bytes: number) => void,
  trackSettlement?: (pending: Promise<unknown>) => void,
): Promise<Response> {
  if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.remainingBytes) ||
      budget.remainingBytes < 0 || budget.remainingBytes > MAX_RESPONSE_BYTES) throw new OutboundResponseError("invalid_config");
  const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  let ended = false;
  const track = <T>(pending: Promise<T>) => { trackSettlement?.(pending); return pending; };
  const check = () => {
    if (upstream?.aborted) throw new OutboundResponseError("aborted");
    if (performance.now() >= budget.deadline) throw new OutboundResponseError("timeout");
  };
  try {
    check();
    const pending = fetchImpl(input, { ...init, signal: controller.signal });
    // Even an implementation that ignores abort cannot retain a late response body.
    void track(pending.then((late) => { if (ended) return late.body?.cancel(); }, () => undefined)).catch(() => undefined);
    response = await beforeDeadline(pending, upstream, budget.deadline);
    check();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
      throw new OutboundResponseError("invalid_response");
    }
    // HEAD describes the resource representation, not bytes in this response.
    const isHead = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() === "HEAD";
    if (response.body && !isHead && length !== null && Number(length) > budget.remainingBytes) {
      throw new OutboundResponseError("too_large");
    }
    let body: Uint8Array<ArrayBuffer> | null = null;
    if (response.body && !isHead) {
      reader = response.body.getReader();
      const bytes = new Uint8Array(budget.remainingBytes);
      let size = 0;
      while (true) {
        check();
        const chunk = await beforeDeadline(track(reader.read()), upstream, budget.deadline);
        check();
        if (chunk.done) break;
        if (!ArrayBuffer.isView(chunk.value) || Object.prototype.toString.call(chunk.value) !== "[object Uint8Array]") {
          throw new OutboundResponseError("invalid_response");
        }
        const count = chunk.value.byteLength;
        consumeBytes?.(count);
        if (count > budget.remainingBytes) {
          budget.remainingBytes = 0;
          throw new OutboundResponseError("too_large");
        }
        budget.remainingBytes -= count;
        bytes.set(chunk.value, size);
        size += count;
      }
      body = bytes.subarray(0, size);
    }
    const headers = new Headers(response.headers);
    if (body) {
      // Fetch supplies decoded bytes; do not describe the reconstructed body as compressed.
      headers.delete("content-encoding");
      headers.delete("transfer-encoding");
      headers.set("content-length", String(body.byteLength));
    }
    const buffered = new Response(body, { status: response.status, statusText: response.statusText, headers });
    Object.defineProperties(buffered, {
      url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
    });
    complete = true;
    return buffered;
  } catch (error) {
    throw error instanceof OutboundResponseError ? error : new OutboundResponseError("network");
  } finally {
    ended = true;
    if (!complete) {
      controller.abort();
      if (reader) void track(reader.cancel()).catch(() => undefined);
      else if (response?.body) void track(response.body.cancel()).catch(() => undefined);
    }
    reader?.releaseLock();
  }
}

async function beforeDeadline<T>(pending: Promise<T>, signal: AbortSignal | null | undefined, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      // Observe rejection even if the caller was canceled while creating this operation.
      pending.then(resolve, reject);
      abort = () => reject(new OutboundResponseError("aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const expire = () => {
        const remaining = deadline - performance.now();
        // Timers may round fractional delays down; the monotonic deadline is authoritative.
        if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
        else reject(new OutboundResponseError("timeout"));
      };
      expire();
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
