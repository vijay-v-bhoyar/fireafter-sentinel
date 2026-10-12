import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion } from "./evidence";
import { PublicationResultSchema, SourceConfigurationSchema } from "./publication";

const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const actor = id(9), owner = id(10), config = id(44), s = [scope.organizationId, scope.incidentId, scope.mode] as const;
const base = { scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Synthetic county", jurisdiction: "Fixture county",
  canonicalUrl: "https://example.gov/notice", rawText: "Synthetic initial notice", publishedAt: null, effectiveFrom: null,
  effectiveUntil: null, availability: "available", contentPermission: "full_text" };
const seeded = prepareDocumentVersion(base, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
const registry = SourceConfigurationSchema.parse({ schemaVersion: 1, sources: [3, 13, 14, 15, 16].map(n => ({
  documentId: id(n), documentKey: id(n), issuer: base.issuer, jurisdiction: base.jurisdiction, contentPermission: "full_text",
  canonicalUrl: n === 3 ? base.canonicalUrl : `https://example.gov/notice-${n}`,
})) });
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
let run: { id: string; createdAt: string; fence: number };
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  await fixture.db.exec("begin"); await fixture.seed(seeded, actor, "analyst");
  await fixture.db.query(`insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by)
    values($1,$2,$3,$4,$5,$6,$7)`, [config, ...s, JSON.stringify(registry), "b".repeat(64), actor]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1", [config]);
  const admitted = await fixture.rpc<{ run: typeof run }>("sentinel_admit_run", [actor, ...s, config, id(11)]);
  run = (await fixture.rpc<{ run: typeof run }>("sentinel_acquire_run_lease", [...s, admitted.run.id, owner])).run;
});
afterEach(async () => { await fixture.db.exec("rollback"); });
afterAll(async () => { await fixture?.close(); });
function observation(text = "Synthetic revised notice", n = 100, patch: Record<string, unknown> = {}) {
  const version = prepareDocumentVersion({ ...base, sourceConfigRevision: config, rawText: text, ...patch },
    { id: id(n), retrievedAt: new Date().toISOString() }).version;
  return { documentId: version.documentId, requestedAt: run.createdAt, observedBytes: Buffer.byteLength(text),
    providerRequestId: "synthetic-request", outcome: "observed" as const, version };
}
const publish = async (items: unknown[], key = id(80), worker = owner, fence = run.fence) =>
  PublicationResultSchema.parse(await fixture.rpc("sentinel_publish_evidence", [...s, run.id, worker, fence, key, JSON.stringify(items)]));
const state = async () => (await fixture.db.query<{ evidence_generation: number; unresolved_source_change_count: number }>("select * from public.sentinel_incident_state where mode='synthetic'")).rows[0];
const counts = async () => (await fixture.db.query<{ versions: number; events: number; markers: number; publications: number }>(`select
  (select count(*)::int from public.sentinel_document_versions) versions,(select count(*)::int from public.sentinel_retrieval_events) events,
  (select count(*)::int from public.sentinel_source_change_markers) markers,(select count(*)::int from public.sentinel_evidence_publications) publications`)).rows[0];

describe("Leased evidence publication, applied embedded PostgreSQL", () => {
  it("publishes version, pointer, retrieval, unresolved marker and receipt atomically", async () => {
    const item = observation(); const result = await publish([item]);
    expect(result.replayed).toBe(false); expect(result.receipt.evidenceGeneration).toBe(1); expect(result.receipt.unresolvedSourceChanges).toBe(1);
    expect(result.receipt.observations[0]).toMatchObject({ documentId: id(3), versionId: id(100), previousVersionId: null,
      identityHash: item.version.identityHash, changed: true, outcome: "version" });
    expect((await fixture.read(actor, ...s, id(100)))).toEqual(item.version);
    expect(await counts()).toEqual({ versions: 2, events: 1, markers: 1, publications: 1 });
  });
  it("replays a lost acknowledgment without duplicate events or generation changes", async () => {
    const item = observation(), first = await publish([item]); const replay = await publish([item]);
    expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.receipt);
    await expect(publish([observation("Different notice", 101)])).rejects.toMatchObject({ code: "23505" });
    expect(await counts()).toEqual({ versions: 2, events: 1, markers: 1, publications: 1 });
  });
  it("rechecking identical normalized text adds only an event and preserves original version time", async () => {
    const first = observation("Synthetic\nnotice", 100); await publish([first]);
    const second = observation("Synthetic\r\nnotice", 101); const result = await publish([second], id(81));
    expect(result.receipt.observations[0]).toMatchObject({ versionId: id(100), previousVersionId: id(100), changed: false, markerId: null, outcome: "same_version" });
    expect((await fixture.read(actor, ...s, id(100)))).toEqual(first.version);
    expect(await counts()).toEqual({ versions: 2, events: 2, markers: 1, publications: 2 });
    expect((await state()).evidence_generation).toBe(1);
  });
  it("meaning-relevant metadata changes open a new marker even with unchanged content", async () => {
    await publish([observation()]);
    const next = observation("Synthetic revised notice", 101, { effectiveFrom: "2026-10-12T10:00:00Z" });
    const result = await publish([next], id(81));
    expect(result.receipt.observations[0]).toMatchObject({ versionId: id(101), previousVersionId: id(100), changed: true });
    expect(result.receipt.evidenceGeneration).toBe(2); expect(result.receipt.unresolvedSourceChanges).toBe(2);
  });
  it("returning to a prior identity retains its original version and creates a new transition marker", async () => {
    await publish([observation("A", 100)]); await publish([observation("B", 101)], id(81));
    const result = await publish([observation("A", 102)], id(82));
    expect(result.receipt.observations[0]).toMatchObject({ versionId: id(100), previousVersionId: id(101), changed: true });
    expect(await counts()).toEqual({ versions: 3, events: 3, markers: 3, publications: 3 });
  });
  it.each(["failed", "incomplete"])("%s retrieval preserves the last good pointer, version and original age", async outcome => {
    const original = observation(); await publish([original]);
    const result = await publish([{ documentId: id(3), requestedAt: run.createdAt, outcome,
      safeErrorCode: "SOURCE_UNAVAILABLE", observedBytes: 0, providerRequestId: null }], id(81));
    expect(result.receipt.observations[0]).toMatchObject({ versionId: null, previousVersionId: id(100), changed: false, outcome });
    expect((await fixture.db.query("select version_id from public.sentinel_document_heads")).rows[0]).toEqual({ version_id: id(100) });
    expect(await fixture.read(actor, ...s, id(100))).toEqual(original.version);
    expect((await state()).unresolved_source_change_count).toBe(1);
  });
  it.each(["withdrawn", "incomplete"])("a represented %s version fences approval and retains previous history", async availability => {
    await publish([observation()]); const result = await publish([observation("notice unavailable", 101, { availability })], id(81));
    expect(result.receipt.observations[0]).toMatchObject({ outcome: availability, changed: true });
    expect(await fixture.read(actor, ...s, id(100))).not.toBeNull(); expect(result.receipt.unresolvedSourceChanges).toBe(2);
  });
  it("rolls back every record when a later document in the batch is invalid", async () => {
    const bad = observation("Second", 101, { documentId: id(13), canonicalUrl: "https://example.gov/wrong" });
    await expect(publish([observation(), bad])).rejects.toMatchObject({ code: "22023" });
    expect(await counts()).toEqual({ versions: 1, events: 0, markers: 0, publications: 0 }); expect((await state()).evidence_generation).toBe(0);
  });
  it("accepts five registered documents as one complete batch", async () => {
    const items = registry.sources.map(source => observation(`Synthetic ${source.documentId}`, 100 + registry.sources.indexOf(source), {
      documentId: source.documentId, canonicalUrl: source.canonicalUrl, issuer: source.issuer,
      jurisdiction: source.jurisdiction, contentPermission: source.contentPermission,
    }));
    expect((await publish(items)).receipt.observations).toHaveLength(5);
    expect(await counts()).toEqual({ versions: 6, events: 5, markers: 5, publications: 1 });
  });
  it.each([{ items: [] }, { items: [1, 2, 3, 4, 5, 6] }])("rejects unsupported batch count $items", async ({ items }) => {
    await expect(publish(items)).rejects.toMatchObject({ code: "22023" });
  });
  it("rejects duplicate source observations before any persistence", async () => {
    const item = observation(); await expect(publish([item, item])).rejects.toMatchObject({ code: "22023" });
    expect((await counts()).events).toBe(0);
  });
  it.each(["issuer", "jurisdiction", "canonicalUrl", "contentPermission"])("enforces registered %s", async field => {
    const patch = field === "contentPermission" ? "metadata_only" : field === "canonicalUrl" ? "https://other.gov/notice" : "Other authority";
    await expect(publish([observation("Notice", 100, { [field]: patch })])).rejects.toMatchObject({ code: "22023" });
  });
  it.each(["identityHash", "normalizedHash", "normalizedText"])("rejects corrupt %s without opening a marker", async field => {
    const item = observation(); const corrupt = { ...item, version: { ...item.version, [field]: field === "normalizedText" ? "Corrupt" : "f".repeat(64) } };
    await expect(publish([corrupt])).rejects.toMatchObject({ code: "22023" }); expect((await state()).evidence_generation).toBe(0);
  });
  it("cannot publish or replay under revoked membership, cancellation, expired lease or stale fence", async () => {
    const item = observation(); await publish([item]);
    await expect(publish([item], id(80), id(99))).rejects.toMatchObject({ code: "40001" });
    await expect(publish([item], id(80), owner, run.fence + 1)).rejects.toMatchObject({ code: "40001" });
    await fixture.db.query("update public.organization_members set role='viewer'");
    await expect(publish([item])).rejects.toMatchObject({ code: "42501" });
    await fixture.db.query("update public.organization_members set role='analyst'");
    await fixture.rpc("sentinel_cancel_run", [actor, ...s, run.id, id(90)]);
    await expect(publish([item])).rejects.toMatchObject({ code: "40001" });
  });
  it("denies an expired lease and accepts historical receipt replay by a newly fenced worker", async () => {
    const item = observation(), first = await publish([item]);
    await fixture.db.exec("update public.sentinel_runs set lease_until=clock_timestamp()-interval '1 second'");
    await expect(publish([item])).rejects.toMatchObject({ code: "40001" });
    const taken = await fixture.rpc<{ run: typeof run }>("sentinel_acquire_run_lease", [...s, run.id, id(12)]);
    const replay = await publish([item], id(80), id(12), taken.run.fence);
    expect(replay.receipt).toEqual(first.receipt); expect(replay.replayed).toBe(true);
  });
  it("rejects old configuration, cross-mode and foreign incident worker scope", async () => {
    const item = observation();
    await expect(fixture.rpc("sentinel_publish_evidence", [scope.organizationId, id(99), scope.mode, run.id, owner, run.fence, id(80), JSON.stringify([item])])).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.rpc("sentinel_publish_evidence", [scope.organizationId, scope.incidentId, "live", run.id, owner, run.fence, id(80), JSON.stringify([item])])).rejects.toMatchObject({ code: "42501" });
    await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1", [id(4)]);
    await expect(publish([item])).rejects.toMatchObject({ code: "40001" });
  });
  it("rejects fabricated future retrieval times and oversized transport", async () => {
    const item = observation();
    await expect(publish([{ ...item, requestedAt: "2099-01-01T00:00:00Z" }])).rejects.toMatchObject({ code: "22023" });
    await expect(publish([{ ...item, observedBytes: 1048577 }])).rejects.toMatchObject({ code: "22023" });
    await expect(publish([{ ...item, version: { ...item.version, retrievedAt: "2099-01-01T00:00:00Z" } }])).rejects.toMatchObject({ code: "22023" });
  });
  it("keeps markers/receipts immutable and forbids raw service reads or public RPC calls", async () => {
    await publish([observation()]);
    for (const table of ["sentinel_source_change_markers", "sentinel_evidence_publications"]) {
      await fixture.db.exec("savepoint reject_mutation");
      await expect(fixture.db.exec(`delete from public.${table}`)).rejects.toMatchObject({ code: "55000" });
      await fixture.db.exec("rollback to savepoint reject_mutation; release savepoint reject_mutation");
    }
    const privileges = (await fixture.db.query<{ raw: boolean; rpc: boolean; helper: boolean }>(`select
      has_table_privilege('service_role','public.sentinel_document_heads','select') raw,
      has_function_privilege('authenticated','public.sentinel_publish_evidence(uuid,uuid,text,uuid,uuid,bigint,uuid,jsonb)','execute') rpc,
      has_function_privilege('service_role','public.sentinel_version_identity(jsonb)','execute') helper`)).rows[0];
    expect(privileges).toEqual({ raw: false, rpc: false, helper: false });
  });
  it("rolls back all publication effects if the lease expires during persistence", async () => {
    await fixture.db.exec(`create function public.fixture_delay_marker() returns trigger language plpgsql as $$
      begin perform pg_sleep(0.15); return new; end; $$;
      create trigger fixture_delay_marker before insert on public.sentinel_source_change_markers
        for each row execute function public.fixture_delay_marker();
      update public.sentinel_runs set lease_until=clock_timestamp()+interval '100 milliseconds';`);
    await expect(publish([observation()])).rejects.toMatchObject({ code: "40001" });
    expect(await counts()).toEqual({ versions: 1, events: 0, markers: 0, publications: 0 });
    expect((await state()).evidence_generation).toBe(0);
  });
  it.each(["excerpt_only", "metadata_only"])("retains no full text in a %s publication or its command payload", async contentPermission => {
    const nextConfig = id(45), nextRegistry = { ...registry, sources: [{ ...registry.sources[0], contentPermission }] };
    await fixture.rpc("sentinel_cancel_run", [actor, ...s, run.id, id(90)]);
    await fixture.db.query(`insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by)
      values($1,$2,$3,$4,$5,$6,$7)`, [nextConfig, ...s, JSON.stringify(nextRegistry), "c".repeat(64), actor]);
    await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1", [nextConfig]);
    const admitted = await fixture.rpc<{ run: typeof run }>("sentinel_admit_run", [actor, ...s, nextConfig, id(12)]);
    run = (await fixture.rpc<{ run: typeof run }>("sentinel_acquire_run_lease", [...s, admitted.run.id, owner])).run;
    const item = observation("PRIVATE_TRANSIENT_REPRESENTATION", 100, { contentPermission, sourceConfigRevision: nextConfig });
    await publish([item]);
    expect((await fixture.read(actor, ...s, id(100)))).toMatchObject({ normalizedText: null, contentPermission });
    expect((await fixture.db.query<{ payload: string }>("select payload::text from public.sentinel_evidence_publications")).rows[0].payload).not.toContain("PRIVATE_TRANSIENT_REPRESENTATION");
  });
  it("denies every raw privilege on all publication tables to app-facing roles", async () => {
    const privileges = (await fixture.db.query<{ allowed: boolean }>(`select has_table_privilege(r,t,p) allowed
      from unnest(array['anon','authenticated','service_role']) r
      cross join unnest(array['public.sentinel_document_heads','public.sentinel_source_change_markers','public.sentinel_evidence_publications']) t
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p`)).rows;
    expect(privileges).toHaveLength(36); expect(privileges.every(item => !item.allowed)).toBe(true);
  });
});
