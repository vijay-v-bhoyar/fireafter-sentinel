import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { assertVersionIntegrity, prepareDocumentVersion } from "./evidence";

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = id(9), scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const observation = {
  scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Synthetic public works", jurisdiction: "Fixture county",
  canonicalUrl: "https://example.gov/fixture", rawText: "Gate A opens at 12:00 UTC.",
  publishedAt: null, effectiveFrom: "2026-10-11T12:00:00Z", effectiveUntil: "2026-10-11T16:00:00Z",
  availability: "available" as const, contentPermission: "full_text" as const,
};
const version = prepareDocumentVersion(observation, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  await fixture.db.exec("begin"); await fixture.seed(version, actor);
  await fixture.db.query(`insert into public.sentinel_retrieval_events
    (organization_id,incident_id,mode,document_id,source_config_revision,checked_version_id,requested_at,completed_at,outcome,observed_bytes)
    values($1,$2,$3,$4,$5,$6,$7,$7,'version',$8)`,
    [scope.organizationId, scope.incidentId, scope.mode, version.documentId, version.sourceConfigRevision, version.id, version.retrievedAt, version.normalizedBytes]);
});
afterAll(async () => { await fixture?.close(); });
// Use transaction rollback to retain the exact applied schema for each probe.
afterEach(async () => { await fixture.db.exec("rollback"); });

describe("Applied local Sentinel evidence SQL", () => {
  it("reads back one exact immutable version through the private RPC, including unknown publication", async () => {
    const result = assertVersionIntegrity(await fixture.read(actor, scope.organizationId, scope.incidentId, scope.mode, version.id));
    expect(result.identityHash).toBe(version.identityHash);
    expect(result.normalizedText).toBe(version.normalizedText);
    expect(result.publishedAt).toBeNull();
    expect(Date.parse(result.retrievedAt)).toBe(Date.parse(version.retrievedAt));
  });
  it.each(["live", "replay"])("cannot read synthetic evidence in %s mode", async mode => {
    expect(await fixture.read(actor, scope.organizationId, scope.incidentId, mode, version.id)).toBeNull();
  });
  it("does not return evidence for another incident or absent version", async () => {
    expect(await fixture.read(actor, scope.organizationId, id(99), scope.mode, version.id)).toBeNull();
    expect(await fixture.read(actor, scope.organizationId, scope.incidentId, scope.mode, id(99))).toBeNull();
  });
  it("rechecks membership rather than treating service access as user authorization", async () => {
    await expect(fixture.read(id(99), scope.organizationId, scope.incidentId, scope.mode, version.id)).rejects.toMatchObject({ code: "42501" });
    await fixture.db.exec("rollback; begin"); await fixture.seed(version, actor);
    await fixture.db.query("delete from public.organization_members where user_id=$1", [actor]);
    await expect(fixture.read(actor, scope.organizationId, scope.incidentId, scope.mode, version.id)).rejects.toMatchObject({ code: "42501" });
  });
  it("allows all actual reader roles and denies a different organization", async () => {
    for (const [offset, role] of [[10, "analyst"], [11, "incident_commander"]] as const) {
      await fixture.db.query("insert into auth.users(id) values($1)", [id(offset)]);
      await fixture.db.query("insert into public.organization_members(organization_id,user_id,role) values($1,$2,$3)", [scope.organizationId, id(offset), role]);
      expect(assertVersionIntegrity(await fixture.read(id(offset), scope.organizationId, scope.incidentId, scope.mode, version.id)).id).toBe(version.id);
    }
    await expect(fixture.read(actor, id(99), scope.incidentId, scope.mode, version.id)).rejects.toMatchObject({ code: "42501" });
  });
  it.each(["sentinel_source_configs", "sentinel_documents", "sentinel_document_versions", "sentinel_retrieval_events"])("%s denies direct runtime writes", async table => {
    const grants = await fixture.db.query<{ allowed: boolean }>("select has_table_privilege('service_role',$1,'INSERT,UPDATE,DELETE') as allowed", [`public.${table}`]);
    expect(grants.rows[0].allowed).toBe(false);
  });
  it.each(["anon", "authenticated"])("%s cannot call the private version RPC or read its table", async role => {
    const grants = await fixture.db.query<{ callable: boolean; readable: boolean }>(`select
      has_function_privilege($1,'public.sentinel_read_document_version(uuid,uuid,uuid,text,uuid)','EXECUTE') as callable,
      has_table_privilege($1,'public.sentinel_document_versions','SELECT') as readable`, [role]);
    expect(grants.rows[0]).toEqual({ callable: false, readable: false });
  });
  for (const table of ["sentinel_source_configs", "sentinel_documents", "sentinel_document_versions", "sentinel_retrieval_events"]) {
    it.each(["update", "delete"])(`owner %s also cannot rewrite ${table}`, async action => {
      const sql = action === "update" ? `update public.${table} set id=id` : `delete from public.${table}`;
      await expect(fixture.db.exec(sql)).rejects.toMatchObject({ code: "55000" });
    });
  }
  it("rejects a source configuration reference in a different incident", async () => {
    const other = prepareDocumentVersion({ ...observation, scope: { ...scope, incidentId: id(20) }, sourceConfigRevision: id(21), documentId: id(22) }, { id: id(23), retrievedAt: version.retrievedAt }).version;
    await fixture.seed(other, actor);
    await expect(fixture.db.query(`insert into public.sentinel_document_versions
      select * from jsonb_populate_record(null::public.sentinel_document_versions,
        (select to_jsonb(v) || jsonb_build_object('id',$1::text,'source_config_revision',$2::text,'identity_hash',$3::text)
         from public.sentinel_document_versions v where v.id=$4))`,
      [id(24), other.sourceConfigRevision, "f".repeat(64), version.id])).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects a retrieval receipt bound to another document's version", async () => {
    const other = prepareDocumentVersion({ ...observation, documentId: id(22), rawText: "Different document" }, { id: id(23), retrievedAt: version.retrievedAt }).version;
    await fixture.seed(other, actor);
    await expect(fixture.db.query(`insert into public.sentinel_retrieval_events
      (organization_id,incident_id,mode,document_id,source_config_revision,checked_version_id,requested_at,completed_at,outcome,observed_bytes)
      values($1,$2,$3,$4,$5,$6,$7,$7,'same_version',20)`,
    [scope.organizationId, scope.incidentId, scope.mode, version.documentId, version.sourceConfigRevision, other.id, version.retrievedAt])).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects cross-organization incident state", async () => {
    await fixture.db.query("insert into public.organizations(id,name) values($1,'Different org')", [id(99)]);
    await expect(fixture.db.query("insert into public.sentinel_incident_state(organization_id,incident_id,mode) values($1,$2,'synthetic')", [id(99), scope.incidentId])).rejects.toMatchObject({ code: "23503" });
  });
});
