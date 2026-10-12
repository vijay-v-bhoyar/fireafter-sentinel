import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanDraft, previewPlanDraft, readPlanDraft } from "./plans";
import { ConstraintConfigurationSchema, proposeTaskAssignments } from "./planning";

const fixture = vi.hoisted(() => ({ user: null as unknown, rpc: vi.fn() }));
vi.mock("../auth", () => ({ getCurrentUser: async () => fixture.user }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => ({ rpc: fixture.rpc }) }));
const id = (n: number) => `b1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const user = { id: id(3), organizationId: scope.organizationId, role: "analyst" };
const createdAt = "2026-10-11T08:00:00.000Z";
const configuration = ConstraintConfigurationSchema.parse({ schemaVersion: 1, inputBasis: "demo",
  shift: { startsAt: createdAt, endsAt: "2026-10-11T16:00:00.000Z" },
  crews: [{ id: id(10), label: "Demo crew", capabilities: ["road"], availableFrom: createdAt, availableUntil: "2026-10-11T16:00:00.000Z" }],
  tasks: [{ id: id(20), assetId: id(21), label: "Demo task", taskType: "inspection", requiredCapability: "road", durationMinutes: 60, travelMinutes: 0,
    windowFrom: createdAt, windowUntil: "2026-10-11T16:00:00.000Z", priority: 1 }] });
const input = { incidentId: scope.incidentId, mode: scope.mode, taskDependencies: [{ taskId: id(20), claimIds: [id(22)] }] };
const command = { ...input, commandId: id(30), expectedCurrentPlanRevision: null, expectedConstraintRevision: id(31),
  expectedEvidenceGeneration: 4, expectedEvidenceVectorHash: "a".repeat(64) };
function context() { return { scope, constraintRevision: { id: id(31), scope, configuration, constraintHash: "b".repeat(64), createdBy: user.id, createdAt },
  evidenceGeneration: 4, unresolvedSourceChanges: 0, evidenceVectorHash: command.expectedEvidenceVectorHash,
  evidenceSnapshot: { constraintRevisionId: id(31), constraintHash: "b".repeat(64), taskDependencies: input.taskDependencies },
  currentPlanRevision: null, blockers: ["policy_not_qualified", "native_evidence_not_qualified"] }; }
function result() { return { replayed: false, revision: { id: id(40), planId: id(41), scope, parentRevisionId: null, constraintRevisionId: id(31),
  evidenceGeneration: 4, evidenceVectorHash: command.expectedEvidenceVectorHash, policyRevisionId: null, state: "draft", approvalReady: false,
  createdBy: user.id, createdAt, allocation: proposeTaskAssignments(configuration), taskDependencies: input.taskDependencies, blockers: context().blockers },
  receipt: { scope, commandId: command.commandId, actorId: user.id, planId: id(41), revisionId: id(40), parentRevisionId: null, constraintRevisionId: id(31),
    evidenceGeneration: 4, evidenceVectorHash: command.expectedEvidenceVectorHash, committedAt: createdAt, state: "draft" } }; }
function page() { return { scope, revision: result().revision, isCurrentRevision: true, snapshotMatchesCurrent: true,
  validity: "needs_review", approvalReady: false, observedAt: createdAt }; }
beforeEach(() => { fixture.user = user; fixture.rpc.mockReset(); });
function replies(value: unknown = result()) {
  fixture.rpc.mockImplementation(async (name: string) => ({ error: null,
    data: name === "sentinel_find_plan_command" ? null : name === "sentinel_read_plan_context" ? context() : value }));
}
describe("Proposal helper validates untrusted storage responses and draft authority", () => {
  it("accepts equal allocation content across record-key ordering", async () => {
    const value = result(), a = value.revision.allocation;
    if (a.status !== "feasible") throw new Error("Expected a complete authored fixture allocation");
    // Result validation rebuilds keys in another order; equality must compare content.
    const reversed = { assignments: a.assignments, selectedTaskIds: a.selectedTaskIds, issues: a.issues, status: a.status };
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(a)); value.revision.allocation = reversed;
    replies(value); const saved = await createPlanDraft(command);
    expect(saved.revision.allocation).toEqual(a); expect(saved.revision.approvalReady).toBe(false);
  });
  it("rejects a different otherwise feasible assignment in the stored receipt", async () => {
    const value = result(); value.revision.allocation.assignments[0].startsAt = "2026-10-11T09:00:00.000Z";
    replies(value); await expect(createPlanDraft(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  for (const field of ["actorId", "revisionId", "planId", "constraintRevisionId", "evidenceVectorHash", "committedAt"] as const) {
    it(`rejects a misbound ${field} receipt`, async () => {
      const value = result(); value.receipt[field] = field === "evidenceVectorHash" ? "c".repeat(64) : field === "committedAt" ? "2026-10-11T09:00:00.000Z" : id(99);
      replies(value); await expect(createPlanDraft(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    });
  }
  for (const change of ["approval", "policy", "scope", "dependencies", "extraField"] as const) {
    it(`rejects storage-injected ${change}`, async () => {
      const value = result();
      if (change === "approval") value.revision.approvalReady = true;
      if (change === "policy") Object.assign(value.revision, { policyRevisionId: id(99) });
      if (change === "scope") value.revision.scope = { ...scope, incidentId: id(99) };
      if (change === "dependencies") value.revision.taskDependencies = [{ taskId: id(20), claimIds: [] }];
      if (change === "extraField") Object.assign(value.revision, { decisionId: id(99) });
      replies(value); await expect(createPlanDraft(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    });
  }
  for (const field of ["currentPlanRevision", "evidenceGeneration", "evidenceVectorHash"] as const) {
    it(`rejects stale current ${field} before creation`, async () => {
      const ctx = context();
      Object.assign(ctx, { [field]: field === "currentPlanRevision" ? id(99) : field === "evidenceGeneration" ? 5 : "c".repeat(64) });
      fixture.rpc.mockImplementation(async (name: string) => ({ data: name === "sentinel_find_plan_command" ? null : ctx, error: null }));
      await expect(createPlanDraft(command)).rejects.toMatchObject({ code: "PLAN_CONFLICT" });
      expect(fixture.rpc.mock.calls.map(v => v[0])).not.toContain("sentinel_create_plan_draft");
    });
  }
  it("returns authorized historical replay without deriving from new context", async () => {
    const value = result(); value.replayed = true; fixture.rpc.mockResolvedValue({ data: value, error: null });
    expect((await createPlanDraft(command)).replayed).toBe(true);
    expect(fixture.rpc).toHaveBeenCalledTimes(1); expect(fixture.rpc.mock.calls[0][0]).toBe("sentinel_find_plan_command");
  });
  it("checks current role before a cached receipt can be read", async () => {
    replies(); fixture.user = { ...user, role: "viewer" };
    await expect(createPlanDraft(command)).rejects.toMatchObject({ code: "SCOPE_DENIED" }); expect(fixture.rpc).not.toHaveBeenCalled();
  });
  it("rejects an oversized context before publishing its contents", async () => {
    const ctx = context(); Object.assign(ctx.evidenceSnapshot, { unsupported: "x".repeat(1_048_576) });
    fixture.rpc.mockResolvedValue({ data: ctx, error: null });
    await expect(previewPlanDraft(input)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("rejects context whose snapshot no longer binds its constraints", async () => {
    const ctx = context(); ctx.evidenceSnapshot.constraintHash = "c".repeat(64);
    fixture.rpc.mockResolvedValue({ data: ctx, error: null });
    await expect(previewPlanDraft(input)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("rejects a mismatched historical revision returned by storage", async () => {
    fixture.rpc.mockResolvedValue({ data: page(), error: null });
    await expect(readPlanDraft(scope.incidentId, scope.mode, id(99))).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  for (const bad of [{ ...command, actorId: id(99) }, { ...command, allocation: {} },
    { ...command, taskDependencies: [input.taskDependencies[0], input.taskDependencies[0]] },
    { ...command, taskDependencies: [{ taskId: id(20), claimIds: [id(22), id(22)] }] }]) {
    it("rejects injected authority or duplicate dependencies before storage", async () => {
      await expect(createPlanDraft(bad)).rejects.toMatchObject({ code: "INPUT_INVALID" }); expect(fixture.rpc).not.toHaveBeenCalled();
    });
  }
});
