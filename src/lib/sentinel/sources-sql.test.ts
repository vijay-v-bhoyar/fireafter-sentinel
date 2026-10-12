import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion } from "./evidence";
import { EvidenceSummarySchema, SourceChangePageSchema, sourceConfigurationHash } from "./sources";

const id = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const s = [scope.organizationId, scope.incidentId, scope.mode] as const, actor = id(9), owner = id(10);
const registration = { documentId: id(3), documentKey: id(3), canonicalUrl: "https://example.gov/notice", issuer: 'Synthetic county "é"',
  jurisdiction: "Fixture county", contentPermission: "full_text" as const };
const config = { schemaVersion: 1 as const, sources: [registration] };
const base = { scope, documentId: id(3), sourceConfigRevision: id(4), issuer: registration.issuer, jurisdiction: registration.jurisdiction,
  canonicalUrl: registration.canonicalUrl, rawText: "Synthetic initial", publishedAt: null, effectiveFrom: null, effectiveUntil: null,
  availability: "available", contentPermission: "full_text" };
const seeded = prepareDocumentVersion(base, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
type Activation = { receipt: { configRevision: string; previousConfigRevision: string | null; evidenceGeneration: number; changed: boolean; configHash: string }; replayed: boolean };
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  await fixture.db.exec("begin"); await fixture.seed(seeded, actor, "incident_commander");
  await fixture.db.query("insert into public.sentinel_source_operators(organization_id,user_id) values($1,$2)", [scope.organizationId, actor]);
});
afterEach(async () => { await fixture.db.exec("rollback"); });
afterAll(async () => { await fixture?.close(); });
const activate = (configuration: unknown = config, expected: string | null = null, command = id(80), who = actor, mode = scope.mode as string) =>
  fixture.rpc<Activation>("sentinel_activate_source_config", [who, scope.organizationId, scope.incidentId, mode, command, expected,
    JSON.stringify(configuration), sourceConfigurationHash(configuration)]);
const summary = (who = actor, incident = scope.incidentId, mode = scope.mode as string) =>
  fixture.rpc("sentinel_read_evidence_summary", [who, scope.organizationId, incident, mode]);
const page = (after = 0, who = actor) => fixture.rpc("sentinel_read_source_changes", [who, ...s, after]);
async function start() {
  const activated = await activate();
  const admitted = await fixture.rpc<{ run: { id: string } }>("sentinel_admit_run", [actor, ...s, activated.receipt.configRevision, id(81)]);
  const leased = await fixture.rpc<{ run: { id: string; fence: number; createdAt: string } }>("sentinel_acquire_run_lease", [...s, admitted.run.id, owner]);
  return { configRevision: activated.receipt.configRevision, ...leased.run };
}
async function publish(run: Awaited<ReturnType<typeof start>>, n = 100, permission = "full_text") {
  const version = prepareDocumentVersion({ ...base, sourceConfigRevision: run.configRevision, rawText: `Synthetic revision ${n}`,
    contentPermission: permission }, { id: id(n), retrievedAt: new Date().toISOString() }).version;
  await fixture.rpc("sentinel_publish_evidence", [...s, run.id, owner, run.fence, id(1000 + n), JSON.stringify([
    { documentId: id(3), requestedAt: run.createdAt, observedBytes: 20, providerRequestId: "PRIVATE_REQUEST_ID", outcome: "observed", version },
  ])]);
  return version;
}
describe("Source configuration activation and metadata projections, applied local SQL", () => {
  it("activates a canonical Unicode/quoted registry and records one atomic receipt", async () => {
    const result = await activate();
    expect(result.receipt).toMatchObject({ evidenceGeneration: 1, changed: true, previousConfigRevision: null, configHash: sourceConfigurationHash(config) });
    const value = EvidenceSummarySchema.parse(await summary());
    expect(value.configuration).toEqual(config); expect(value.sourceConfigRevision).toBe(result.receipt.configRevision);
    expect(value.documents).toEqual([{ documentId: id(3), currentVersion: null, matchesConfiguration: false, latestRetrieval: null }]);
  });
  it("replays the original command after a later activation without reactivating old configuration", async () => {
    const first = await activate();
    const next = await activate({ ...config, sources: [{ ...registration, issuer: "Revised issuer" }] }, first.receipt.configRevision, id(82));
    const replay = await activate();
    expect(replay.receipt).toEqual(first.receipt); expect(replay.replayed).toBe(true);
    expect(EvidenceSummarySchema.parse(await summary()).sourceConfigRevision).toBe(next.receipt.configRevision);
  });
  it("identical configuration with a new command preserves revision and generation", async () => {
    const first = await activate(); const same = await activate(config, first.receipt.configRevision, id(82));
    expect(same.receipt).toMatchObject({ configRevision: first.receipt.configRevision, evidenceGeneration: 1, changed: false });
  });
  it("rejects conflicting payload replay and stale expected configuration", async () => {
    await activate(); const changed = { ...config, sources: [{ ...registration, issuer: "Other" }] };
    await expect(activate(changed)).rejects.toMatchObject({ code: "23505" });
    await expect(activate(config, null, id(82))).rejects.toMatchObject({ code: "40001" });
  });
  it.each(["viewer", "analyst"])("denies activation by %s even with operator admission", async role => {
    await fixture.db.query("update public.organization_members set role=$1 where user_id=$2", [role, actor]);
    await expect(activate()).rejects.toMatchObject({ code: "42501" });
  });
  it("denies an unadmitted or revoked source operator, including a historical receipt replay", async () => {
    await activate(); await fixture.db.exec("delete from public.sentinel_source_operators");
    await expect(activate()).rejects.toMatchObject({ code: "42501" });
  });
  it("retains stable document keys across revisions and rolls back a mixed invalid batch", async () => {
    const first = await activate();
    const invalid = { schemaVersion: 1, sources: [{ ...registration, documentId: id(13), documentKey: "new" }, { ...registration, documentKey: "renamed", canonicalUrl: "https://example.gov/second" }] };
    await expect(activate(invalid, first.receipt.configRevision, id(82))).rejects.toMatchObject({ code: "23505" });
    expect((await fixture.db.query("select count(*)::int n from public.sentinel_documents where id=$1", [id(13)])).rows[0]).toEqual({ n: 0 });
    expect(EvidenceSummarySchema.parse(await summary()).evidenceGeneration).toBe(1);
  });
  it("fences an old worker on changed configuration while retaining outstanding reservations", async () => {
    const run = await start();
    await fixture.rpc("sentinel_reserve_provider_attempt", [...s, run.id, owner, run.fence, id(83), "extract", "tavily", 0, 0]);
    await activate({ ...config, sources: [{ ...registration, issuer: "New" }] }, run.configRevision, id(82));
    await expect(publish(run)).rejects.toMatchObject({ code: "40001" });
    const row = (await fixture.db.query("select status,stage,fence,lease_owner from public.sentinel_runs where id=$1", [run.id])).rows[0];
    expect(row).toMatchObject({ status: "failed", stage: "configuration_changed", fence: run.fence + 1, lease_owner: null });
    expect((await fixture.db.query("select count(*)::int n from public.sentinel_provider_reservations")).rows[0]).toEqual({ n: 1 });
  });
  it("keeps the current worker when activation is an exact no-op", async () => {
    const run = await start(); await activate(config, run.configRevision, id(82));
    await publish(run); expect(EvidenceSummarySchema.parse(await summary()).evidenceGeneration).toBe(2);
  });
  it("distinguishes a published version, identical recheck and later failed acquisition without text disclosure", async () => {
    const run = await start(); const version = await publish(run);
    let value = EvidenceSummarySchema.parse(await summary());
    expect(value.documents[0]).toMatchObject({ matchesConfiguration: true, currentVersion: { id: version.id, retrievedAt: version.retrievedAt } });
    await fixture.rpc("sentinel_publish_evidence", [...s, run.id, owner, run.fence, id(90), JSON.stringify([
      { documentId: id(3), requestedAt: run.createdAt, observedBytes: 0, providerRequestId: null, outcome: "failed", safeErrorCode: "SOURCE_UNAVAILABLE" },
    ])]);
    value = EvidenceSummarySchema.parse(await summary());
    expect(value.documents[0].latestRetrieval?.outcome).toBe("failed"); expect(value.documents[0].currentVersion?.retrievedAt).toBe(version.retrievedAt);
    expect(JSON.stringify(value)).not.toContain("Synthetic revision"); expect(JSON.stringify(value)).not.toContain("PRIVATE_REQUEST_ID");
  });
  it("labels retained previous-config heads as mismatched and does not reuse old retrieval success", async () => {
    const run = await start(); const old = await publish(run);
    await activate({ ...config, sources: [{ ...registration, contentPermission: "metadata_only" }] }, run.configRevision, id(82));
    expect(EvidenceSummarySchema.parse(await summary()).documents[0]).toMatchObject({ currentVersion: { id: old.id }, matchesConfiguration: false, latestRetrieval: null });
  });
  it("uses durable append order when retrieval timestamps tie", async () => {
    const run = await start();
    await fixture.db.exec(`create function tie_fixture_retrieval_time() returns trigger language plpgsql as $$
      begin new.completed_at:=new.requested_at; return new; end $$;
      create trigger tie_fixture_retrieval_time before insert on public.sentinel_retrieval_events for each row execute function tie_fixture_retrieval_time();`);
    await publish(run);
    await fixture.rpc("sentinel_publish_evidence", [...s, run.id, owner, run.fence, id(90), JSON.stringify([
      { documentId: id(3), requestedAt: run.createdAt, observedBytes: 0, providerRequestId: null, outcome: "failed", safeErrorCode: "SOURCE_UNAVAILABLE" },
    ])]);
    expect((await fixture.db.query("select count(distinct completed_at)::int n from public.sentinel_retrieval_events")).rows[0]).toEqual({ n: 1 });
    expect(EvidenceSummarySchema.parse(await summary()).documents[0].latestRetrieval?.outcome).toBe("failed");
  });
  it("isolates a second organization and a second incident even with the same document IDs", async () => {
    const run = await start(); await publish(run);
    const other = prepareDocumentVersion({ ...base, scope: { ...scope, organizationId: id(21), incidentId: id(22) } }, { id: id(25), retrievedAt: "2026-10-11T10:00:00Z" }).version;
    await fixture.seed(other, id(29), "viewer");
    await expect(fixture.rpc("sentinel_read_evidence_summary", [actor, id(21), id(22), scope.mode])).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.rpc("sentinel_read_source_changes", [actor, id(21), id(22), scope.mode, 0])).rejects.toMatchObject({ code: "42501" });
    expect(await summary(actor, id(22))).toBeNull();
    const sameOrgOtherIncident = prepareDocumentVersion({ ...base, scope: { ...scope, incidentId: id(32) } }, { id: id(35), retrievedAt: "2026-10-11T10:00:00Z" }).version;
    await fixture.seed(sameOrgOtherIncident, actor, "incident_commander");
    expect(EvidenceSummarySchema.parse(await summary(actor, id(32))).documents).toEqual([]);
    const otherPage = SourceChangePageSchema.parse(await fixture.rpc("sentinel_read_source_changes", [actor, scope.organizationId, id(32), scope.mode, 0]));
    expect(otherPage.items).toEqual([]); expect(otherPage.unresolvedSourceChanges).toBe(0);
    expect(SourceChangePageSchema.parse(await page()).items).toHaveLength(1);
  });
  it("admits source configuration independently in each mode", async () => {
    const synthetic = await activate(); const live = await activate(config, null, id(82), actor, "live");
    expect(live.receipt.configRevision).not.toBe(synthetic.receipt.configRevision);
    expect(EvidenceSummarySchema.parse(await summary()).sourceConfigRevision).toBe(synthetic.receipt.configRevision);
    expect(EvidenceSummarySchema.parse(await summary(actor, scope.incidentId, "live")).sourceConfigRevision).toBe(live.receipt.configRevision);
  });
  it("allows member roles to read, denies revoked membership and hides absent scopes", async () => {
    await activate();
    for (const role of ["viewer", "analyst", "incident_commander"]) {
      await fixture.db.query("update public.organization_members set role=$1 where user_id=$2", [role, actor]);
      expect(await summary()).not.toBeNull(); expect(await page()).not.toBeNull();
    }
    expect(await summary(actor, id(99))).toBeNull(); expect(await summary(actor, scope.incidentId, "live")).toBeNull();
    await fixture.db.exec("delete from public.organization_members");
    await expect(summary()).rejects.toMatchObject({ code: "42501" }); await expect(page()).rejects.toMatchObject({ code: "42501" });
  });
  it("paginates 26 retained transitions without duplication or omission", async () => {
    const run = await start(); const versions = [];
    for (let n = 100; n < 126; n++) versions.push(await publish(run, n));
    const first = SourceChangePageSchema.parse(await page());
    expect(first.items).toHaveLength(25); expect(first.hasMore).toBe(true); expect(first.nextAfterGeneration).toBe(26);
    const last = SourceChangePageSchema.parse(await page(first.nextAfterGeneration!));
    expect(last.items).toHaveLength(1); expect(last.hasMore).toBe(false); expect(last.nextAfterGeneration).toBeNull();
    expect([...first.items, ...last.items].map(x => x.versionId)).toEqual(versions.map(x => x.id));
  });
  it.each([-1, null, "9007199254740992"])("rejects unsupported cursor %s", async cursor => {
    await expect(fixture.rpc("sentinel_read_source_changes", [actor, ...s, cursor])).rejects.toMatchObject({ code: "22023" });
  });
  it("rejects corrupt hashes and missing configuration fields at the SQL boundary", async () => {
    await expect(fixture.rpc("sentinel_activate_source_config", [actor, ...s, id(80), null, JSON.stringify(config), "a".repeat(64)])).rejects.toMatchObject({ code: "22023" });
    await expect(fixture.rpc("sentinel_activate_source_config", [actor, ...s, id(80), null, JSON.stringify({ unrelated: 1, sources: [] }), "a".repeat(64)])).rejects.toMatchObject({ code: "22023" });
  });
  it("denies raw grants/self-admission and protects immutable activation receipts", async () => {
    await activate();
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of ["sentinel_source_operators", "sentinel_source_config_commands"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          expect((await fixture.db.query<{ allowed: boolean }>("select has_table_privilege($1,$2,$3) allowed", [role, `public.${table}`, privilege])).rows[0].allowed).toBe(false);
        }
      }
      expect((await fixture.db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.sentinel_source_config_hash(jsonb)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false);
    }
    await fixture.db.exec("savepoint immutable_activation");
    await expect(fixture.db.exec("update public.sentinel_source_config_commands set receipt='{}'")).rejects.toMatchObject({ code: "55000" });
    await fixture.db.exec("rollback to savepoint immutable_activation; release savepoint immutable_activation");
  });
});
