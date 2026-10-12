import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { createResponseBudget, fetchBoundedResponse, responseByteLimit } from "./bounded-response";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const url = "https://example.test/response";
const encode = (text: string) => new TextEncoder().encode(text);

describe("FA13-OUT2 complete-response budgets", () => {
  it.each([undefined, "", "NaN", "1023", "67108865", "Infinity", "1000.5"])("uses a safe cap for %s", (value) => {
    expect(responseByteLimit(value)).toBe(8388608);
  });
  it("accepts the supported cap endpoints", () => {
    expect(responseByteLimit("1024")).toBe(1024);
    expect(responseByteLimit("67108864")).toBe(67108864);
  });
  it("preserves successful and HTTP error status, bodies and SDK headers", async () => {
    for (const status of [200, 201, 400, 401, 403, 500]) {
      const response = await fetchBoundedResponse(url, undefined, createResponseBudget(1000, 1000),
        async () => new Response('{"ok":true}', { status, headers: { "content-type": "application/json", "content-range": "0-9/10" } }));
      expect(response.status).toBe(status);
      expect(response.headers.get("content-range")).toBe("0-9/10");
      expect(await response.json()).toEqual({ ok: true });
    }
  });
  it("supports HEAD and bodyless 204/205/304 without false oversized rejection", async () => {
    for (const status of [200, 204, 205, 304]) {
      const response = await fetchBoundedResponse(url, { method: "HEAD" }, createResponseBudget(10, 1000),
        async () => new Response(null, { status, headers: { "content-length": "1000000", "content-range": "*/123" } }));
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.headers.get("content-range")).toBe("*/123");
    }
  });
  it("accepts split UTF-8 and genuine cross-realm byte arrays at the exact cap", async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(runInNewContext("new Uint8Array([34,195])") as Uint8Array);
      c.enqueue(new Uint8Array([169, 34])); c.close();
    } });
    const response = await fetchBoundedResponse(url, undefined, createResponseBudget(4, 1000), async () => new Response(body));
    expect(await response.json()).toBe("\u00e9");
  });
  it("bounds actual decoded bytes and cancels a rejected body without awaiting cancel", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode("12345")); }, cancel });
    await expect(fetchBoundedResponse(url, undefined, createResponseBudget(4, 1000), async () => new Response(body, { headers: { "content-length": "1" } })))
      .rejects.toMatchObject({ code: "too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects headers that never arrive even if fetch ignores abort, then cancels a late body", async () => {
    vi.useFakeTimers();
    let arrive!: (r: Response) => void;
    const cancel = vi.fn();
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = (_input, init) => { signal = init?.signal; return new Promise(resolve => { arrive = resolve; }); };
    const assertion = expect(fetchBoundedResponse(url, undefined, createResponseBudget(100, 250), fetchImpl)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(251); await assertion;
    expect(signal?.aborted).toBe(true);
    arrive(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the original deadline through headers and partial body progress", async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const fetchImpl = async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return new Response(new ReadableStream<Uint8Array>({ start(c) { source = c; }, cancel }));
    };
    const assertion = expect(fetchBoundedResponse(url, undefined, createResponseBudget(100, 250), fetchImpl)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(200); source.enqueue(encode("part"));
    await vi.advanceTimersByTimeAsync(51); await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(["timeout", "success"])("rechecks an early timer wake without losing cleanup: %s", async (outcome) => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let arrive!: (response: Response) => void;
    let settled = false;
    const request = fetchBoundedResponse(url, undefined, createResponseBudget(100, 250.4),
      () => new Promise(resolve => { arrive = resolve; }));
    void request.then(() => { settled = true; }, () => { settled = true; });
    const assertion = outcome === "timeout"
      ? expect(request).rejects.toMatchObject({ code: "timeout" })
      : expect(request).resolves.toMatchObject({ status: 200 });

    // Exercise a wake before the monotonic deadline, independent of platform timer precision.
    now = 250.1;
    await vi.advanceTimersByTimeAsync(251);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    if (outcome === "timeout") {
      now = 250.4;
      await vi.advanceTimersByTimeAsync(1);
    } else {
      arrive(new Response("ok"));
    }
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["Request", "init"])("honors the caller %s abort while reading", async (kind) => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({ cancel }));
    const input = kind === "Request" ? new Request(url, { signal: controller.signal }) : url;
    const request = fetchBoundedResponse(input, kind === "init" ? { signal: controller.signal } : undefined, createResponseBudget(100, 1000), fetchImpl);
    const assertion = expect(request).rejects.toMatchObject({ code: "aborted" });
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort("PRIVATE-REASON");
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("shares bytes across attempts instead of resetting the budget", async () => {
    const budget = createResponseBudget(10, 1000);
    await fetchBoundedResponse(url, undefined, budget, async () => new Response("123456", { status: 503 }));
    expect(budget.remainingBytes).toBe(4);
    await expect(fetchBoundedResponse(url, undefined, budget, async () => new Response("12345"))).rejects.toMatchObject({ code: "too_large" });
  });
  it("does not retain private transport diagnostics", async () => {
    await expect(fetchBoundedResponse(url, undefined, createResponseBudget(10, 1000), async () => { throw new Error("PRIVATE-token-url"); }))
      .rejects.toMatchObject({ code: "network", message: "Upstream response could not be completed; any write outcome is unconfirmed." });
  });
  it("handles simultaneous body failure and caller cancellation without an unhandled rejection", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      controller.abort(); c.error(new Error("PRIVATE-stream-error"));
    } }, { highWaterMark: 0 });
    await expect(fetchBoundedResponse(url, { signal: controller.signal }, createResponseBudget(10, 1000), async () => new Response(body)))
      .rejects.toMatchObject({ code: "aborted" });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  it("releases listeners and timers for many small chunks", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, "addEventListener"), remove = vi.spyOn(signal, "removeEventListener");
    let i = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (i++ < 2000) c.enqueue(encode("x")); else c.close(); } });
    await fetchBoundedResponse(url, { signal }, createResponseBudget(2000, 1000), async () => new Response(body));
    expect(add).toHaveBeenCalledTimes(2002);
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
    expect(vi.getTimerCount()).toBe(0);
  });
});
