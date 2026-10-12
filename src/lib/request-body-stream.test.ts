import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { readBoundedRequestBody, requestBodyFailure, requestBodyTimeoutMs } from "./request-limits";

function streamed(body: ReadableStream<Uint8Array>, signal?: AbortSignal, headers?: HeadersInit) {
  return new Request("http://localhost/api/incident", {
    method: "POST", body, signal, headers, duplex: "half",
  } as RequestInit);
}
const encode = (text: string) => new TextEncoder().encode(text);
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("FA13-IN2 streamed body acquisition", () => {
  it("accepts genuine Uint8Array chunks from another runtime realm", async () => {
    const bytes = runInNewContext("new Uint8Array([123,125])") as Uint8Array;
    expect(bytes instanceof Uint8Array).toBe(false);
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    expect(await (await readBoundedRequestBody(streamed(body), 10)).json()).toEqual({});
  });
  it.each([undefined, "", "bad", "249", "30001", "Infinity", "300.5"])("uses a bounded default for %s", (value) => {
    expect(requestBodyTimeoutMs(value)).toBe(10000);
  });
  it.each(["250", "1000", "30000"])("accepts timeout %s", (value) => expect(requestBodyTimeoutMs(value)).toBe(Number(value)));

  it("accepts the exact byte limit across split UTF-8 characters", async () => {
    const bytes = encode('"\u00e9"');
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    const response = await readBoundedRequestBody(streamed(body), bytes.length);
    expect(await response.json()).toBe("\u00e9");
  });
  it("rejects one byte over the limit and cancels without awaiting a stuck cancel", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode("12345")); }, cancel });
    await expect(readBoundedRequestBody(streamed(body), 4)).rejects.toMatchObject({ code: "body_too_large", status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels a stalled stream at the total deadline", async () => {
    vi.useFakeTimers(); vi.stubEnv("FIREAFTER_REQUEST_BODY_TIMEOUT_MS", "250");
    const cancel = vi.fn();
    const promise = readBoundedRequestBody(streamed(new ReadableStream({ cancel })), 100);
    const assertion = expect(promise).rejects.toMatchObject({ code: "body_timeout", status: 408 });
    await vi.advanceTimersByTimeAsync(251);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not reset the deadline when another chunk arrives", async () => {
    vi.useFakeTimers(); vi.stubEnv("FIREAFTER_REQUEST_BODY_TIMEOUT_MS", "250");
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    const assertion = expect(readBoundedRequestBody(streamed(body), 100)).rejects.toMatchObject({ code: "body_timeout" });
    await vi.advanceTimersByTimeAsync(200);
    source.enqueue(encode("first"));
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
  });
  it.each([true, false])("honors cancellation (before read: %s)", async (before) => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    if (before) controller.abort("sensitive cancellation reason");
    const assertion = expect(readBoundedRequestBody(streamed(body, controller.signal), 100)).rejects.toMatchObject({ code: "body_interrupted", status: 400 });
    if (!before) controller.abort("sensitive cancellation reason");
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("releases timers and abort listeners between tiny chunks", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    let count = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (count++ < 2000) c.enqueue(encode("x")); else c.close(); } });
    const request = streamed(body, signal);
    const add = vi.spyOn(request.signal, "addEventListener");
    const remove = vi.spyOn(request.signal, "removeEventListener");
    const response = await readBoundedRequestBody(request, 2000);
    expect((await response.text()).length).toBe(2000);
    expect(add).toHaveBeenCalledTimes(2001);
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["gzip", "br", "identity,gzip"])("rejects unsupported encoding %s before pulling payload", async (encoding) => {
    const cancel = vi.fn();
    await expect(readBoundedRequestBody(streamed(new ReadableStream({ cancel }), undefined, { "content-encoding": encoding }), 100)).rejects.toMatchObject({ code: "body_encoding", status: 415 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not expose upstream stream errors in response or telemetry", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    let error: unknown;
    try { await readBoundedRequestBody(streamed(new ReadableStream({ start(c) { c.error(new Error("PRIVATE-PAYLOAD")); } })), 100); } catch (caught) { error = caught; }
    const failure = requestBodyFailure(error, "Request too large");
    expect(failure?.status).toBe(400);
    expect(JSON.stringify([failure, log.mock.calls])).not.toContain("PRIVATE-PAYLOAD");
    expect(log).toHaveBeenCalledWith("[fireafter] request body rejected", { code: "body_interrupted", status: 400 });
  });
  it("does not retain attacker Content-Length in the parser response", async () => {
    const response = await readBoundedRequestBody(new Request("http://localhost", {
      method: "POST", headers: { "content-length": "1", "content-type": "application/json" }, body: '{"ok":true}',
    }), 100);
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });
});
