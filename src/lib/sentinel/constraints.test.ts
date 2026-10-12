import { beforeEach, describe, expect, it, vi } from "vitest";
import { readConstraints, recordConstraints } from "./constraints";
const boundary = vi.hoisted(() => ({ admin: vi.fn(), rpc: vi.fn(), user: vi.fn() }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => boundary.admin() }));
vi.mock("../auth", () => ({ getCurrentUser: () => boundary.user() }));
const id = (n: number) => `99000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const }, actor = id(9);
const time = "2026-10-11T08:00:00.000Z", end = "2026-10-11T16:00:00.000Z";
const config = { schemaVersion: 1, shift: { startsAt: time, endsAt: end }, crews: [{ id: id(3), label: "Demo crew", capabilities: ["road"], availableFrom: time, availableUntil: end }],
  tasks: [{ id: id(4), assetId: id(5), label: "Demo task", taskType: "inspection", requiredCapability: "road", durationMinutes: 60, travelMinutes: 15, windowFrom: time, windowUntil: end, priority: 1 }], inputBasis: "demo" };
const c = { incidentId: scope.incidentId, mode: scope.mode, commandId: id(6), expectedConstraintRevision: null, configuration: config };
const revision = { id: id(7), scope, configuration: config, constraintHash: "a".repeat(64), createdBy: actor, createdAt: "2026-10-11T10:00:00.000Z" };
const receipt = { scope, commandId: c.commandId, actorId: actor, revisionId: revision.id, previousRevisionId: null, changed: true, committedAt: revision.createdAt, evidenceGeneration: 1, unresolvedSourceChanges: 0 };
beforeEach(() => { vi.resetAllMocks(); boundary.admin.mockReturnValue({ rpc: boundary.rpc }); boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role: "analyst" });
  boundary.rpc.mockResolvedValue({ data: { revision, receipt, replayed: false }, error: null }); });
describe("Constraint service authorization and receipt boundaries", () => {
  it.each([{ actorId: actor }, { role: "incident_commander" }, { organizationId: scope.organizationId }, { expectedConstraintRevision: undefined }, { configuration: { ...config, inputBasis: "agency_verified" } }])("rejects invalid/authority-owned %j before auth or storage", async patch => {
    await expect(recordConstraints({ ...c, ...patch })).rejects.toMatchObject({ code: "INPUT_INVALID" }); expect(boundary.user).not.toHaveBeenCalled(); expect(boundary.admin).not.toHaveBeenCalled();
  });
  it("derives identity and preserves the exact typed configuration", async () => {
    expect(await recordConstraints(c)).toEqual({ revision, receipt, replayed: false });
    expect(boundary.rpc).toHaveBeenCalledWith("sentinel_record_constraints", { p_actor_id: actor, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId,
      p_mode: scope.mode, p_command_id: c.commandId, p_expected_revision: null, p_configuration: config });
  });
  it.each(["scope", "actorId", "commandId", "revisionId", "previousRevisionId", "changed", "committedAt"])("rejects misbound receipt %s", async key => {
    const r = structuredClone(receipt) as Record<string, unknown>; r[key] = key === "scope" ? { ...scope, mode: "replay" } : key === "changed" ? false : key === "committedAt" ? "2026-10-11T11:00:00.000Z" : id(99);
    boundary.rpc.mockResolvedValue({ data: { revision, receipt: r, replayed: false }, error: null }); await expect(recordConstraints(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it.each(["configuration", "createdBy", "scope"])("rejects mutated revision %s", async key => {
    const value = structuredClone(revision) as Record<string, unknown>; value[key] = key === "configuration" ? { ...config, tasks: [] } : key === "scope" ? { ...scope, incidentId: id(99) } : id(99);
    boundary.rpc.mockResolvedValue({ data: { revision: value, receipt, replayed: false }, error: null }); await expect(recordConstraints(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it.each([["42501", "SCOPE_DENIED"], ["22023", "INPUT_INVALID"], ["40001", "CONSTRAINT_CONFLICT"], ["23505", "CONSTRAINT_CONFLICT"], ["XX000", "STORAGE_UNAVAILABLE"]])("maps SQL %s safely", async (code, expected) => {
    boundary.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_CONSTRAINT_DETAILS" } }); await expect(recordConstraints(c)).rejects.toMatchObject({ code: expected });
    try { await recordConstraints(c); } catch (error) { expect(String(error)).not.toContain("PRIVATE_CONSTRAINT_DETAILS"); }
  });
  it("handles unavailable auth/storage and viewer write denial", async () => {
    boundary.user.mockResolvedValue(null); await expect(recordConstraints(c)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role: "viewer" }); await expect(recordConstraints(c)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    boundary.user.mockRejectedValue(new Error("PRIVATE_AUTH")); await expect(readConstraints(c.incidentId, c.mode)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role: "analyst" }); boundary.admin.mockReturnValue(null); await expect(recordConstraints(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("reads private current revisions with scope from the session", async () => {
    const page = { scope, revision, evidenceGeneration: 1, unresolvedSourceChanges: 0, observedAt: time }; boundary.rpc.mockResolvedValue({ data: page, error: null });
    expect(await readConstraints(c.incidentId, c.mode)).toEqual(page); expect(boundary.rpc).toHaveBeenCalledWith("sentinel_read_constraints", { p_actor_id: actor, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode });
  });
  it("rejects cross-scope/oversized current projections", async () => {
    boundary.rpc.mockResolvedValue({ data: { scope, revision: { ...revision, scope: { ...scope, mode: "replay" } }, evidenceGeneration: 1, unresolvedSourceChanges: 0, observedAt: time }, error: null });
    await expect(readConstraints(c.incidentId, c.mode)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    boundary.rpc.mockResolvedValue({ data: { oversized: "x".repeat(1024 * 1024) }, error: null }); await expect(readConstraints(c.incidentId, c.mode)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
