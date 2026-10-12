// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLocks, createTestStorage } from "../test/browser-storage";
import { checkpointResponderCommand, readResponderCheckpoint } from "@/lib/responder-recovery-client";
import { useResponderCommands } from "./use-responder-commands";
const scope = { actorId: "actor", organizationId: "org", incidentId: "incident-a", databaseIncidentId: "10000000-0000-4000-8000-000000000001" };
const command = { commandId: "20000000-0000-4000-8000-000000000002", expectedRevision: "30000000-0000-4000-8000-000000000003", recommendationId: "rec-a", action: "annotate" as const, note: "Private original note" };
const action = { ...command, id: "action-test", recommendationSnapshot: { incidentId: scope.incidentId }, auditEvent: { id: "audit-test", incidentId: scope.incidentId, payload: command } };
const storage = createTestStorage();
const onReceipt = vi.fn();
beforeEach(() => { storage.clear(); onReceipt.mockReset(); vi.stubGlobal("localStorage", storage); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("navigator", { locks: createTestLocks() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("FA10 recovery lifecycle", () => {
  it("keeps unresolved guidance through hydration and unrelated storage events", async () => {
    vi.stubGlobal("navigator", {});
    const post = vi.fn(); vi.stubGlobal("fetch", post);
    const hook = renderHook(() => useResponderCommands(scope, true, onReceipt));
    await act(() => hook.result.current.submit(command));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(hook.result.current.error).toMatch(/coordination is unavailable/);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "unrelated-preference", newValue: "changed" })));
    expect(hook.result.current.error).toMatch(/coordination is unavailable/);
    expect(post).not.toHaveBeenCalled();
  });
  it("recovers a committed decision after remount without another POST or current queue", async () => {
    const post = vi.fn().mockRejectedValue(new Error("Response lost"));
    vi.stubGlobal("fetch", post);
    const first = renderHook(() => useResponderCommands(scope, true, onReceipt));
    await act(() => first.result.current.submit(command));
    expect(readResponderCheckpoint(scope, storage)?.commandId).toBe(command.commandId);
    first.unmount();
    const get = vi.fn().mockResolvedValue(Response.json({ incidentId: scope.incidentId, canonicalIncidentId: scope.incidentId, databaseIncidentId: scope.databaseIncidentId, commandId: command.commandId, state: "committed", receipt: action }));
    vi.stubGlobal("fetch", get);
    const second = renderHook(() => useResponderCommands(scope, true, onReceipt));
    await waitFor(() => expect(second.result.current.pending).not.toBeNull());
    await act(() => second.result.current.checkStatus());
    expect(onReceipt).toHaveBeenCalledExactlyOnceWith(action); expect(storage.length).toBe(0);
    expect(post).toHaveBeenCalledTimes(1); expect(get.mock.calls[0][0]).toMatch(/^\/api\/actions\/status\?/);
  });
  it("requires the original private note after restart and retries identical content", async () => {
    await checkpointResponderCommand(scope, command, storage);
    const post = vi.fn().mockResolvedValue(Response.json(action)); vi.stubGlobal("fetch", post);
    const hook = renderHook(() => useResponderCommands(scope, true, onReceipt));
    await waitFor(() => expect(hook.result.current.pending).not.toBeNull());
    await act(() => hook.result.current.retry()); expect(post).not.toHaveBeenCalled();
    expect(hook.result.current.error).toMatch(/does not match/);
    act(() => hook.result.current.setNote(command.note));
    await act(() => hook.result.current.retry());
    expect(JSON.parse(post.mock.calls[0][1].body)).toEqual(command); expect(storage.length).toBe(0);
  });
  it("does not apply a late decision to another incident", async () => {
    let finish!: (value: Response) => void;
    const post = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal("fetch", post);
    const hook = renderHook(({ selected }) => useResponderCommands(selected, true, onReceipt), { initialProps: { selected: scope } });
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.submit(command); });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    hook.rerender({ selected: { ...scope, incidentId: "incident-b", databaseIncidentId: command.commandId } });
    await act(async () => { finish(Response.json(action)); await pending; });
    expect(onReceipt).not.toHaveBeenCalled(); expect(hook.result.current.pending).toBeNull();
  });
  it("discards late status results after authority changes", async () => {
    await checkpointResponderCommand(scope, command, storage);
    let finish!: (value: Response) => void;
    const get = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal("fetch", get);
    const hook = renderHook(({ selected }) => useResponderCommands(selected, true, onReceipt), { initialProps: { selected: scope } });
    let pending!: Promise<void>; act(() => { pending = hook.result.current.checkStatus(); });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    hook.rerender({ selected: { ...scope, actorId: "other" } });
    await act(async () => { finish(Response.json({ incidentId: scope.incidentId, canonicalIncidentId: scope.incidentId, databaseIncidentId: scope.databaseIncidentId, commandId: command.commandId, state: "committed", receipt: action })); await pending; });
    expect(onReceipt).not.toHaveBeenCalled(); expect(hook.result.current.pending).toBeNull();
  });
  it("blocks a competing alias and never dispatches if storage or locks fail", async () => {
    await checkpointResponderCommand(scope, command, storage);
    const post = vi.fn(); vi.stubGlobal("fetch", post);
    const hook = renderHook(() => useResponderCommands({ ...scope, incidentId: "alias-a" }, true, onReceipt));
    await act(() => hook.result.current.submit({ ...command, commandId: scope.databaseIncidentId }));
    expect(post).not.toHaveBeenCalled(); expect(hook.result.current.pending?.commandId).toBe(command.commandId);
    storage.clear(); vi.stubGlobal("navigator", {});
    await act(() => hook.result.current.submit(command)); expect(post).not.toHaveBeenCalled();
    expect(hook.result.current.error).toMatch(/coordination is unavailable/);
    vi.stubGlobal("navigator", { locks: createTestLocks() }); vi.stubGlobal("localStorage", { getItem() { throw new Error("Denied"); } });
    await act(() => hook.result.current.submit(command)); expect(post).not.toHaveBeenCalled();
    expect(hook.result.current.error).toMatch(/storage is unavailable/);
  });
});
