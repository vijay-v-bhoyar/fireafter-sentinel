import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { GET as summary } from "@/app/api/sentinel/evidence/route";
import { GET as changes } from "@/app/api/sentinel/source-changes/route";
import { GET as document } from "@/app/api/sentinel/documents/[id]/route";
import { activateSourceConfiguration } from "./sources";
import { prepareDocumentVersion } from "./evidence";
import { publishEvidence } from "./publication";
import { encodeSourceChangeCursor } from "./evidence-http";
const boundary = vi.hoisted(() => ({ user: vi.fn(), admin: vi.fn() }));
vi.mock("../auth", () => ({ getCurrentUser: () => boundary.user() }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => boundary.admin() }));
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const }, actor = id(9), owner = id(10);
const s = [scope.organizationId, scope.incidentId, scope.mode] as const;
const base = { scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Fixture county", jurisdiction: "Fixture county",
  canonicalUrl: "https://example.gov/notice", rawText: "Synthetic published evidence", publishedAt: null, effectiveFrom: null, effectiveUntil: null,
  availability: "available", contentPermission: "full_text" };
const seeded = prepareDocumentVersion(base, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
const configuration = { schemaVersion: 1, sources: [{ documentId: id(3), documentKey: id(3), issuer: base.issuer,
  jurisdiction: base.jurisdiction, canonicalUrl: base.canonicalUrl, contentPermission: "full_text" }] };
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
let run: { id: string; createdAt: string; fence: number }, configRevision: string;
const request = (incident = id(2), mode = "synthetic", cursor?: string) => new Request(`http://127.0.0.1:3020/api/sentinel/evidence?incidentId=${incident}&mode=${mode}${cursor ? `&cursor=${cursor}` : ""}`);
const versionContext = (versionId = id(100)) => ({ params: Promise.resolve({ id: versionId }) });
const parameters: Record<string, string[]> = {
  sentinel_activate_source_config: ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode", "p_command_id", "p_expected_config", "p_configuration", "p_config_hash"],
  sentinel_publish_evidence: ["p_organization_id", "p_incident_id", "p_mode", "p_run_id", "p_owner", "p_fence", "p_command_id", "p_observations"],
  sentinel_read_evidence_summary: ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode"],
  sentinel_read_source_changes: ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode", "p_after_generation"],
  sentinel_read_document_version: ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode", "p_version_id"],
};
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  vi.resetAllMocks(); await fixture.db.exec("begin"); await fixture.seed(seeded, actor, "incident_commander");
  await fixture.db.query("insert into public.sentinel_source_operators(organization_id,user_id) values($1,$2)", [scope.organizationId, actor]);
  boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role: "incident_commander" });
  boundary.admin.mockReturnValue({ rpc: async (name: string, values: Record<string, unknown>) => {
    if (!parameters[name] || Object.keys(values).sort().join() !== parameters[name].toSorted().join()) throw new Error("Unexpected private RPC shape");
    try {
      const data = await fixture.rpc(name, parameters[name].map(key => ["p_configuration", "p_observations"].includes(key) ? JSON.stringify(values[key]) : values[key]));
      return { data, error: null };
    } catch (error) { return { data: null, error: { code: (error as { code?: string }).code, message: "PRIVATE_DATABASE_DETAILS" } }; }
  } });
  configRevision = (await activateSourceConfiguration({ incidentId: id(2), mode: "synthetic", commandId: id(80), expectedConfigRevision: null, configuration })).receipt.configRevision;
  const admitted = await fixture.rpc<{ run: typeof run }>("sentinel_admit_run", [actor, ...s, configRevision, id(81)]);
  run = (await fixture.rpc<{ run: typeof run }>("sentinel_acquire_run_lease", [...s, admitted.run.id, owner])).run;
});
afterEach(async () => { await fixture.db.exec("rollback"); });
afterAll(async () => { await fixture?.close(); });
async function publish(n = 100) {
  const version = prepareDocumentVersion({ ...base, sourceConfigRevision: configRevision, rawText: `Synthetic published revision ${n}` }, { id: id(n), retrievedAt: new Date().toISOString() }).version;
  await publishEvidence({ scope, runId: run.id, owner, fence: run.fence, commandId: id(1000 + n), observations: [{
    documentId: id(3), requestedAt: run.createdAt, observedBytes: 30, providerRequestId: "PRIVATE_PROVIDER_ID", outcome: "observed", version,
  }] });
  return version;
}
describe("Read routes through real server helpers and applied disposable SQL", () => {
  it("reads exact published evidence while summaries omit text/provider/worker details", async () => {
    const version = await publish();
    const response = await document(request(), versionContext()); expect(response.status).toBe(200); expect(await response.json()).toEqual(version);
    const summaryResponse = await summary(request()); expect(summaryResponse.status).toBe(200);
    const value = await summaryResponse.json(); expect(value.documents[0].currentVersion.id).toBe(version.id); expect(value.documents[0].matchesConfiguration).toBe(true);
    const body = JSON.stringify(value); expect(body).not.toContain("Synthetic published revision"); expect(body).not.toContain("PRIVATE_PROVIDER_ID"); expect(body).not.toContain(owner);
    expect(summaryResponse.headers.get("cache-control")).toContain("no-store");
  });
  it.each(["viewer", "analyst", "incident_commander"])("allows read-only journeys by current %s membership", async role => {
    await publish(); await fixture.db.query("update public.organization_members set role=$1 where user_id=$2", [role, actor]);
    boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role });
    expect((await summary(request())).status).toBe(200); expect((await changes(request())).status).toBe(200); expect((await document(request(), versionContext())).status).toBe(200);
  });
  it("rejects revoked membership even when the application has stale authenticated claims", async () => {
    await publish(); await fixture.db.exec("delete from public.organization_members");
    for (const response of [await summary(request()), await changes(request()), await document(request(), versionContext())]) {
      expect(response.status).toBe(403); expect(await response.text()).not.toContain("PRIVATE_DATABASE_DETAILS");
    }
  });
  it("returns identical 404s for wrong-incident/mode/version locators", async () => {
    await publish();
    const responses = [await summary(request(id(22))), await changes(request(id(22))), await document(request(id(22)), versionContext()),
      await summary(request(id(2), "live")), await document(request(), versionContext(id(99)))];
    for (const response of responses) { expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "Evidence is unavailable in this workspace." }); }
  });
  it("retains no full text under restricted content permission", async () => {
    const revised = { ...configuration, sources: [{ ...configuration.sources[0], contentPermission: "metadata_only" }] };
    configRevision = (await activateSourceConfiguration({ incidentId: id(2), mode: "synthetic", commandId: id(82), expectedConfigRevision: configRevision, configuration: revised })).receipt.configRevision;
    const admitted = await fixture.rpc<{ run: typeof run }>("sentinel_admit_run", [actor, ...s, configRevision, id(83)]);
    run = (await fixture.rpc<{ run: typeof run }>("sentinel_acquire_run_lease", [...s, admitted.run.id, owner])).run;
    const version = prepareDocumentVersion({ ...base, sourceConfigRevision: configRevision, rawText: "RESTRICTED_FULL_TEXT", contentPermission: "metadata_only" }, { id: id(100), retrievedAt: new Date().toISOString() }).version;
    await publishEvidence({ scope, runId: run.id, owner, fence: run.fence, commandId: id(84), observations: [{ documentId: id(3), requestedAt: run.createdAt, observedBytes: 20, providerRequestId: null, outcome: "observed", version }] });
    const response = await document(request(), versionContext()); const body = await response.text(); expect(response.status).toBe(200);
    expect(JSON.parse(body).normalizedText).toBeNull(); expect(body).not.toContain("RESTRICTED_FULL_TEXT");
  });
  it("walks two actual source-transition pages through scoped opaque cursors", async () => {
    for (let n = 100; n < 126; n++) await publish(n);
    const firstResponse = await changes(request()); const first = await firstResponse.json();
    expect(firstResponse.status).toBe(200); expect(first.items).toHaveLength(25); expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(encodeSourceChangeCursor(id(2), "synthetic", 26)); expect(first).not.toHaveProperty("nextAfterGeneration");
    const second = await (await changes(request(id(2), "synthetic", first.nextCursor))).json();
    expect(second.items).toHaveLength(1); expect(second.hasMore).toBe(false); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((row: { id: string }) => row.id)).size).toBe(26);
  });
});
