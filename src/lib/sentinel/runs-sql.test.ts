import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion } from "./evidence";

const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = id(9), owner = id(10), scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const observation = {
  scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Synthetic county", jurisdiction: "Fixture county",
  canonicalUrl: "https://example.gov/fixture", rawText: "Synthetic notice", publishedAt: null, effectiveFrom: null, effectiveUntil: null,
  availability: "available", contentPermission: "full_text",
};
const version = prepareDocumentVersion(observation, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
type Run = { id: string; status: string; stage: string; createdAt: string; deadlineAt: string; dispatchId: string; fence: number; leaseUntil: string | null;
  usage: { tavilyRequests: number; modelRequests: number; inputTokens: number; outputTokens: number } };
type Command = { run: Run; receipt: Record<string, string>; replayed: boolean };
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  await fixture.db.exec("begin"); await fixture.seed(version, actor, "analyst");
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1", [version.sourceConfigRevision]);
});
afterEach(async () => { await fixture.db.exec("rollback"); });
afterAll(async () => { await fixture?.close(); });
const s = [scope.organizationId, scope.incidentId, scope.mode];
const admit = (command = id(11), actorId = actor, config = version.sourceConfigRevision) =>
  fixture.rpc<Command>("sentinel_admit_run", [actorId, ...s, config, command]);
const acquire = (run: Run, worker = owner) => fixture.rpc<{ run: Run; owner: string }>("sentinel_acquire_run_lease", [...s, run.id, worker]);
const reserve = (run: Run, attempt: string, kind = "model", input = 100, output = 100, worker = owner, fence = run.fence) =>
  fixture.rpc<{ attemptId: string; dispatchAllowed: boolean; dispatchDeadline: string }>("sentinel_reserve_provider_attempt", [...s, run.id, worker, fence, attempt, "extract", kind, input, output]);
const settle = (run: Run, attempt: string, state = "completed", input: number | null = 50, output: number | null = 50, bytes: number | null = 100) =>
  fixture.rpc("sentinel_settle_provider_attempt", [...s, run.id, owner, run.fence, attempt, state, input, output, bytes]);
const checkpoint = (run: Run, key: string, state = "interpreting", hash = "a".repeat(64)) =>
  fixture.rpc<Run>("sentinel_checkpoint_run", [...s, run.id, owner, run.fence, key, state, "extracted", hash]);
const read = (run: Run, actorId = actor) => fixture.rpc<Run>("sentinel_read_run", [actorId, ...s, run.id]);
const cancel = (run: Run, key = id(70), actorId = actor) => fixture.rpc<Command>("sentinel_cancel_run", [actorId, ...s, run.id, key]);

describe("Applied durable Sentinel run foundation (embedded PostgreSQL, not a hosted race test)", () => {
  it("atomically admits one run and command receipt with a fixed deadline/dispatch identity", async () => {
    const result = await admit();
    expect(result.replayed).toBe(false); expect(result.run.dispatchId).toBe(result.run.id);
    expect(Date.parse(result.run.deadlineAt) - Date.parse(result.run.createdAt)).toBe(120_000);
    expect(result.run.usage).toEqual({ tavilyRequests: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0 });
    const counts = (await fixture.db.query<{ runs: number; commands: number }>(`select
      (select count(*)::int from public.sentinel_runs) as runs,(select count(*)::int from public.sentinel_run_commands) as commands`)).rows[0];
    expect(counts).toEqual({ runs: 1, commands: 1 });
  });
  it("replays exactly once without renewing deadline or accepting a changed payload", async () => {
    const first = await admit(); const replay = await admit();
    expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.receipt); expect(replay.run).toEqual(first.run);
    await expect(admit(id(11), actor, id(99))).rejects.toMatchObject({ code: "23505" });
    expect((await fixture.db.query("select * from public.sentinel_runs")).rows).toHaveLength(1);
  });
  it("denies viewer, revoked membership, missing state and stale configuration", async () => {
    await fixture.db.query("update public.organization_members set role='viewer'");
    await expect(admit()).rejects.toMatchObject({ code: "42501" });
    await fixture.db.query("update public.organization_members set role='analyst'");
    await expect(admit(id(11), actor, id(99))).rejects.toMatchObject({ code: "40001" });
    await expect(fixture.rpc("sentinel_admit_run", [actor, scope.organizationId, id(99), scope.mode, id(4), id(11)])).rejects.toMatchObject({ code: "42501" });
    await fixture.db.query("delete from public.organization_members");
    await expect(admit()).rejects.toMatchObject({ code: "42501" });
    expect((await fixture.db.query("select * from public.sentinel_runs")).rows).toHaveLength(0);
  });
  it("allows one active run per incident and denies same incident across modes", async () => {
    await admit(); await expect(admit(id(12))).rejects.toMatchObject({ code: "55P03" });
    await fixture.db.query("insert into public.sentinel_incident_state(organization_id,incident_id,mode) values($1,$2,'replay')", s.slice(0, 2));
    await fixture.db.query(`insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by)
      values($1,$2,$3,'replay','{}',$4,$5)`, [id(40), scope.organizationId, scope.incidentId, "b".repeat(64), actor]);
    await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1 where mode='replay'", [id(40)]);
    await expect(fixture.rpc("sentinel_admit_run", [actor, scope.organizationId, scope.incidentId, "replay", id(40), id(41)])).rejects.toMatchObject({ code: "55P03" });
  });
  it("retains history when replacing a deadline-expired run", async () => {
    const { run } = await admit();
    const createdAt = new Date(Date.now() - 121_000).toISOString();
    await fixture.db.query("update public.sentinel_runs set created_at=$1,deadline_at=$2", [createdAt, new Date(Date.parse(createdAt) + 120_000).toISOString()]);
    const replacement = await admit(id(12)); expect(replacement.run.id).not.toBe(run.id);
    const historical = await read(run); expect(historical.status).toBe("failed"); expect(historical.fence).toBe(1);
    expect((await fixture.db.query("select * from public.sentinel_run_commands")).rows).toHaveLength(2);
  });
  it("acquires a monotonically fenced lease and preserves it on same-owner retries", async () => {
    const first = await acquire((await admit()).run); const again = await acquire(first.run);
    expect(first.run.fence).toBe(1); expect(again.run).toEqual(first.run); expect(again.owner).toBe(owner);
    await expect(acquire(first.run, id(21))).rejects.toMatchObject({ code: "55P03" });
    await reserve(first.run, id(30));
    await fixture.db.exec("update public.sentinel_runs set lease_until=clock_timestamp()-interval '1 second'");
    const taken = await acquire(first.run, id(21));
    expect(taken.run.fence).toBe(2); expect(taken.run.deadlineAt).toBe(first.run.deadlineAt);
    expect(taken.run.usage.modelRequests).toBe(1);
    await expect(checkpoint(first.run, id(50))).rejects.toMatchObject({ code: "40001" });
  });
  it("rechecks the original actor's membership on every worker action", async () => {
    const { run } = await acquire((await admit()).run);
    await fixture.db.query("delete from public.organization_members");
    await expect(reserve(run, id(30))).rejects.toMatchObject({ code: "42501" });
    await expect(checkpoint(run, id(50))).rejects.toMatchObject({ code: "42501" });
    await expect(acquire(run)).rejects.toMatchObject({ code: "42501" });
  });
  it("renews only a current worker within the original deadline and usage", async () => {
    const { run } = await acquire((await admit()).run); await reserve(run, id(30));
    await fixture.db.exec("update public.sentinel_runs set lease_until=date_trunc('milliseconds',clock_timestamp())+interval '1 second'");
    const renewed = await fixture.rpc<{ run: Run }>("sentinel_renew_run_lease", [...s, run.id, owner, run.fence]);
    expect(renewed.run.deadlineAt).toBe(run.deadlineAt); expect(renewed.run.fence).toBe(run.fence);
    expect(renewed.run.usage.modelRequests).toBe(1); expect(Date.parse(renewed.run.leaseUntil!) - Date.now()).toBeGreaterThan(20_000);
    await expect(fixture.rpc("sentinel_renew_run_lease", [...s, run.id, id(99), run.fence])).rejects.toMatchObject({ code: "40001" });
    await fixture.db.exec("update public.sentinel_runs set lease_until=clock_timestamp()-interval '1 second'");
    await expect(fixture.rpc("sentinel_renew_run_lease", [...s, run.id, owner, run.fence])).rejects.toMatchObject({ code: "40001" });
  });
  it("rejects cross-mode, cross-incident and cross-organization run operations", async () => {
    const { run } = await admit();
    for (const wrong of [[id(99), scope.incidentId, scope.mode], [scope.organizationId, id(99), scope.mode], [scope.organizationId, scope.incidentId, "live"]]) {
      await expect(fixture.rpc("sentinel_acquire_run_lease", [...wrong, run.id, owner])).rejects.toMatchObject({ code: "42501" });
    }
    expect(await fixture.rpc("sentinel_read_run", [actor, scope.organizationId, id(99), scope.mode, run.id])).toBeNull();
    expect(await fixture.rpc("sentinel_read_run", [actor, scope.organizationId, scope.incidentId, "live", run.id])).toBeNull();
  });
  it("never redispatches an already reserved attempt after a lost response", async () => {
    const { run } = await acquire((await admit()).run); const first = await reserve(run, id(30));
    expect(first.dispatchAllowed).toBe(true);
    expect((await reserve(run, id(30))).dispatchAllowed).toBe(false);
    await expect(reserve(run, id(30), "model", 101)).rejects.toMatchObject({ code: "23505" });
    expect((await read(run)).usage.modelRequests).toBe(1);
  });
  it("retains uncertain reservations and prevents parallel-capacity reset", async () => {
    const { run } = await acquire((await admit()).run);
    await reserve(run, id(30)); await reserve(run, id(31));
    await settle(run, id(30), "uncertain", null, null, null);
    await expect(reserve(run, id(32))).rejects.toMatchObject({ code: "55P03" });
    await settle(run, id(31));
    await reserve(run, id(32));
    const usage = (await read(run)).usage;
    expect(usage).toEqual({ tavilyRequests: 0, modelRequests: 3, inputTokens: 300, outputTokens: 300 });
  });
  it.each(["tavily", "model"])("enforces the cumulative %s attempt cap including completed calls", async kind => {
    const { run } = await acquire((await admit()).run); const limit = kind === "tavily" ? 4 : 8;
    for (let n = 0; n < limit; n++) { await reserve(run, id(30 + n), kind, 0, 0); await settle(run, id(30 + n), "completed", 0, 0, 1); }
    await expect(reserve(run, id(40), kind, 0, 0)).rejects.toMatchObject({ code: "54000" });
    expect((await read(run)).usage[kind === "tavily" ? "tavilyRequests" : "modelRequests"]).toBe(limit);
  });
  it("rejects aggregate token overflow and does not refund settled usage", async () => {
    const { run } = await acquire((await admit()).run);
    await reserve(run, id(30), "model", 24000, 1000); await settle(run, id(30), "completed", 100, 100, 10);
    await expect(reserve(run, id(31), "model", 1, 0)).rejects.toMatchObject({ code: "54000" });
    expect((await read(run)).usage.inputTokens).toBe(24000);
  });
  it("enforces reserved output totals across otherwise affordable model requests", async () => {
    const { run } = await acquire((await admit()).run);
    for (let n = 0; n < 6; n++) { await reserve(run, id(30 + n), "model", 0, 1000); await settle(run, id(30 + n), "completed", 0, 1, 10); }
    await expect(reserve(run, id(40), "model", 0, 1)).rejects.toMatchObject({ code: "54000" });
    expect((await read(run)).usage.outputTokens).toBe(6000);
  });
  it("applies the two-request capacity across incidents, including canceled uncertain attempts", async () => {
    const first = (await acquire((await admit()).run)).run;
    await reserve(first, id(30)); await reserve(first, id(31)); await cancel(first);
    const otherScope = { ...scope, incidentId: id(22) };
    const otherVersion = prepareDocumentVersion({ ...observation, scope: otherScope, documentId: id(23), sourceConfigRevision: id(24),
      rawText: "Second synthetic notice" }, { id: id(25), retrievedAt: version.retrievedAt }).version;
    await fixture.seed(otherVersion, actor, "analyst");
    await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1 where incident_id=$2", [id(24), id(22)]);
    const other = [scope.organizationId, id(22), scope.mode];
    const admitted = await fixture.rpc<Command>("sentinel_admit_run", [actor, ...other, id(24), id(26)]);
    const leased = await fixture.rpc<{ run: Run }>("sentinel_acquire_run_lease", [...other, admitted.run.id, owner]);
    const parameters = [...other, leased.run.id, owner, leased.run.fence, id(32), "extract", "model", 100, 100];
    await expect(fixture.rpc("sentinel_reserve_provider_attempt", parameters)).rejects.toMatchObject({ code: "55P03" });
    const expired = new Date(Date.now() - 1000).toISOString();
    await fixture.db.query("update public.sentinel_provider_reservations set reserved_at=$1,dispatch_deadline=$2 where id=$3", [new Date(Date.parse(expired) - 1000).toISOString(), expired, id(30)]);
    expect(await fixture.rpc("sentinel_reserve_provider_attempt", parameters)).toMatchObject({ dispatchAllowed: true });
    expect((await read(first)).usage.modelRequests).toBe(2);
  });
  it("rejects stale source configuration at lease, reservation and checkpoint boundaries", async () => {
    const { run } = await acquire((await admit()).run);
    await fixture.db.exec("update public.sentinel_incident_state set current_source_config_revision=null");
    await expect(acquire(run)).rejects.toMatchObject({ code: "40001" });
    await expect(reserve(run, id(30))).rejects.toMatchObject({ code: "40001" });
    await expect(checkpoint(run, id(50))).rejects.toMatchObject({ code: "40001" });
  });
  it("denies expired attempt results even if the current run lease is valid", async () => {
    const { run } = await acquire((await admit()).run); await reserve(run, id(30));
    await fixture.db.exec("update public.sentinel_provider_reservations set reserved_at=clock_timestamp()-interval '2 seconds',dispatch_deadline=clock_timestamp()-interval '1 second'");
    await expect(settle(run, id(30))).rejects.toMatchObject({ code: "40001" });
    expect((await read(run)).usage.modelRequests).toBe(1);
  });
  it("rejects invalid reservation/settlement input and contradictory usage replay", async () => {
    const { run } = await acquire((await admit()).run);
    await expect(reserve(run, id(30), "tavily", 1, 0)).rejects.toMatchObject({ code: "22023" });
    await expect(reserve(run, id(30), "model", 1, 1001)).rejects.toMatchObject({ code: "22023" });
    await reserve(run, id(30));
    await expect(settle(run, id(30), "completed", 101)).rejects.toMatchObject({ code: "22023" });
    await expect(settle(run, id(30), "completed", 50, 50, 1048577)).rejects.toMatchObject({ code: "22023" });
    await settle(run, id(30)); await settle(run, id(30));
    await expect(settle(run, id(30), "completed", 49)).rejects.toMatchObject({ code: "23505" });
    await expect(settle(run, id(30), "uncertain", null, null, null)).rejects.toMatchObject({ code: "23505" });
  });
  it("persists ordered checkpoints and resumes original stage without duplicate publication", async () => {
    const { run } = await acquire((await admit()).run);
    await expect(checkpoint(run, id(50), "validating")).rejects.toMatchObject({ code: "40001" });
    await checkpoint(run, id(50)); await checkpoint(run, id(50));
    await expect(checkpoint(run, id(50), "interpreting", "b".repeat(64))).rejects.toMatchObject({ code: "23505" });
    const next = await checkpoint(run, id(51), "validating"); expect(next.status).toBe("validating");
    await expect(checkpoint(next, id(52), "completed")).rejects.toMatchObject({ code: "22023" });
    await fixture.db.exec("update public.sentinel_runs set lease_until=clock_timestamp()-interval '1 second'");
    expect((await acquire(next, id(21))).run.status).toBe("validating");
    expect((await fixture.db.query("select * from public.sentinel_run_checkpoints")).rows).toHaveLength(2);
  });
  it("cancellation atomically fences late workers and retains the original command receipt", async () => {
    const { run } = await acquire((await admit()).run); await reserve(run, id(30));
    const stopped = await cancel(run); const again = await cancel(run);
    expect(stopped.run.status).toBe("canceled"); expect(stopped.run.fence).toBe(run.fence + 1);
    expect(again.receipt).toEqual(stopped.receipt); expect(again.replayed).toBe(true);
    await expect(checkpoint(run, id(50))).rejects.toMatchObject({ code: "40001" });
    await expect(settle(run, id(30))).rejects.toMatchObject({ code: "40001" });
    await expect(cancel(run, id(11))).rejects.toMatchObject({ code: "23505" });
    expect((await admit(id(12))).run.id).not.toBe(run.id);
    expect((await fixture.db.query("select * from public.sentinel_provider_reservations")).rows).toHaveLength(1);
  });
  it("provides viewer status reads without exposing worker nonce", async () => {
    const { run } = await acquire((await admit()).run);
    await fixture.db.query("update public.organization_members set role='viewer'");
    const result = await read(run); expect(result.id).toBe(run.id);
    expect(result).not.toHaveProperty("owner"); expect(result).not.toHaveProperty("lease_owner");
    await expect(cancel(run)).rejects.toMatchObject({ code: "42501" });
  });
  it("requires the creator or a current commander to cancel, and rechecks authorization on receipt replay", async () => {
    const { run } = await admit();
    await fixture.db.query("insert into auth.users(id) values($1)", [id(20)]);
    await fixture.db.query("insert into public.organization_members(organization_id,user_id,role) values($1,$2,'analyst')", [scope.organizationId, id(20)]);
    await expect(cancel(run, id(71), id(20))).rejects.toMatchObject({ code: "42501" });
    await fixture.db.query("update public.organization_members set role='incident_commander' where user_id=$1", [id(20)]);
    expect((await cancel(run, id(71), id(20))).run.status).toBe("canceled");
    await fixture.db.query("delete from public.organization_members where user_id=$1", [id(20)]);
    await expect(cancel(run, id(71), id(20))).rejects.toMatchObject({ code: "42501" });
  });
  it.each(["sentinel_run_commands", "sentinel_run_checkpoints"])("owner cannot rewrite the retained %s history", async table => {
    const { run } = await acquire((await admit()).run); await checkpoint(run, id(50));
    await expect(fixture.db.exec(`update public.${table} set id=id`)).rejects.toMatchObject({ code: "55000" });
  });
  it.each(["sentinel_org_runtime", "sentinel_runs", "sentinel_run_commands", "sentinel_provider_reservations", "sentinel_run_checkpoints"])("%s grants no raw runtime writes or reads", async table => {
    const grants = await fixture.db.query<{ allowed: boolean }>("select has_table_privilege('service_role',$1,'SELECT,INSERT,UPDATE,DELETE') as allowed", [`public.${table}`]);
    expect(grants.rows[0].allowed).toBe(false);
  });
  it.each(["anon", "authenticated"])("%s cannot admit a run", async role => {
    const grants = await fixture.db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.sentinel_admit_run(uuid,uuid,uuid,text,uuid,uuid)','EXECUTE') as allowed", [role]);
    expect(grants.rows[0].allowed).toBe(false);
  });
});
