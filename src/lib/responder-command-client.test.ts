import { afterEach, describe, expect, it, vi } from "vitest";
import { sendResponderCommand } from "./responder-command-client";
import { type ResponderCommand } from "./responder-command";

const command: ResponderCommand = { commandId: "d5554057-33bc-4e55-8d4a-2a4421eab174",
  expectedRevision: "0ca1f8d8-a8bb-440a-a4bf-ddbbf31a0069", recommendationId: "rec-test",
  action: "accept", note: "Test-only decision" };
const result = { ...command, id: "persisted", auditEvent: { id: "paired-audit",
  payload: { commandId: command.commandId, expectedRevision: command.expectedRevision } } };
afterEach(() => vi.useRealTimers());
describe("FA10 command transport", () => {
  it("retries the identical payload after an uncertain outcome", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("private transport"))
      .mockResolvedValueOnce(Response.json(result));
    await expect(sendResponderCommand(command, request)).rejects.toMatchObject({ code: "unavailable" });
    await expect(sendResponderCommand(command, request)).resolves.toMatchObject(result);
    expect(request.mock.calls[0][1].body).toBe(request.mock.calls[1][1].body);
  });
  it.each(["FA401", "FA409", "FA408", "FA422"])("preserves the safe %s contract", async (code) => {
    const request = vi.fn().mockResolvedValue(Response.json({ code, error: "private detail" }, { status: 409 }));
    await expect(sendResponderCommand(command, request)).rejects.toMatchObject({ code });
  });
  it("rejects an unrelated command receipt even with HTTP 200", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ ...result,
      auditEvent: { payload: { commandId: "other", expectedRevision: command.expectedRevision } } }));
    await expect(sendResponderCommand(command, request)).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each([[401, "AUTH_REQUIRED"], [403, "FA401"], [404, "NOT_FOUND"], [400, "FA422"], [413, "FA422"]] as const)(
    "classifies a code-less HTTP %s rejection without exposing provider text", async (status, code) => {
      const request = vi.fn().mockResolvedValue(Response.json({ error: "private provider detail" }, { status }));
      await expect(sendResponderCommand(command, request)).rejects.toMatchObject({ code });
      await expect(sendResponderCommand(command, request)).rejects.not.toThrow("private provider detail");
    },
  );
  it("preserves a gateway authentication denial with a non-JSON body", async () => {
    const request = vi.fn().mockResolvedValue(new Response("private gateway detail", { status: 401 }));
    await expect(sendResponderCommand(command, request)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
  it.each([429, 500, 502, 503])("retains uncertainty for HTTP %s without an accepted code", async (status) => {
    const request = vi.fn().mockResolvedValue(Response.json({ error: "private failure" }, { status }));
    await expect(sendResponderCommand(command, request)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("keeps the deadline active through body consumption", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_url: unknown, init: RequestInit) => ({
      ok: true, json: () => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    })) as unknown as typeof fetch;
    const promise = expect(sendResponderCommand(command, request)).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(15_000);
    await promise;
  });
});
