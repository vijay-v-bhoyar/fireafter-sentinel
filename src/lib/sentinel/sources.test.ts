import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateSourceConfiguration, readEvidenceSummary, readSourceChangePage, sourceConfigurationHash } from "./sources";
const boundary = vi.hoisted(() => ({ user: vi.fn(), admin: vi.fn(), rpc: vi.fn() }));
vi.mock("../auth", () => ({ getCurrentUser: () => boundary.user() }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => boundary.admin() }));
const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const configuration = { schemaVersion: 1, sources: [{ documentId: id(3), documentKey: "notice", canonicalUrl: "https://example.gov/notice",
  issuer: "Fixture county", jurisdiction: "Fixture county", contentPermission: "full_text" }] };
const command = { incidentId: id(2), mode: "synthetic", commandId: id(8), expectedConfigRevision: null, configuration };
const receipt = { commandId: id(8), actorId: id(9), scope, configRevision: id(4), previousConfigRevision: null,
  configHash: sourceConfigurationHash(configuration), evidenceGeneration: 1, changed: true, committedAt: "2026-10-11T10:00:00.000Z" };
const summary = { scope, sourceConfigRevision: id(4), configHash: receipt.configHash, configuration, evidenceGeneration: 1,
  unresolvedSourceChanges: 0, observedAt: receipt.committedAt,
  documents: [{ documentId: id(3), currentVersion: null, matchesConfiguration: false, latestRetrieval: null }] };
const emptyPage = { scope, evidenceGeneration: 1, unresolvedSourceChanges: 0, observedAt: receipt.committedAt,
  items: [], hasMore: false, nextAfterGeneration: null };
beforeEach(() => {
  vi.resetAllMocks(); boundary.user.mockResolvedValue({ id: id(9), organizationId: id(1), role: "incident_commander" });
  boundary.admin.mockReturnValue({ rpc: boundary.rpc }); boundary.rpc.mockResolvedValue({ data: { receipt, replayed: false }, error: null });
});
describe("Private source operator and member read helpers", () => {
  it("derives scope and actor from fresh authentication and binds the exact activation", async () => {
    expect((await activateSourceConfiguration(command)).receipt).toEqual(receipt);
    expect(boundary.rpc).toHaveBeenCalledExactlyOnceWith("sentinel_activate_source_config", {
      p_actor_id: id(9), p_organization_id: id(1), p_incident_id: id(2), p_mode: "synthetic", p_command_id: id(8),
      p_expected_config: null, p_configuration: configuration, p_config_hash: receipt.configHash,
    });
  });
  it.each([
    { actorId: id(20) }, { organizationId: id(20) }, { mode: "unknown" }, { expectedConfigRevision: "invalid" },
    { configuration: { ...configuration, sources: [] } },
    { configuration: { ...configuration, sources: [{ ...configuration.sources[0], canonicalUrl: "not-a-url" }] } },
    { configuration: { ...configuration, sources: [{ ...configuration.sources[0], canonicalUrl: "https://localhost/notice" }] } },
  ])("rejects invalid/actor-supplied input before authentication %j", async patch => {
    await expect(activateSourceConfiguration({ ...command, ...patch })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(boundary.user).not.toHaveBeenCalled(); expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it.each(["viewer", "analyst"])("denies %s activation before storage", async role => {
    boundary.user.mockResolvedValue({ id: id(9), organizationId: id(1), role });
    await expect(activateSourceConfiguration(command)).rejects.toMatchObject({ code: "SCOPE_DENIED" }); expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { actorId: id(20) }, { commandId: id(20) }, { configHash: "a".repeat(64) }, { scope: { ...scope, incidentId: id(20) } },
    { previousConfigRevision: id(4) }, { changed: false }, { rawKey: "PRIVATE" },
  ])("rejects a corrupted activation receipt %j", async patch => {
    boundary.rpc.mockResolvedValue({ data: { receipt: { ...receipt, ...patch }, replayed: false }, error: null });
    await expect(activateSourceConfiguration(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("accepts an exact historical replay without assuming that its revision is current", async () => {
    boundary.rpc.mockResolvedValue({ data: { receipt, replayed: true }, error: null });
    expect((await activateSourceConfiguration(command)).replayed).toBe(true);
  });
  it.each([["42501", "SCOPE_DENIED"], ["22023", "INPUT_INVALID"], ["40001", "SOURCE_CONFLICT"], ["23505", "SOURCE_CONFLICT"], ["XX000", "STORAGE_UNAVAILABLE"]])("redacts database %s as %s", async (sqlCode, code) => {
    boundary.rpc.mockResolvedValue({ data: null, error: { code: sqlCode, message: "PRIVATE_DATABASE" } });
    await expect(activateSourceConfiguration(command)).rejects.toMatchObject({ code });
    await expect(activateSourceConfiguration(command)).rejects.not.toThrow("PRIVATE_DATABASE");
  });
  it("redacts auth/SDK exceptions and rejects absent auth/organization/client", async () => {
    boundary.user.mockRejectedValueOnce(new Error("PRIVATE_AUTH"));
    await expect(activateSourceConfiguration(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    boundary.user.mockResolvedValueOnce(null);
    await expect(activateSourceConfiguration(command)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    boundary.user.mockResolvedValueOnce({ id: id(9), organizationId: null, role: "incident_commander" });
    await expect(activateSourceConfiguration(command)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    boundary.admin.mockReturnValueOnce(null);
    await expect(activateSourceConfiguration(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it.each(["viewer", "analyst", "incident_commander"])("permits metadata reads by %s with server-derived scope", async role => {
    boundary.user.mockResolvedValue({ id: id(9), organizationId: id(1), role });
    boundary.rpc.mockResolvedValue({ data: summary, error: null });
    expect(await readEvidenceSummary(id(2), "synthetic")).toEqual(summary);
    expect(boundary.rpc).toHaveBeenCalledWith("sentinel_read_evidence_summary", { p_actor_id: id(9), p_organization_id: id(1), p_incident_id: id(2), p_mode: "synthetic" });
  });
  it.each([
    { scope: { ...scope, mode: "live" } }, { configHash: "a".repeat(64) }, { sourceConfigRevision: null },
    { documents: [] }, { documents: [{ ...summary.documents[0], documentId: id(20) }] },
    { documents: [{ ...summary.documents[0], matchesConfiguration: true }] }, { normalizedText: "PRIVATE_TEXT" },
  ])("fails closed on corrupt metadata projection %j", async patch => {
    boundary.rpc.mockResolvedValue({ data: { ...summary, ...patch }, error: null });
    await expect(readEvidenceSummary(id(2), "synthetic")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("returns explicit absent state and unconfigured state without inventing completed checks", async () => {
    boundary.rpc.mockResolvedValue({ data: null, error: null }); expect(await readEvidenceSummary(id(2), "synthetic")).toBeNull();
    boundary.rpc.mockResolvedValue({ data: { ...summary, sourceConfigRevision: null, configHash: null, configuration: null, documents: [] }, error: null });
    expect((await readEvidenceSummary(id(2), "synthetic"))?.configuration).toBeNull();
  });
  it("accepts a scoped empty transition page", async () => {
    boundary.rpc.mockResolvedValue({ data: emptyPage, error: null });
    expect(await readSourceChangePage(id(2), "synthetic")).toEqual(emptyPage);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid cursor %s without a call", async after => {
    await expect(readSourceChangePage(id(2), "synthetic", after)).rejects.toMatchObject({ code: "INPUT_INVALID" }); expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it("validates cursor, ordering, duplication and scope on a populated page", async () => {
    const item = { id: id(40), documentId: id(3), versionId: id(5), previousVersionId: null, runId: id(6), evidenceGeneration: 2, createdAt: receipt.committedAt };
    const populated = { ...emptyPage, evidenceGeneration: 2, items: [item] };
    boundary.rpc.mockResolvedValue({ data: populated, error: null });
    expect((await readSourceChangePage(id(2), "synthetic"))?.items).toHaveLength(1);
    for (const patch of [{ items: [item, item] }, { items: [{ ...item, evidenceGeneration: 3 }] }, { hasMore: true, nextAfterGeneration: 2 },
      { scope: { ...scope, organizationId: id(20) } }]) {
      boundary.rpc.mockResolvedValue({ data: { ...populated, ...patch }, error: null });
      await expect(readSourceChangePage(id(2), "synthetic")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    }
    boundary.rpc.mockResolvedValue({ data: populated, error: null });
    await expect(readSourceChangePage(id(2), "synthetic", 2)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
