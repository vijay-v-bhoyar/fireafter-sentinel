import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareDocumentVersion } from "./evidence";
import { readDocumentVersion } from "./store";

const boundary = vi.hoisted(() => ({ user: vi.fn(), rpc: vi.fn(), admin: vi.fn() }));
vi.mock("../auth", () => ({ getCurrentUser: () => boundary.user() }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => boundary.admin() }));
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const version = prepareDocumentVersion({
  scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Fixture county", jurisdiction: "Fixture county",
  canonicalUrl: "https://example.gov/notice", rawText: "Synthetic notice", publishedAt: null, effectiveFrom: null, effectiveUntil: null,
  availability: "available", contentPermission: "full_text",
}, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
beforeEach(() => {
  vi.resetAllMocks();
  boundary.user.mockResolvedValue({ id: id(6), organizationId: scope.organizationId, role: "viewer" });
  boundary.admin.mockReturnValue({ rpc: boundary.rpc });
  boundary.rpc.mockResolvedValue({ data: version, error: null });
});
describe("Scoped Sentinel version reader", () => {
  it.each(["viewer", "analyst", "incident_commander"])("derives identity from the session and allows authorized %s reads", async role => {
    boundary.user.mockResolvedValue({ id: id(6), organizationId: scope.organizationId, role });
    expect((await readDocumentVersion(scope.incidentId, scope.mode, version.id))?.id).toBe(version.id);
    expect(boundary.rpc).toHaveBeenCalledExactlyOnceWith("sentinel_read_document_version", {
      p_actor_id: id(6), p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode, p_version_id: version.id,
    });
  });
  it("rejects missing auth or membership before the privileged call", async () => {
    boundary.user.mockResolvedValue(null);
    await expect(readDocumentVersion(scope.incidentId, scope.mode, version.id)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    boundary.user.mockResolvedValue({ id: id(6), organizationId: null, role: null });
    await expect(readDocumentVersion(scope.incidentId, scope.mode, version.id)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs or modes before authentication/network", async () => {
    await expect(readDocumentVersion("other", scope.mode, version.id)).rejects.toThrow();
    await expect(readDocumentVersion(scope.incidentId, "unknown", version.id)).rejects.toThrow();
    expect(boundary.user).not.toHaveBeenCalled(); expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { scope: { ...scope, incidentId: id(99) } }, { scope: { ...scope, mode: "live" } },
    { id: id(99) }, { normalizedText: "tampered" },
  ])("does not return a corrupt or misbound storage response %j", async patch => {
    boundary.rpc.mockResolvedValue({ data: { ...version, ...patch }, error: null });
    await expect(readDocumentVersion(scope.incidentId, scope.mode, version.id)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("returns explicit absence and redacts a database failure", async () => {
    boundary.rpc.mockResolvedValue({ data: null, error: null });
    expect(await readDocumentVersion(scope.incidentId, scope.mode, version.id)).toBeNull();
    boundary.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "PRIVATE_DATABASE_DETAIL" } });
    await expect(readDocumentVersion(scope.incidentId, scope.mode, version.id)).rejects.toMatchObject({ code: "SCOPE_DENIED", message: "This evidence is unavailable in your workspace." });
    boundary.rpc.mockRejectedValue(new Error("SECRET_CONNECTION_STRING"));
    await expect(readDocumentVersion(scope.incidentId, scope.mode, version.id)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", message: "Evidence storage is unavailable. Try again later." });
  });
});
