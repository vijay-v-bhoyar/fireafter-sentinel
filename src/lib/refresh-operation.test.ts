import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createResponseBudget } from "./bounded-response";
import { assertRefreshOperationActive, fetchOperationResponse, withRefreshOperation } from "./refresh-operation";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const transport = () => vi.fn(async () => new Response("ok"));
const request = (fetchImpl: typeof fetch, body?: string) => fetchOperationResponse(
  "https://test.invalid/private-path", body ? { method: "POST", body } : undefined,
  createResponseBudget(8192, 5000), fetchImpl,
);
beforeEach(() => {
  vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "5000");
  vi.stubEnv("FIREAFTER_REFRESH_MAX_REQUESTS", "512");
  vi.stubEnv("FIREAFTER_REFRESH_MAX_BYTES", "67108864");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("nested operations share request allowance", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_MAX_REQUESTS", "2");
  const fetchImpl = transport();
  await expect(withRefreshOperation("asset_import", async () => {
    await request(fetchImpl);
    await withRefreshOperation("refresh", async () => {
      await request(fetchImpl);
      await request(fetchImpl);
    });
  })).rejects.toMatchObject({ code: "refresh_requests" });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("charges UTF-8 request bodies and response bodies together", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_MAX_BYTES", "1024");
  const fetchImpl = transport();
  await expect(withRefreshOperation("refresh", async () => {
    await request(fetchImpl, "\u00e9".repeat(400));
    await request(fetchImpl, "x".repeat(223));
  })).rejects.toMatchObject({ code: "refresh_bytes" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("admits at most four operations and releases their slots", async () => {
  const gate = deferred();
  const work = Array.from({ length: 4 }, () => withRefreshOperation("refresh", () => gate.promise));
  const action = vi.fn(async () => undefined);
  try {
    await expect(withRefreshOperation("create", action)).rejects.toMatchObject({ code: "refresh_busy" });
    expect(action).not.toHaveBeenCalled();
  } finally { gate.resolve(); await Promise.all(work); }
  await withRefreshOperation("create", action);
  expect(action).toHaveBeenCalledTimes(1);
});

it("reserves HTTP slots before allowing queued requests through", async () => {
  const gate = deferred();
  let inflight = 0;
  let peak = 0;
  const fetchImpl = vi.fn(async () => {
    inflight++; peak = Math.max(peak, inflight);
    await gate.promise;
    inflight--;
    return new Response("ok");
  });
  const work = withRefreshOperation("refresh", () => Promise.all(Array.from({ length: 12 }, () => request(fetchImpl))));
  try { await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4)); }
  finally { gate.resolve(); await work; }
  expect(fetchImpl).toHaveBeenCalledTimes(12);
  expect(peak).toBe(4);
});

it("cancels queued and in-flight HTTP without dispatching queued work", async () => {
  const controller = new AbortController();
  let canceled = 0;
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { canceled++; reject(init!.signal!.reason); }, { once: true });
    });
  });
  const work = withRefreshOperation("refresh", () => Promise.all(Array.from({ length: 7 }, () => request(fetchImpl))), controller.signal);
  const outcome = expect(work).rejects.toMatchObject({ code: "refresh_canceled" });
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  controller.abort();
  await outcome;
  await vi.waitFor(() => expect(canceled).toBe(4));
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

it("canceled unfinished callbacks retain admission and cannot resume transport", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const fetchImpl = transport();
  const roots = Array.from({ length: 4 }, () => withRefreshOperation("refresh", async () => {
    await gate.promise;
    await request(fetchImpl);
  }, controller.signal));
  const outcomes = Promise.all(roots.map(root => expect(root).rejects.toMatchObject({ code: "refresh_canceled" })));
  controller.abort(); await outcomes;
  try {
    await expect(withRefreshOperation("refresh", async () => undefined)).rejects.toMatchObject({ code: "refresh_busy" });
  } finally { gate.resolve(); }
  await vi.waitFor(async () => { await withRefreshOperation("create", async () => undefined); });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("a completed scope cannot dispatch detached late work", async () => {
  const gate = deferred();
  const fetchImpl = transport();
  let detached!: Promise<unknown>;
  await withRefreshOperation("refresh", async () => {
    detached = gate.promise.then(() => request(fetchImpl));
  });
  const outcome = expect(detached).rejects.toMatchObject({ code: "refresh_closed" });
  gate.resolve(); await outcome;
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("nested cancellation aborts the shared parent", async () => {
  const controller = new AbortController();
  controller.abort();
  const action = vi.fn(async () => undefined);
  await expect(withRefreshOperation("asset_import", () => withRefreshOperation("refresh", action, controller.signal)))
    .rejects.toMatchObject({ code: "refresh_canceled" });
  expect(action).not.toHaveBeenCalled();
});

it.each(["FIREAFTER_REFRESH_TIMEOUT_MS", "FIREAFTER_REFRESH_MAX_REQUESTS", "FIREAFTER_REFRESH_MAX_BYTES"])(
  "invalid %s fails closed before work", async name => {
    vi.stubEnv(name, "invalid");
    const action = vi.fn(async () => undefined);
    await expect(withRefreshOperation("refresh", action)).rejects.toMatchObject({ code: "refresh_config" });
    expect(action).not.toHaveBeenCalled();
  },
);

it("deadline emits immediate safe diagnostics even if callback has not settled", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "250");
  const gate = deferred();
  const work = withRefreshOperation("refresh", () => gate.promise);
  try {
    await expect(work).rejects.toMatchObject({ code: "refresh_deadline" });
    const event = JSON.parse(vi.mocked(console.warn).mock.calls[0][0]);
    expect(event).toMatchObject({ event: "fireafter.refresh.operation.limit", code: "refresh_deadline", operation: "refresh", requests: 0, bytes: 0 });
    expect(Object.keys(event).sort()).toEqual(["bytes", "code", "elapsedMs", "event", "operation", "requests"]);
  } finally { gate.resolve(); }
});

it("prevents an optional-source fallback after the enclosing operation expires", async () => {
  vi.useFakeTimers();
  vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "250");
  const gate = deferred();
  let checkError: unknown;
  const work = withRefreshOperation("refresh", async () => {
    await gate.promise;
    try { assertRefreshOperationActive(); }
    catch (error) { checkError = error; throw error; }
  });
  try {
    const outcome = expect(work).rejects.toMatchObject({ code: "refresh_deadline" });
    await vi.advanceTimersByTimeAsync(250);
    await outcome;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkError).toMatchObject({ code: "refresh_deadline" });
  } finally { gate.resolve(); vi.useRealTimers(); }
});

it("unsupported streaming mutation body fails before transport", async () => {
  const fetchImpl = transport();
  await expect(withRefreshOperation("asset_import", () => fetchOperationResponse("https://test.invalid/", {
    method: "POST", body: new Uint8Array([1]),
  }, createResponseBudget(8192, 5000), fetchImpl))).rejects.toMatchObject({ code: "refresh_body" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("without a refresh scope the existing per-response contract remains", async () => {
  const fetchImpl = transport();
  expect(await (await request(fetchImpl)).text()).toBe("ok");
});

it.each(["deadline", "caller cancellation"])("queued HTTP observes its own %s before admission", async mode => {
  const gate = deferred();
  const fetchImpl = vi.fn(async () => { await gate.promise; return new Response("ok"); });
  const controller = new AbortController();
  await withRefreshOperation("refresh", async () => {
    const occupied = Array.from({ length: 4 }, () => request(fetchImpl));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    let outcome: unknown;
    const queued = fetchOperationResponse("https://test.invalid/queued", { signal: controller.signal },
      createResponseBudget(8192, mode === "deadline" ? 50 : 5000), fetchImpl).catch(error => { outcome = error; });
    if (mode === "caller cancellation") controller.abort();
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(outcome).toMatchObject({ code: mode === "deadline" ? "timeout" : "aborted" });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally { gate.resolve(); await Promise.all([...occupied, queued]); }
    expect(await (await request(fetchImpl)).text()).toBe("ok");
  });
});

it("admission remains occupied until abort-ignoring fetch promises actually settle", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const canceledBodies = vi.fn();
  const fetchImpl = vi.fn(async () => {
    await gate.promise;
    return new Response(new ReadableStream({ cancel: canceledBodies }));
  });
  const roots = Array.from({ length: 4 }, () => withRefreshOperation("refresh", () => request(fetchImpl), controller.signal));
  const outcomes = Promise.all(roots.map(root => root.catch(error => error)));
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  controller.abort(); await outcomes;
  await new Promise(resolve => setTimeout(resolve, 10));
  try {
    await expect(withRefreshOperation("create", async () => undefined)).rejects.toMatchObject({ code: "refresh_busy" });
  } finally { gate.resolve(); }
  await vi.waitFor(() => expect(canceledBodies).toHaveBeenCalledTimes(4));
  await withRefreshOperation("create", async () => undefined);
});

it("admission also waits for late-body disposal acknowledgement", async () => {
  const gate = deferred();
  const disposal = deferred();
  const controller = new AbortController();
  const cancel = vi.fn(() => disposal.promise);
  const fetchImpl = vi.fn(async () => {
    await gate.promise;
    return new Response(new ReadableStream({ cancel }));
  });
  const roots = Array.from({ length: 4 }, () => withRefreshOperation("refresh", () => request(fetchImpl), controller.signal));
  const outcomes = Promise.all(roots.map(root => root.catch(error => error)));
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  controller.abort(); await outcomes; gate.resolve();
  try {
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(4));
    await expect(withRefreshOperation("create", async () => undefined)).rejects.toMatchObject({ code: "refresh_busy" });
  } finally { disposal.resolve(); }
  await vi.waitFor(async () => { await withRefreshOperation("create", async () => undefined); });
});
