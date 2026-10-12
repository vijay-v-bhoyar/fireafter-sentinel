import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion, evidenceHash } from "./evidence";
import { publishEvidence } from "./publication";
import { publishClaims, readClaimPage, type ClaimDraft } from "./claims";
const identity = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("../auth", () => ({ getCurrentUser: async () => identity.user }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
  const keys = name === "sentinel_publish_claims"
    ? ["p_organization_id", "p_incident_id", "p_mode", "p_run_id", "p_owner", "p_fence", "p_command_id", "p_expected_generation", "p_version_ids", "p_claims", "p_transient_texts"]
    : name === "sentinel_read_claims" ? ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode", "p_version_id", "p_after_sequence"]
      : ["p_organization_id", "p_incident_id", "p_mode", "p_run_id", "p_owner", "p_fence", "p_command_id", "p_observations"];
  try { return { data: await fixture.rpc(name, keys.map(k => typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])), error: null }; }
  catch (error) { return { data: null, error }; }
} }) }));
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const }, actor = id(9), owner = id(10);
const s = [scope.organizationId, scope.incidentId, scope.mode] as const;
const text = "Synthetic notice: Å road closes today. Longer private supporting text.";
const base = { scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Synthetic county", jurisdiction: "Fixture county",
  canonicalUrl: "https://example.gov/notice", rawText: text, publishedAt: null, effectiveFrom: null, effectiveUntil: null,
  availability: "available", contentPermission: "full_text" };
const seeded = prepareDocumentVersion(base, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
let run: { id: string; fence: number; createdAt: string };
let version: typeof seeded;
let generation: number;
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  await fixture.db.exec("begin"); await fixture.seed(seeded, actor, "analyst");
  identity.user = { id: actor, organizationId: scope.organizationId, role: "analyst" };
  await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)",
    [id(44), ...s, JSON.stringify({ schemaVersion: 1, sources: [{ documentId: id(3), documentKey: id(3), canonicalUrl: base.canonicalUrl,
      issuer: base.issuer, jurisdiction: base.jurisdiction, contentPermission: "full_text" }] }), "a".repeat(64), actor]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1", [id(44)]);
  const admitted = await fixture.rpc<{ run: typeof run }>("sentinel_admit_run", [actor, ...s, id(44), id(11)]);
  run = (await fixture.rpc<{ run: typeof run }>("sentinel_acquire_run_lease", [...s, admitted.run.id, owner])).run;
  version = prepareDocumentVersion({ ...base, sourceConfigRevision: id(44) }, { id: id(100), retrievedAt: new Date().toISOString() }).version;
  generation = (await publishEvidence({ scope, runId: run.id, owner, fence: run.fence, commandId: id(80), observations: [{
    documentId: id(3), outcome: "observed", requestedAt: run.createdAt, observedBytes: Buffer.byteLength(text), providerRequestId: null, version,
  }] })).receipt.evidenceGeneration;
});
afterEach(async () => { await fixture.db.exec("rollback"); });
afterAll(async () => { await fixture?.close(); });
function claim(n = 200): ClaimDraft {
  const excerpt = "Å road closes today", excerptStart = Buffer.from(text).indexOf(Buffer.from(excerpt));
  return { id: id(n), documentVersionId: version.id, excerptStart, excerptEnd: excerptStart + Buffer.byteLength(excerpt),
    excerpt, excerptHash: evidenceHash(excerpt), kind: "road_status", claimText: "Synthetic notice states a road closure.",
    entityIds: [], modelVersion: "synthetic-model-not-live", promptVersion: "synthetic-claim-v1" };
}
function command(claims = [claim()], commandId = id(81)) {
  return { scope, runId: run.id, owner, fence: run.fence, commandId, expectedEvidenceGeneration: generation,
    versionIds: [version.id], claims, transientTexts: {} as Record<string, string> };
}
async function raw(c = command()) {
  return fixture.rpc("sentinel_publish_claims", [...s, c.runId, c.owner, c.fence, c.commandId, c.expectedEvidenceGeneration,
    JSON.stringify(c.versionIds), JSON.stringify(c.claims), JSON.stringify(c.transientTexts)]);
}
async function count() { return (await fixture.db.query<{ n: number }>("select count(*)::int n from public.sentinel_claims")).rows[0].n; }
async function restricted(permission: "excerpt_only" | "metadata_only", content = text) {
  await fixture.db.exec("update public.sentinel_runs set status='canceled',lease_owner=null,lease_until=null");
  await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)",
    [id(45), ...s, JSON.stringify({ schemaVersion: 1, sources: [{ documentId: id(3), documentKey: id(3), canonicalUrl: base.canonicalUrl,
      issuer: base.issuer, jurisdiction: base.jurisdiction, contentPermission: permission }] }), "b".repeat(64), actor]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1", [id(45)]);
  const a = await fixture.rpc<{ run: typeof run }>("sentinel_admit_run", [actor, ...s, id(45), id(12)]);
  run = (await fixture.rpc<{ run: typeof run }>("sentinel_acquire_run_lease", [...s, a.run.id, owner])).run;
  version = prepareDocumentVersion({ ...base, rawText: content, contentPermission: permission, sourceConfigRevision: id(45) },
    { id: id(101), retrievedAt: new Date().toISOString() }).version;
  generation = (await publishEvidence({ scope, runId: run.id, owner, fence: run.fence, commandId: id(82), observations: [{
    documentId: id(3), outcome: "observed", requestedAt: run.createdAt, observedBytes: Buffer.byteLength(content), providerRequestId: null, version,
  }] })).receipt.evidenceGeneration;
}

describe("Claim publication and member projection through real helpers and disposable SQL", () => {
  it("persists verified UTF-8 citations atomically while preserving unresolved human review", async () => {
    const c = command(), result = await publishClaims(c);
    expect(result).toMatchObject({ replayed: false, receipt: { claimIds: [c.claims[0].id], evidenceGeneration: generation,
      unresolvedSourceChanges: 1, semanticSupport: "unreviewed" } });
    const page = await readClaimPage(scope.incidentId, scope.mode, version.id);
    expect(page).toMatchObject({ currentEvidence: true, unresolvedSourceChanges: 1, hasMore: false,
      items: [{ citationVerified: true, semanticSupport: "unreviewed", claim: { ...c.claims[0], scope, runId: run.id } }] });
    expect(page?.items[0].claim.createdAt).toMatch(/\.\d{3}Z$/);
    const state = (await fixture.db.query("select evidence_generation,unresolved_source_change_count from public.sentinel_incident_state")).rows[0];
    expect(state).toEqual({ evidence_generation: generation, unresolved_source_change_count: 1 });
  });
  it("exact retry replays one receipt and cannot replace a claim", async () => {
    const c = command(), first = await publishClaims(c); const replay = await publishClaims(c);
    expect(replay).toEqual({ receipt: first.receipt, replayed: true }); expect(await count()).toBe(1);
    await expect(publishClaims({ ...c, claims: [{ ...c.claims[0], claimText: "Changed" }] })).rejects.toMatchObject({ code: "RUN_CONFLICT" });
    await expect(publishClaims({ ...c, commandId: id(83) })).rejects.toMatchObject({ code: "RUN_CONFLICT" });
  });
  it("records zero extracted claims without declaring zero unresolved changes", async () => {
    expect((await publishClaims(command([]))).receipt).toMatchObject({ claimIds: [], unresolvedSourceChanges: 1, semanticSupport: "unreviewed" });
  });
  it.each(["viewer", "deleted"])("fresh SQL authorization rejects %s despite old session claims", async role => {
    if (role === "deleted") await fixture.db.exec("delete from public.organization_members");
    else await fixture.db.exec("update public.organization_members set role='viewer'");
    await expect(publishClaims(command())).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });
  it.each(["incident", "mode", "organization"])("worker publication rejects foreign %s", async field => {
    const c = command(); const wrong = field === "incident" ? { ...scope, incidentId: id(99) }
      : field === "organization" ? { ...scope, organizationId: id(99) } : { ...scope, mode: "live" };
    await expect(publishClaims({ ...c, scope: wrong })).rejects.toMatchObject({ code: "SCOPE_DENIED" }); expect(await count()).toBe(0);
  });
  it.each(["generation", "fence", "owner", "expired", "canceled"])("rejects %s after publication admission", async bad => {
    const c = command();
    if (bad === "generation") c.expectedEvidenceGeneration++;
    if (bad === "fence") c.fence++;
    if (bad === "owner") c.owner = id(99);
    if (bad === "expired") await fixture.db.exec("update public.sentinel_runs set lease_until=clock_timestamp()-interval '1 second'");
    if (bad === "canceled") await fixture.db.exec("update public.sentinel_runs set status='canceled'");
    await expect(publishClaims(c)).rejects.toMatchObject({ code: "RUN_CONFLICT" }); expect(await count()).toBe(0);
  });
  it("rejects historical non-head versions and unrelated entities", async () => {
    await expect(publishClaims({ ...command(), versionIds: [seeded.id], claims: [{ ...claim(), documentVersionId: seeded.id }] }))
      .rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(publishClaims(command([{ ...claim(), entityIds: [id(99)] }]))).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
  it("accepts an existing candidate asset only in the incident", async () => {
    await fixture.db.query("insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence) values($1,$2,'Synthetic candidate','Road','Fixture','synthetic','Low')", [id(90), scope.incidentId]);
    await publishClaims(command([{ ...claim(), entityIds: [id(90)] }])); expect(await count()).toBe(1);
  });
  it.each(["quote", "hash", "utf8", "unknown", "duplicate", "support"])("SQL independently rejects malformed %s without partial persistence", async bad => {
    const c = command([claim(200), claim(201)]), b = c.claims[1] as ClaimDraft & Record<string, unknown>;
    if (bad === "quote") b.excerpt = "X".repeat(Buffer.byteLength(b.excerpt));
    if (bad === "hash") b.excerptHash = "f".repeat(64);
    if (bad === "utf8") b.excerptStart++;
    if (bad === "unknown") b.permission = "approve";
    if (bad === "support") b.support = "supported";
    if (bad === "duplicate") b.id = c.claims[0].id;
    await expect(raw(c)).rejects.toMatchObject({ code: "22023" }); expect(await count()).toBe(0);
  });
  it("retains licensed excerpts without retaining the restricted source text in command or projection", async () => {
    await restricted("excerpt_only"); const c = command(); c.transientTexts[version.id] = text;
    await publishClaims(c);
    const page = await readClaimPage(scope.incidentId, scope.mode, version.id);
    const stored = (await fixture.db.query("select payload,receipt from public.sentinel_claim_publications")).rows;
    expect(page?.items[0].claim.excerpt).toBe(c.claims[0].excerpt);
    expect(JSON.stringify(stored)).not.toContain("Longer private supporting text");
    expect(JSON.stringify(page)).not.toContain("Longer private supporting text");
    expect(version.normalizedText).toBeNull();
  });
  it("restricted citations require hash-matching transient normalized text", async () => {
    await restricted("excerpt_only"); const c = command();
    await expect(publishClaims(c)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    c.transientTexts[version.id] = "Wrong text";
    await expect(publishClaims(c)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
  it("metadata-only versions cannot publish quoted claims", async () => {
    await restricted("metadata_only"); const c = command(); c.transientTexts[version.id] = text;
    await expect(publishClaims(c)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
  it("excerpt-only permission cannot be used to reconstruct the whole source across commands", async () => {
    await restricted("excerpt_only"); const half = Math.floor(Buffer.byteLength(text) / 2);
    function part(start: number, end: number, n: number) { const excerpt = Buffer.from(text).subarray(start, end).toString();
      return { ...claim(n), excerptStart: start, excerptEnd: end, excerpt, excerptHash: evidenceHash(excerpt) }; }
    const first = command([part(0, half, 200)]); first.transientTexts[version.id] = text; await publishClaims(first);
    const second = command([part(half, Buffer.byteLength(text), 201)], id(83)); second.transientTexts[version.id] = text;
    await expect(publishClaims(second)).rejects.toMatchObject({ code: "INPUT_INVALID" }); expect(await count()).toBe(1);
  });
  it("enforces the cumulative 2 KiB excerpt cap for one version", async () => {
    const content = "A".repeat(4096); await restricted("excerpt_only", content);
    const c = command([{ ...claim(), excerptStart: 0, excerptEnd: 2049, excerpt: content.slice(0, 2049), excerptHash: evidenceHash(content.slice(0, 2049)) }]);
    c.transientTexts[version.id] = content; await expect(publishClaims(c)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
  it.each(["viewer", "analyst", "incident_commander"])("allows current %s to read the private scoped projection", async role => {
    await publishClaims(command()); await fixture.db.query("update public.organization_members set role=$1", [role]);
    identity.user = { id: actor, organizationId: scope.organizationId, role };
    expect((await readClaimPage(scope.incidentId, scope.mode, version.id))?.items).toHaveLength(1);
  });
  it("denies reads after membership revocation and returns no foreign version/mode/incident", async () => {
    await publishClaims(command());
    expect(await readClaimPage(scope.incidentId, "live", version.id)).toBeNull();
    expect(await readClaimPage(id(99), scope.mode, version.id)).toBeNull();
    expect(await readClaimPage(scope.incidentId, scope.mode, id(99))).toBeNull();
    await fixture.db.exec("delete from public.organization_members");
    await expect(readClaimPage(scope.incidentId, scope.mode, version.id)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });
  it("pages 26 append-ordered claims without duplicates or missing records", async () => {
    await publishClaims(command(Array.from({ length: 25 }, (_, i) => claim(200 + i))));
    await publishClaims(command([claim(225)], id(83)));
    const first = await readClaimPage(scope.incidentId, scope.mode, version.id);
    const second = await readClaimPage(scope.incidentId, scope.mode, version.id, first!.nextAfterSequence!);
    expect(first?.items).toHaveLength(25); expect(first?.hasMore).toBe(true); expect(second?.items).toHaveLength(1); expect(second?.hasMore).toBe(false);
    expect([...first!.items, ...second!.items].map(i => i.claim.id)).toEqual(Array.from({ length: 26 }, (_, i) => id(200 + i)));
  });
  it("pages large permitted quotes within a serialized-response byte budget", async () => {
    const largeText = "Q".repeat(100 * 1024);
    version = prepareDocumentVersion({ ...base, rawText: largeText, sourceConfigRevision: id(44) }, { id: id(102), retrievedAt: new Date().toISOString() }).version;
    generation = (await publishEvidence({ scope, runId: run.id, owner, fence: run.fence, commandId: id(84), observations: [{
      documentId: id(3), outcome: "observed", requestedAt: run.createdAt, observedBytes: largeText.length, providerRequestId: null, version,
    }] })).receipt.evidenceGeneration;
    for (let i = 0; i < 26; i++) await publishClaims(command([{ ...claim(200 + i), excerptStart: 0,
      excerptEnd: largeText.length, excerpt: largeText, excerptHash: evidenceHash(largeText) }], id(1000 + i)));
    const ids: string[] = []; let position = 0;
    do {
      const page = (await readClaimPage(scope.incidentId, scope.mode, version.id, position))!;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024);
      ids.push(...page.items.map(item => item.claim.id)); position = page.nextAfterSequence ?? 0;
    } while (position);
    expect(ids).toEqual(Array.from({ length: 26 }, (_, i) => id(200 + i)));
  });
  it("immutable claims and receipts cannot be changed or read directly by runtime roles", async () => {
    await publishClaims(command());
    for (const table of ["sentinel_claims", "sentinel_claim_publications"]) {
      await fixture.db.exec("savepoint immutable_probe");
      await expect(fixture.db.exec(`delete from public.${table}`)).rejects.toMatchObject({ code: "55000" });
      await fixture.db.exec("rollback to savepoint immutable_probe; release savepoint immutable_probe");
      await fixture.db.exec("savepoint direct_probe; set role service_role");
      await expect(fixture.db.exec(`select * from public.${table}`)).rejects.toMatchObject({ code: "42501" });
      await fixture.db.exec("rollback to savepoint direct_probe; reset role; release savepoint direct_probe");
    }
    for (const role of ["anon", "authenticated"]) {
      await fixture.db.exec(`savepoint public_probe; set role ${role}`);
      await expect(fixture.db.query("select public.sentinel_read_claims($1,$2,$3,$4,$5,0)", [actor, ...s, version.id])).rejects.toMatchObject({ code: "42501" });
      await fixture.db.exec("rollback to savepoint public_probe; reset role; release savepoint public_probe");
    }
  });
  it("rolls back inserted claims if the lease expires during persistence", async () => {
    await fixture.db.exec(`create function pause_claim_fixture() returns trigger language plpgsql as $$ begin perform pg_sleep(0.20); return new; end $$;
      create trigger delay_claim_fixture before insert on public.sentinel_claims for each row execute function pause_claim_fixture();
      update public.sentinel_runs set lease_until=clock_timestamp()+interval '0.10 seconds'`);
    await expect(publishClaims(command())).rejects.toMatchObject({ code: "RUN_CONFLICT" }); expect(await count()).toBe(0);
    expect((await fixture.db.query("select count(*)::int n from public.sentinel_claim_publications")).rows[0]).toEqual({ n: 0 });
  });
});
