import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestStorage, createTestLocks } from "../test/browser-storage";
import { checkResponderCommand, checkpointResponderCommand, clearResponderCheckpoint, readResponderCheckpoint,
  responderRecoveryKey, restoreResponderCommand, withResponderCommandLock } from "./responder-recovery-client";
import { sendResponderCommand } from "./responder-command-client";
const scope = { actorId: "actor-a", organizationId: "org-a", incidentId: "domain-a", databaseIncidentId: "10000000-0000-4000-8000-000000000001" };
const command = { commandId: "20000000-0000-4000-8000-000000000002", expectedRevision: "30000000-0000-4000-8000-000000000003", recommendationId: "rec-a", action: "annotate" as const, note: "Private field note" };
const storage = createTestStorage();
beforeEach(() => storage.clear());
describe("FA10 durable responder client", () => {
  it.each([scope.incidentId, scope.databaseIncidentId])("recovers canonical receipts through incident alias %s", async incidentId => {
    const saved = await checkpointResponderCommand(scope, command, storage);
    const receipt = { ...command, id: "action-a", recommendationSnapshot: { incidentId: scope.incidentId },
      auditEvent: { id: "audit-a", incidentId: scope.incidentId, payload: command } };
    const get = vi.fn().mockResolvedValue(Response.json({ incidentId, commandId: command.commandId,
      canonicalIncidentId: scope.incidentId, databaseIncidentId: scope.databaseIncidentId, state: "committed", receipt }));
    expect(await checkResponderCommand({ ...scope, incidentId }, saved, get)).toEqual(receipt);
  });
  it.each(["databaseIncidentId", "canonicalIncidentId"])("rejects inconsistent status scope %s", async field => {
    const saved = await checkpointResponderCommand(scope, command, storage);
    const receipt = { ...command, id: "action-a", recommendationSnapshot: { incidentId: scope.incidentId },
      auditEvent: { id: "audit-a", incidentId: scope.incidentId, payload: command } };
    const value = { incidentId: scope.incidentId, commandId: command.commandId, canonicalIncidentId: scope.incidentId,
      databaseIncidentId: scope.databaseIncidentId, state: "committed", receipt, [field]: command.commandId };
    await expect(checkResponderCommand(scope, saved, vi.fn().mockResolvedValue(Response.json(value)))).rejects.toThrow();
    expect(readResponderCheckpoint(scope, storage)).toEqual(saved);
  });
  it("retains exact metadata but not notes; canonical aliases share one checkpoint", async () => {
    const saved = await checkpointResponderCommand(scope, command, storage);
    expect(readResponderCheckpoint({ ...scope, incidentId: "alias-a" }, storage)).toEqual(saved);
    expect(storage.getItem(responderRecoveryKey(scope))).not.toContain(command.note);
    expect(saved).not.toHaveProperty("note");
    expect(await restoreResponderCommand(saved, command.note)).toEqual(command);
  });
  it.each(["", " leading space ", "line\nline", "Unicode: \u00e9\ud83d\ude92"])("binds the exact note representation %j", async note => {
    const saved = await checkpointResponderCommand(scope, { ...command, note }, storage);
    expect((await restoreResponderCommand(saved, note)).note).toBe(note);
    await expect(restoreResponderCommand(saved, note + " ")).rejects.toThrow("does not match");
  });
  it.each(["actorId", "organizationId", "databaseIncidentId"] as const)("isolates %s", async field => {
    await checkpointResponderCommand(scope, command, storage);
    const other = { ...scope, [field]: field === "databaseIncidentId" ? command.commandId : "other" };
    expect(readResponderCheckpoint(other, storage)).toBeNull();
  });
  it("rejects new identities, revisions or content while the old checkpoint is unresolved", async () => {
    await checkpointResponderCommand(scope, command, storage);
    for (const change of [{ commandId: scope.databaseIncidentId }, { expectedRevision: scope.databaseIncidentId }, { note: "changed" }, { recommendationId: "other" }]) {
      await expect(checkpointResponderCommand(scope, { ...command, ...change }, storage)).rejects.toThrow("unconfirmed");
    }
  });
  it("fails closed on malformed, extra-field and inaccessible storage", async () => {
    for (const value of ["broken JSON", JSON.stringify({ ...(await checkpointResponderCommand(scope, command, storage)), note: "private" })]) {
      storage.setItem(responderRecoveryKey(scope), value);
      expect(() => readResponderCheckpoint(scope, storage)).toThrow("storage is unavailable");
    }
    const denied = { getItem() { throw new Error("private diagnostic"); } } as unknown as Storage;
    expect(() => readResponderCheckpoint(scope, denied)).toThrow("storage is unavailable");
  });
  it("cannot clear a different command or pretend a failed delete succeeded", async () => {
    const saved = await checkpointResponderCommand(scope, command, storage);
    expect(() => clearResponderCheckpoint(scope, { ...saved, commandId: scope.databaseIncidentId }, storage)).toThrow();
    const blocked = { getItem: storage.getItem.bind(storage), removeItem() {} } as unknown as Storage;
    expect(() => clearResponderCheckpoint(scope, saved, blocked)).toThrow("could not be cleared");
    clearResponderCheckpoint(scope, saved, storage);
    expect(storage.length).toBe(0);
  });
  it("serializes aliases before checkpoint creation and rejects unavailable locks", async () => {
    const locks = createTestLocks(); let release!: () => void;
    const held = withResponderCommandLock(scope, () => new Promise<void>(resolve => { release = resolve; }), locks);
    await expect(withResponderCommandLock({ ...scope, incidentId: "alias" }, async () => { throw new Error("must not dispatch"); }, locks)).rejects.toThrow("unconfirmed");
    release(); await held;
    await expect(withResponderCommandLock(scope, async () => {}, {} as LockManager)).rejects.toThrow("coordination is unavailable");
  });
  it("binds both GET and POST to expected actor/organization without treating headers as credentials", async () => {
    const saved = await checkpointResponderCommand(scope, command, storage);
    const get = vi.fn().mockResolvedValue(Response.json({ commandId: command.commandId, incidentId: scope.incidentId, canonicalIncidentId: scope.incidentId, databaseIncidentId: scope.databaseIncidentId, state: "unconfirmed", receipt: null }));
    expect(await checkResponderCommand(scope, saved, get)).toBeNull();
    const post = vi.fn().mockResolvedValue(Response.json({ code: "FA401" }, { status: 403 }));
    await expect(sendResponderCommand(command, post, scope)).rejects.toMatchObject({ code: "FA401" });
    for (const fn of [get, post]) expect(fn.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { "x-fireafter-actor": scope.actorId, "x-fireafter-organization": scope.organizationId } });
    expect(readResponderCheckpoint(scope, storage)).toEqual(saved);
  });
  it.each([null, {}, { state: "unconfirmed" }, { state: "committed", receipt: {} }])("rejects malformed status response %j without losing the reference", async value => {
    const saved = await checkpointResponderCommand(scope, command, storage);
    await expect(checkResponderCommand(scope, saved, vi.fn().mockResolvedValue(Response.json(value)))).rejects.toThrow();
    expect(readResponderCheckpoint(scope, storage)).toEqual(saved);
  });
});
