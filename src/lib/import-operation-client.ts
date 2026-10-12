import { z } from "zod";
import { IMPORT_RECOVERY_UNCONFIRMED, IMPORT_STORAGE_UNAVAILABLE, readImportReceipt, type ImportReceipt } from "./import-operation";

export type ImportRecoveryScope = { actorId: string; organizationId: string; incidentId: string };
const StoredReference = z.object({ operationId: z.uuid() }).strict();
export const IMPORT_LOCK_UNAVAILABLE = "Safe cross-tab import coordination is unavailable. No import was sent. Use a supported browser over HTTPS (or localhost), then retry.";

export async function withImportOperationLock<T>(scope: ImportRecoveryScope, work: () => Promise<T>, locks = globalThis.navigator?.locks): Promise<T> {
  let entered = false;
  try {
    if (!locks?.request) throw new Error(IMPORT_LOCK_UNAVAILABLE);
    return await locks.request(importRecoveryPrefix(scope) + "dispatch", { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) throw new Error(IMPORT_RECOVERY_UNCONFIRMED);
      entered = true;
      return await work();
    });
  } catch (error) {
    if (entered || (error instanceof Error && error.message === IMPORT_RECOVERY_UNCONFIRMED)) throw error;
    throw new Error(IMPORT_LOCK_UNAVAILABLE);
  }
}
export function importRecoveryPrefix(scope: ImportRecoveryScope) {
  if (Object.values(scope).some(value => !value || value.length > 256)) throw new Error(IMPORT_STORAGE_UNAVAILABLE);
  return `fireafter:import:v1:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(scope.incidentId)}:`;
}
export function pendingImportOperations(scope: ImportRecoveryScope, storage: Storage): string[] {
  try {
    const prefix = importRecoveryPrefix(scope);
    const result: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value = StoredReference.parse(JSON.parse(storage.getItem(key) ?? "null"));
      if (key !== prefix + value.operationId || result.length >= 20) throw new Error(IMPORT_STORAGE_UNAVAILABLE);
      result.push(value.operationId);
    }
    return result.sort();
  } catch { throw new Error(IMPORT_STORAGE_UNAVAILABLE); }
}
export function checkpointImport(scope: ImportRecoveryScope, operationId: string, storage: Storage) {
  try {
    const value = JSON.stringify(StoredReference.parse({ operationId }));
    const key = importRecoveryPrefix(scope) + operationId;
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error(IMPORT_STORAGE_UNAVAILABLE);
  } catch { throw new Error(IMPORT_STORAGE_UNAVAILABLE); }
}
export function clearImportCheckpoint(scope: ImportRecoveryScope, operationId: string, storage: Storage) {
  const key = importRecoveryPrefix(scope) + StoredReference.parse({ operationId }).operationId;
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("The import is confirmed, but its local recovery reference could not be cleared. Contact your operator before importing again.");
}
export async function checkImportOperation(scope: ImportRecoveryScope, operationId: string, fetchImpl: typeof fetch = fetch): Promise<ImportReceipt | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    StoredReference.parse({ operationId });
    const query = new URLSearchParams({ incidentId: scope.incidentId, operationId });
    const response = await fetchImpl(`/api/assets/import/status?${query}`, { cache: "no-store", signal: controller.signal });
    const value = await response.json();
    if (!response.ok || !value || value.operationId !== operationId || value.incidentId !== scope.incidentId) throw new Error(IMPORT_RECOVERY_UNCONFIRMED);
    if (value.state === "unconfirmed" && value.receipt === null) return null;
    if (value.state !== "committed") throw new Error(IMPORT_RECOVERY_UNCONFIRMED);
    return readImportReceipt(value.receipt, { operationId });
  } catch { throw new Error(IMPORT_RECOVERY_UNCONFIRMED); }
  finally { clearTimeout(timeout); }
}
