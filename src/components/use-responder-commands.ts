"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ResponderCommandError, type ResponderCommand } from "@/lib/responder-command";
import { sendResponderCommand } from "@/lib/responder-command-client";
import { checkResponderCommand, checkpointResponderCommand, clearResponderCheckpoint, readResponderCheckpoint,
  responderRecoveryKey, restoreResponderCommand, withResponderCommandLock, COMMAND_RECOVERY_UNCONFIRMED,
  type ResponderCheckpoint, type ResponderRecoveryScope } from "@/lib/responder-recovery-client";
import type { ResponderAction } from "@/lib/types";

export function useResponderCommands(scope: ResponderRecoveryScope, enabled: boolean, onReceipt: (action: ResponderAction) => void) {
  const { actorId, organizationId, incidentId, databaseIncidentId } = scope;
  let key = "";
  try { if (enabled) key = responderRecoveryKey(scope); } catch { /* Invalid persisted scope cannot dispatch. */ }
  const viewKey = JSON.stringify([key, incidentId]);
  const activeKey = useRef("");
  const inFlight = useRef(false);
  const memory = useRef<{ key: string; command: ResponderCommand } | null>(null);
  const [state, setState] = useState<{ key: string; pending: ResponderCheckpoint | null; error: string | null }>({ key: "", pending: null, error: null });
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState("");
  useLayoutEffect(() => {
    activeKey.current = viewKey;
    return () => { activeKey.current = ""; };
  }, [viewKey]);
  useEffect(() => {
    const read = () => {
      if (activeKey.current !== viewKey) return;
      try {
        const pending = key ? readResponderCheckpoint({ actorId, organizationId, incidentId, databaseIncidentId }, window.localStorage) : null;
        setState(previous => ({ key, pending, error: previous.key === key ? previous.error : null }));
      }
      catch (error) { setState({ key, pending: null, error: error instanceof Error ? error.message : COMMAND_RECOVERY_UNCONFIRMED }); }
    };
    const storageChanged = (event: StorageEvent) => { if (event.key === null || event.key === key) read(); };
    const timer = setTimeout(() => { read(); setNote(""); }, 0);
    window.addEventListener("storage", storageChanged);
    return () => { clearTimeout(timer); window.removeEventListener("storage", storageChanged); };
  }, [key, viewKey, actorId, organizationId, incidentId, databaseIncidentId]);
  const pending = state.key === key ? state.pending : null;
  const error = state.key === key ? state.error : null;
  const current = () => Boolean(key && activeKey.current === viewKey);
  function update(pending: ResponderCheckpoint | null, error: string | null = null) {
    if (current()) setState({ key, pending, error });
  }
  async function run(work: () => Promise<void>) {
    if (!enabled || inFlight.current) return;
    if (!current()) { setState({ key, pending: null, error: "Reload this incident from persisted storage before recording a decision; its canonical recovery scope is unavailable." }); return; }
    inFlight.current = true; setWorking(true);
    try { await withResponderCommandLock(scope, work); }
    catch (error) {
      let saved: ResponderCheckpoint | null = null;
      try { saved = readResponderCheckpoint(scope, window.localStorage); } catch { /* Preserve the actionable storage error. */ }
      update(saved, error instanceof Error ? error.message : COMMAND_RECOVERY_UNCONFIRMED);
    } finally { inFlight.current = false; setWorking(false); }
  }
  async function dispatch(command: ResponderCommand, retry: boolean) {
    const previous = readResponderCheckpoint(scope, window.localStorage);
    if ((!retry && previous) || (retry && previous?.commandId !== command.commandId)) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
    const saved = await checkpointResponderCommand(scope, command, window.localStorage);
    if (!current()) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
    memory.current = { key, command };
    update(saved);
    try {
      const result = await sendResponderCommand(command, fetch, scope);
      clearResponderCheckpoint(scope, saved, window.localStorage);
      if (current()) { onReceipt(result); update(null); setNote(""); }
      memory.current = null;
    } catch (error) {
      const rejected = error instanceof ResponderCommandError && ["AUTH_REQUIRED", "NOT_FOUND", "FA401", "FA409", "FA422"].includes(error.code);
      if (rejected && !retry) { clearResponderCheckpoint(scope, saved, window.localStorage); memory.current = null; }
      if (rejected && retry) throw new Error("An earlier attempt may already have been recorded. The retry was rejected; check decision status or ask your operator to reconcile the original command. Do not submit a replacement.");
      throw error;
    }
  }
  async function submit(command: ResponderCommand) { await run(() => dispatch(command, false)); }
  async function retry() {
    await run(async () => {
      const saved = readResponderCheckpoint(scope, window.localStorage);
      if (!saved) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
      const cached = memory.current?.key === key && memory.current.command.commandId === saved.commandId ? memory.current.command : null;
      const command = await restoreResponderCommand(saved, note || cached?.note || "");
      await dispatch(command, true);
    });
  }
  async function checkStatus() {
    await run(async () => {
      const saved = readResponderCheckpoint(scope, window.localStorage);
      if (!saved) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
      const receipt = await checkResponderCommand(scope, saved);
      if (!receipt) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
      clearResponderCheckpoint(scope, saved, window.localStorage);
      if (current()) { onReceipt(receipt); update(null); setNote(""); }
      memory.current = null;
    });
  }
  return { pending, error, working, note, setNote, submit, retry, checkStatus };
}
