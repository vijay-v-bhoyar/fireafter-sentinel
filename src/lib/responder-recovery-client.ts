import { z } from "zod";
import { ResponderCommandSchema, responderCommandFailure, responderAuthorityHeaders, type ResponderCommand } from "./responder-command";
import type { ResponderAction } from "./types";

export type ResponderRecoveryScope = { actorId: string; organizationId: string; incidentId: string; databaseIncidentId: string };
export const COMMAND_RECOVERY_UNCONFIRMED = "An earlier decision is unconfirmed. Check its receipt or retry the original command; absence of a receipt does not prove rollback.";
export const COMMAND_STORAGE_UNAVAILABLE = "Safe decision recovery storage is unavailable. No new decision was sent. Use a supported secure browser or contact your operator.";
export const COMMAND_LOCK_UNAVAILABLE = "Safe cross-tab decision coordination is unavailable. No decision was sent. Use a supported browser over HTTPS or localhost.";
const CheckpointSchema = z.object({
  commandId: z.uuid(), expectedRevision: z.uuid(), recommendationId: z.string().min(1).max(256),
  action: z.enum(["accept", "modify", "reject", "annotate"]),
  modifiedPriority: z.enum(["Very High", "High", "Medium", "Low", "Very Low"]).optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => (value.action === "modify") === (value.modifiedPriority !== undefined));
export type ResponderCheckpoint = z.infer<typeof CheckpointSchema>;

export function responderRecoveryKey(scope: ResponderRecoveryScope) {
  if (Object.values(scope).some(value => !value || value.length > 256)) throw new Error(COMMAND_STORAGE_UNAVAILABLE);
  if (!z.uuid().safeParse(scope.databaseIncidentId).success) throw new Error(COMMAND_STORAGE_UNAVAILABLE);
  return `fireafter:decision:v1:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${scope.databaseIncidentId}`;
}
export async function responderCommandFingerprint(command: ResponderCommand) {
  const c = ResponderCommandSchema.parse(command);
  const bytes = new TextEncoder().encode(JSON.stringify(["fireafter-decision-v1", c.commandId, c.expectedRevision,
    c.recommendationId, c.action, c.note, c.modifiedPriority ?? null]));
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  } catch { throw new Error(COMMAND_STORAGE_UNAVAILABLE); }
}
export function readResponderCheckpoint(scope: ResponderRecoveryScope, storage: Storage): ResponderCheckpoint | null {
  try {
    const value = storage.getItem(responderRecoveryKey(scope));
    return value === null ? null : CheckpointSchema.parse(JSON.parse(value));
  } catch { throw new Error(COMMAND_STORAGE_UNAVAILABLE); }
}
export async function checkpointResponderCommand(scope: ResponderRecoveryScope, command: ResponderCommand, storage: Storage) {
  const parsed = ResponderCommandSchema.parse(command);
  const checkpoint = CheckpointSchema.parse({ commandId: parsed.commandId, expectedRevision: parsed.expectedRevision,
    recommendationId: parsed.recommendationId, action: parsed.action, modifiedPriority: parsed.modifiedPriority,
    fingerprint: await responderCommandFingerprint(command) });
  const previous = readResponderCheckpoint(scope, storage);
  if (previous && JSON.stringify(previous) !== JSON.stringify(checkpoint)) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
  try {
    const text = JSON.stringify(checkpoint), key = responderRecoveryKey(scope);
    storage.setItem(key, text);
    if (storage.getItem(key) !== text) throw new Error(COMMAND_STORAGE_UNAVAILABLE);
  } catch { throw new Error(COMMAND_STORAGE_UNAVAILABLE); }
  return checkpoint;
}
export function clearResponderCheckpoint(scope: ResponderRecoveryScope, expected: ResponderCheckpoint, storage: Storage) {
  const actual = readResponderCheckpoint(scope, storage);
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
  const key = responderRecoveryKey(scope);
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("Decision confirmed, but its recovery reference could not be cleared. Check its receipt again; do not submit a replacement.");
}
export async function restoreResponderCommand(checkpoint: ResponderCheckpoint, note: string): Promise<ResponderCommand> {
  const reference = CheckpointSchema.parse(checkpoint);
  const command = ResponderCommandSchema.parse({ ...reference, note });
  if (await responderCommandFingerprint(command) !== reference.fingerprint) throw new Error("The note does not match the original decision. Restore the exact original note, or ask your operator to reconcile this command. No retry was sent.");
  return command;
}
export async function withResponderCommandLock<T>(scope: ResponderRecoveryScope, work: () => Promise<T>, locks = globalThis.navigator?.locks): Promise<T> {
  let entered = false;
  try {
    if (!locks?.request) throw new Error(COMMAND_LOCK_UNAVAILABLE);
    return await locks.request(responderRecoveryKey(scope), { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
      entered = true;
      return work();
    });
  } catch (error) {
    if (entered || (error instanceof Error && error.message === COMMAND_RECOVERY_UNCONFIRMED)) throw error;
    throw new Error(COMMAND_LOCK_UNAVAILABLE);
  }
}
export async function checkResponderCommand(scope: ResponderRecoveryScope, checkpoint: ResponderCheckpoint, fetchImpl: typeof fetch = fetch): Promise<ResponderAction | null> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const query = new URLSearchParams({ incidentId: scope.incidentId, commandId: checkpoint.commandId });
    const response = await fetchImpl(`/api/actions/status?${query}`, { cache: "no-store", headers: responderAuthorityHeaders(scope), signal: controller.signal });
    let value;
    try { value = await response.json(); } catch { throw responderCommandFailure(undefined, response.status); }
    if (!response.ok) throw responderCommandFailure(value, response.status);
    if (value?.commandId !== checkpoint.commandId || value?.incidentId !== scope.incidentId ||
      value.databaseIncidentId !== scope.databaseIncidentId ||
      !z.string().min(1).max(256).safeParse(value.canonicalIncidentId).success) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
    if (value.state === "unconfirmed" && value.receipt === null) return null;
    const action = value.receipt as ResponderAction;
    if (value.state !== "committed" || !action?.id || !action.auditEvent?.id ||
      action.auditEvent.incidentId !== value.canonicalIncidentId || action.recommendationSnapshot?.incidentId !== value.canonicalIncidentId ||
      action.auditEvent.payload?.commandId !== checkpoint.commandId ||
      action.auditEvent.payload.expectedRevision !== checkpoint.expectedRevision || action.recommendationId !== checkpoint.recommendationId ||
      action.action !== checkpoint.action || (action.modifiedPriority ?? undefined) !== checkpoint.modifiedPriority) throw new Error(COMMAND_RECOVERY_UNCONFIRMED);
    await restoreResponderCommand(checkpoint, action.note);
    return action;
  } finally { clearTimeout(timer); }
}
