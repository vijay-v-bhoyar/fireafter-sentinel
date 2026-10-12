import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { fetchBoundedResponse, OutboundResponseError, type ResponseBudget } from "./bounded-response";

type Operation = "create" | "refresh" | "fire_context" | "asset_import" | "cron";
type Code = "refresh_config" | "refresh_busy" | "refresh_deadline" | "refresh_requests" |
  "refresh_bytes" | "refresh_canceled" | "refresh_closed" | "refresh_body";
export class RefreshOperationError extends Error {
  readonly status = 503;
  constructor(readonly code: Code) {
    super("Refresh operation could not complete within its resource policy. Review Operational Health and ask an operator to check capacity/configuration. A dispatched write may have committed; reload or reconcile the original operation before retrying.");
    this.name = "RefreshOperationError";
  }
}

function setting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RefreshOperationError("refresh_config");
  return value;
}

const operations = new AsyncLocalStorage<RefreshOperation>();
let activeOperations = 0;
const MAX_ACTIVE_OPERATIONS = 4;
const MAX_HTTP_REQUESTS = 4;

class RefreshOperation {
  readonly controller = new AbortController();
  readonly started = performance.now();
  readonly timeoutMs = setting("FIREAFTER_REFRESH_TIMEOUT_MS", 120_000, 250, 300_000);
  readonly deadline = this.started + this.timeoutMs;
  // Includes previous inventory, complete provider acquisition, and committed readback.
  readonly maxBytes = setting("FIREAFTER_REFRESH_MAX_BYTES", 96 * 1024 * 1024, 1024, 256 * 1024 * 1024);
  readonly maxRequests = setting("FIREAFTER_REFRESH_MAX_REQUESTS", 512, 1, 4096);
  bytes = 0;
  requests = 0;
  inflight = 0;
  finished = false;
  released = false;
  readonly waiting: Array<() => void> = [];

  fail(code: Code): never {
    if (!this.controller.signal.aborted) this.controller.abort(new RefreshOperationError(code));
    throw this.controller.signal.reason;
  }
  check() {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    if (this.finished) this.fail("refresh_closed");
    if (performance.now() >= this.deadline) this.fail("refresh_deadline");
  }
  consume(bytes: number) {
    this.check();
    if (bytes > this.maxBytes - this.bytes) this.fail("refresh_bytes");
    this.bytes += bytes;
  }
  async acquire(caller: AbortSignal | null | undefined, deadline: number) {
    this.check();
    const checkRequest = () => {
      if (caller?.aborted) throw new OutboundResponseError("aborted");
      if (!Number.isFinite(deadline)) throw new OutboundResponseError("invalid_config");
      if (performance.now() >= deadline) throw new OutboundResponseError("timeout");
    };
    checkRequest();
    if (this.inflight < MAX_HTTP_REQUESTS) { this.inflight++; return; }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", abort);
        caller?.removeEventListener("abort", cancel);
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true; cleanup(); reject(error);
      };
      const grant = () => {
        if (settled) return;
        try { this.check(); checkRequest(); } catch (error) { fail(error); return; }
        settled = true; cleanup();
        this.inflight++;
        resolve();
      };
      const abort = () => fail(this.controller.signal.reason);
      const cancel = () => fail(new OutboundResponseError("aborted"));
      this.waiting.push(grant);
      this.controller.signal.addEventListener("abort", abort, { once: true });
      caller?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => fail(new OutboundResponseError("timeout")), Math.max(0, deadline - performance.now()));
      if (this.controller.signal.aborted) abort();
      else if (caller?.aborted) cancel();
    });
  }
  release() {
    this.inflight--;
    while (!this.controller.signal.aborted && this.inflight < MAX_HTTP_REQUESTS && this.waiting.length) this.waiting.shift()!();
    this.releaseAdmission();
  }
  releaseAdmission() {
    if (this.finished && this.inflight === 0 && !this.released) {
      this.released = true;
      activeOperations--;
    }
  }
}

export function hasRefreshOperation() { return Boolean(operations.getStore()); }

export function assertRefreshOperationActive() {
  operations.getStore()?.check();
}

export async function withRefreshOperation<T>(name: Operation, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const parent = operations.getStore();
  if (parent) {
    parent.check();
    const cancelParent = () => parent.controller.abort(new RefreshOperationError("refresh_canceled"));
    signal?.addEventListener("abort", cancelParent, { once: true });
    if (signal?.aborted) cancelParent();
    try {
      parent.check();
      const result = await action();
      parent.check();
      return result;
    } finally { signal?.removeEventListener("abort", cancelParent); }
  }
  if (signal?.aborted) throw new RefreshOperationError("refresh_canceled");
  if (activeOperations >= MAX_ACTIVE_OPERATIONS) throw new RefreshOperationError("refresh_busy");
  const operation = new RefreshOperation();
  activeOperations++;
  const abort = () => operation.controller.abort(new RefreshOperationError("refresh_canceled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => operation.controller.abort(new RefreshOperationError("refresh_deadline")), operation.timeoutMs);
  let rejectCanceled: (() => void) | undefined;
  const canceled = new Promise<never>((_, reject) => {
    rejectCanceled = () => {
      console.warn(JSON.stringify({ event: "fireafter.refresh.operation.limit", operation: name,
        code: operation.controller.signal.reason.code, requests: operation.requests, bytes: operation.bytes,
        elapsedMs: Math.round(performance.now() - operation.started) }));
      reject(operation.controller.signal.reason);
    };
    operation.controller.signal.addEventListener("abort", rejectCanceled, { once: true });
    if (operation.controller.signal.aborted) rejectCanceled();
  });
  const work = operations.run(operation, async () => {
    let outcome = "completed";
    try {
      operation.check();
      const result = await action();
      operation.check();
      return result;
    } catch (error) {
      outcome = error instanceof RefreshOperationError ? error.code : "failed";
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (rejectCanceled) operation.controller.signal.removeEventListener("abort", rejectCanceled);
      operation.finished = true;
      operation.controller.abort(new RefreshOperationError("refresh_closed"));
      operation.releaseAdmission();
      console.info(JSON.stringify({ event: "fireafter.refresh.operation", operation: name, outcome,
        requests: operation.requests, bytes: operation.bytes, elapsedMs: Math.round(performance.now() - operation.started) }));
    }
  });
  // Keep admission held until actual work and tracked transports settle, not just the timeout response.
  return Promise.race([work, canceled]);
}

export async function fetchOperationResponse(input: RequestInfo | URL, init: RequestInit | undefined,
  budget: ResponseBudget, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const operation = operations.getStore();
  if (!operation) return fetchBoundedResponse(input, init, budget, fetchImpl);
  const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  await operation.acquire(caller, budget.deadline);
  let pending = 0;
  let wrapperDone = false;
  let released = false;
  const release = () => {
    if (wrapperDone && pending === 0 && !released) { released = true; operation.release(); }
  };
  const trackSettlement = (promise: Promise<unknown>) => {
    pending++;
    const settled = () => { pending--; release(); };
    void promise.then(settled, settled);
  };
  try {
    operation.check();
    if (operation.requests >= operation.maxRequests) operation.fail("refresh_requests");
    const body = init?.body;
    if (typeof body === "string") operation.consume(Buffer.byteLength(body));
    else if (body !== undefined && body !== null || (input instanceof Request && input.body && body === undefined)) {
      operation.fail("refresh_body");
    }
    operation.requests++;
    budget.deadline = Math.min(budget.deadline, operation.deadline);
    const signal = caller ? AbortSignal.any([caller, operation.controller.signal]) : operation.controller.signal;
    const response = await fetchBoundedResponse(input, { ...init, signal }, budget, fetchImpl, count => operation.consume(count), trackSettlement);
    operation.check();
    return response;
  } catch (error) {
    operation.check();
    throw error;
  } finally { wrapperDone = true; release(); }
}
