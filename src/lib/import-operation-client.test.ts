// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestStorage, createTestLocks } from "../test/browser-storage";
const localStorage = createTestStorage();
import { checkpointImport, clearImportCheckpoint, pendingImportOperations, checkImportOperation, withImportOperationLock } from "./import-operation-client";
const scope = { actorId: "operator-a", organizationId: "org-a", incidentId: "incident-a" };
const operationId = "10000000-0000-4000-8000-000000000001";
const receipt = { operationId, incidentId: "20000000-0000-4000-8000-000000000002", requestHash: "a".repeat(64), auditEventId: "30000000-0000-4000-8000-000000000003", revision: "40000000-0000-4000-8000-000000000004", assetCount: 2, committedAt: "2026-09-14T09:00:00Z" };
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
describe("FA10-R4 durable browser import references", () => {
  it("holds the exclusive scope lock through dispatch, rejects contention and releases after failure", async () => {
    const locks = createTestLocks();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withImportOperationLock(scope, async () => { await gate; throw new Error("lost response"); }, locks);
    const second = vi.fn(async () => {});
    await expect(withImportOperationLock(scope, second, locks)).rejects.toThrow("outcome is unconfirmed");
    expect(second).not.toHaveBeenCalled();
    await expect(withImportOperationLock({ ...scope, actorId: "different" }, async () => "independent", locks)).resolves.toBe("independent");
    release();
    await expect(first).rejects.toThrow("lost response");
    await expect(withImportOperationLock(scope, async () => "released", locks)).resolves.toBe("released");
  });
  it("does not dispatch without lock support or when the browser refuses coordination", async () => {
    const work = vi.fn(async () => {});
    for (const locks of [{}, { request() { throw new Error("SecurityError"); } }]) {
      await expect(withImportOperationLock(scope, work, locks as unknown as LockManager)).rejects.toThrow("No import was sent");
    }
    expect(work).not.toHaveBeenCalled();
  });
  it("stores only the scoped operation ID and can read it after module/session state is discarded", () => {
    checkpointImport(scope, operationId, localStorage);
    expect(pendingImportOperations({ ...scope }, localStorage)).toEqual([operationId]);
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toEqual({ operationId });
    for (const field of ["actorId", "organizationId", "incidentId"]) expect(pendingImportOperations({ ...scope, [field]: "other" }, localStorage)).toEqual([]);
    clearImportCheckpoint(scope, operationId, localStorage);
    expect(pendingImportOperations(scope, localStorage)).toEqual([]);
  });
  it("fails closed for denied or silently dropped storage", () => {
    const denied = { setItem() { throw new Error("quota"); } } as unknown as Storage;
    const dropped = { setItem() {}, getItem() { return null; } } as unknown as Storage;
    for (const storage of [denied, dropped]) expect(() => checkpointImport(scope, operationId, storage)).toThrow("No import was sent");
  });
  it("does not delete another actor's checkpoint", () => {
    checkpointImport(scope, operationId, localStorage);
    clearImportCheckpoint({ ...scope, actorId: "other" }, operationId, localStorage);
    expect(pendingImportOperations(scope, localStorage)).toEqual([operationId]);
  });
  it("rejects corrupt checkpoints rather than forgetting uncertain writes", () => {
    checkpointImport(scope, operationId, localStorage);
    localStorage.setItem(localStorage.key(0)!, '{"operationId":"invalid"}');
    expect(() => pendingImportOperations(scope, localStorage)).toThrow();
    expect(localStorage.length).toBe(1);
  });
  it("looks up a receipt with a read only no-store request", async () => {
    const fetch = vi.fn(async () => Response.json({ state: "committed", operationId, incidentId: scope.incidentId, receipt }));
    expect(await checkImportOperation(scope, operationId, fetch)).toEqual(receipt);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/assets/import/status?"), expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });
  it("does not turn a missing receipt into rollback or a new write", async () => {
    const fetch = vi.fn(async () => Response.json({ state: "unconfirmed", operationId, incidentId: scope.incidentId, receipt: null }));
    expect(await checkImportOperation(scope, operationId, fetch)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 503])("retains uncertainty when lookup fails (%s)", async status => {
    await expect(checkImportOperation(scope, operationId, async () => Response.json({ error: "PRIVATE" }, { status }))).rejects.toThrow("outcome is unconfirmed");
  });
  it("rejects a receipt or envelope for a different operation", async () => {
    await expect(checkImportOperation(scope, operationId, async () => Response.json({ state: "committed", operationId, incidentId: "other", receipt }))).rejects.toThrow();
    await expect(checkImportOperation(scope, operationId, async () => Response.json({ state: "committed", operationId, incidentId: scope.incidentId, receipt: { ...receipt, operationId: receipt.incidentId } }))).rejects.toThrow();
  });
});
