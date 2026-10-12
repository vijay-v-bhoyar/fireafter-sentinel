import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion } from "./evidence";
import { readConstraints, recordConstraints } from "./constraints";
import { proposeTaskAssignments } from "./planning";
import { GET, POST } from "../../app/api/sentinel/constraints/route";
const identity = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("../auth", () => ({ getCurrentUser: async () => identity.user }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
  const keys = name === "sentinel_record_constraints" ? ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode", "p_command_id", "p_expected_revision", "p_configuration"]
    : ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode"];
  try { return { data: await fixture.rpc(name, keys.map(k => typeof args[k] === "object" && args[k] !== null ? JSON.stringify(args[k]) : args[k])), error: null }; }
  catch (error) { return { data: null, error }; }
} }) }));
const id = (n: number) => `98000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const }, actor = id(9);
const seeded = prepareDocumentVersion({ scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Synthetic county", jurisdiction: "Fixture county", canonicalUrl: "https://example.gov/notice",
  rawText: "Synthetic source.", publishedAt: null, effectiveFrom: null, effectiveUntil: null, availability: "available", contentPermission: "full_text" }, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 8, minutes)).toISOString();
function configuration() { return { schemaVersion: 1, shift: { startsAt: at(0), endsAt: at(480) }, inputBasis: "demo",
  crews: [{ id: id(10), label: "Demo crew", capabilities: ["road"], availableFrom: at(0), availableUntil: at(480) }],
  tasks: [1, 2, 3].map(n => ({ id: id(20 + n), assetId: id(100 + n), label: `Demo inspection ${n}`, taskType: "inspection", requiredCapability: "road",
    durationMinutes: 60, travelMinutes: 15, windowFrom: at(0), windowUntil: at(480), priority: n })) }; }
function command() { return { incidentId: scope.incidentId, mode: scope.mode, commandId: id(40), expectedConstraintRevision: null as string | null, configuration: configuration() }; }
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  await fixture.db.exec("begin"); await fixture.seed(seeded, actor, "analyst"); identity.user = { id: actor, organizationId: scope.organizationId, role: "analyst" };
  for (let n = 1; n <= 3; n++) await fixture.db.query("insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence) values($1,$2,$3,'road','Fixture','synthetic','High')", [id(100 + n), scope.incidentId, `Synthetic asset ${n}`]);
});
afterEach(async () => { await fixture.db.exec("rollback"); }); afterAll(async () => { await fixture?.close(); });
async function state() { return (await fixture.db.query<{ evidence_generation: number; unresolved_source_change_count: number; current_constraint_revision: string | null }>("select evidence_generation,unresolved_source_change_count,current_constraint_revision from public.sentinel_incident_state")).rows[0]; }
async function raw(config: unknown, expected: string | null = null, commandId = id(40)) { return fixture.rpc("sentinel_record_constraints", [actor, scope.organizationId, scope.incidentId, scope.mode, commandId, expected, JSON.stringify(config)]); }
describe("Scoped immutable constraints through real helpers, HTTP and exact SQL", () => {
  it("stores authored inputs, scopes identity and advances the proposal fence", async () => {
    const result = await recordConstraints(command()); expect(result).toMatchObject({ replayed: false, revision: { scope, createdBy: actor, configuration: { inputBasis: "demo" } },
      receipt: { changed: true, previousRevisionId: null, evidenceGeneration: 1, unresolvedSourceChanges: 0 } });
    expect(result.revision.id).toBe(result.receipt.revisionId); expect(result.revision.createdAt).toBe(result.receipt.committedAt);
    expect((await state()).current_constraint_revision).toBe(result.revision.id);
    const read = await readConstraints(scope.incidentId, scope.mode); expect(read?.revision).toEqual(result.revision); expect(proposeTaskAssignments(read?.revision?.configuration).status).toBe("feasible");
  });
  it("returns explicit unconfigured constraints separately from an unavailable incident", async () => {
    expect(await readConstraints(scope.incidentId, scope.mode)).toMatchObject({ revision: null }); expect(await readConstraints(id(999), scope.mode)).toBeNull();
  });
  it("replays an old receipt after a later revision without reactivating it", async () => {
    const c = command(), first = await recordConstraints(c); const config = configuration(); config.tasks[0].durationMinutes = 90;
    const second = await recordConstraints({ ...c, commandId: id(41), expectedConstraintRevision: first.revision.id, configuration: config });
    expect(await recordConstraints(c)).toEqual({ ...first, replayed: true }); expect((await readConstraints(scope.incidentId, scope.mode))?.revision?.id).toBe(second.revision.id);
    await expect(recordConstraints({ ...c, configuration: config })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" }); expect((await state()).evidence_generation).toBe(2);
  });
  it("records a semantic no-op command without bumping generation or duplicating content", async () => {
    const first = await recordConstraints(command()); const config = configuration(); config.tasks.reverse();
    const result = await recordConstraints({ ...command(), commandId: id(41), expectedConstraintRevision: first.revision.id, configuration: config });
    expect(result.receipt).toMatchObject({ changed: false, revisionId: first.revision.id, evidenceGeneration: 1 }); expect(result.revision).toEqual(first.revision);
    expect((await fixture.db.query<{ n: number }>("select count(*)::int n from public.sentinel_constraints")).rows[0].n).toBe(1);
  });
  it("rejects stale revisions even when the proposed payload is otherwise valid", async () => {
    await recordConstraints(command()); await expect(recordConstraints({ ...command(), commandId: id(41) })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  });
  it.each(["viewer", "deleted"])("fresh SQL membership denies %s writes and replay", async role => {
    const c = command(); await recordConstraints(c); await fixture.db.exec(role === "deleted" ? "delete from public.organization_members" : "update public.organization_members set role='viewer'");
    await expect(recordConstraints(c)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });
  it.each(["viewer", "analyst", "incident_commander"])("permits current %s scoped reads", async role => {
    await recordConstraints(command()); await fixture.db.query("update public.organization_members set role=$1", [role]); expect((await readConstraints(scope.incidentId, scope.mode))?.revision).not.toBeNull();
  });
  it("denies revoked reads and cross-organization writes", async () => {
    identity.user = { id: actor, organizationId: id(999), role: "analyst" }; await expect(recordConstraints(command())).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    identity.user = { id: actor, organizationId: scope.organizationId, role: "analyst" }; await fixture.db.exec("delete from public.organization_members"); await expect(readConstraints(scope.incidentId, scope.mode)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });
  it("preserves null estimates rather than substituting zero or omitting tasks", async () => {
    const config = configuration() as unknown as Record<string, unknown>; const tasks = config.tasks as Array<Record<string, unknown>>; tasks[0].durationMinutes = null;
    const result = await recordConstraints({ ...command(), configuration: config }); expect(result.revision.configuration.tasks[0].durationMinutes).toBeNull();
    const proposal = proposeTaskAssignments(result.revision.configuration); expect(proposal.status).toBe("incomplete"); expect(proposal.selectedTaskIds).toHaveLength(3);
  });
  it("rejects current missing/foreign task asset references atomically", async () => {
    const config = configuration(); config.tasks[0].assetId = id(999); await expect(raw(config)).rejects.toMatchObject({ code: "42501" }); expect((await state()).current_constraint_revision).toBeNull();
  });
  it.each(["tooManyTasks", "tooManyCrews", "longShift", "badCapability", "negativeTravel", "zeroDuration", "badDate", "verifiedBasis", "extraActor", "duplicateTask"])("SQL rejects raw %s", async key => {
    const config = configuration();
    if (key === "tooManyTasks") config.tasks = Array.from({ length: 11 }, (_, i) => ({ ...config.tasks[0], id: id(50 + i) }));
    else if (key === "tooManyCrews") config.crews = Array.from({ length: 3 }, (_, i) => ({ ...config.crews[0], id: id(10 + i) }));
    else if (key === "longShift") config.shift.endsAt = at(481);
    else if (key === "badCapability") config.crews[0].capabilities = ["fetch_url()"];
    else if (key === "negativeTravel") config.tasks[0].travelMinutes = -1;
    else if (key === "zeroDuration") config.tasks[0].durationMinutes = 0;
    else if (key === "badDate") config.shift.startsAt = "2026-02-31T08:00:00Z";
    else if (key === "verifiedBasis") config.inputBasis = "agency_verified";
    else if (key === "extraActor") (config as unknown as Record<string, unknown>).actorId = actor;
    else config.tasks.push(config.tasks[0]);
    await expect(raw(config)).rejects.toMatchObject({ code: "22023" }); expect((await state()).evidence_generation).toBe(0);
  });
  it("initializes a fresh owned incident/mode without borrowing an old mode's constraints", async () => {
    const result = await recordConstraints({ ...command(), mode: "replay" }); expect(result.revision.scope.mode).toBe("replay"); expect((await readConstraints(scope.incidentId, "synthetic"))?.revision).toBeNull();
  });
  it("rolls back pointer/generation/revision when command receipt persistence fails", async () => {
    await fixture.db.exec("create function public.fail_constraint_receipt() returns trigger language plpgsql as $$ begin raise exception 'synthetic receipt failure';end $$;create trigger receipt_fail before insert on public.sentinel_constraint_commands for each row execute function public.fail_constraint_receipt()");
    await expect(recordConstraints(command())).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" }); expect((await state()).evidence_generation).toBe(0);
    expect((await fixture.db.query<{ n: number }>("select count(*)::int n from public.sentinel_constraints")).rows[0].n).toBe(0);
  });
  it("HTTP saves/reads exact constraints with private response headers", async () => {
    const url = "https://sentinel.example/api/sentinel/constraints"; const response = await POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command()) }));
    expect(response.status).toBe(200); const result = await response.json(); const read = await GET(new Request(`${url}?incidentId=${scope.incidentId}&mode=synthetic`)); expect(read.status).toBe(200);
    const page = await read.json(); expect(page.revision).toEqual(result.revision); expect(page.assessmentScope).toBe("authored_constraints_only");
    expect(page.allocation.status).toBe("feasible"); expect(page.allocation.assignments).toHaveLength(3);
    expect(read.headers.get("cache-control")).toBe("private, no-store"); expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: JSON.stringify(command()) }))).status).toBe(403);
    expect((await POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...command(), actorId: actor }) }))).status).toBe(400);
  });
  it("denies raw service-role access and updates/deletes of immutable inputs", async () => {
    await recordConstraints(command());
    for (const query of ["update public.sentinel_constraints set constraint_hash=repeat('a',64)", "delete from public.sentinel_constraints", "delete from public.sentinel_constraint_commands"]) {
      await fixture.db.exec("savepoint immutable_constraint"); await expect(fixture.db.exec(query)).rejects.toBeDefined(); await fixture.db.exec("rollback to savepoint immutable_constraint;release savepoint immutable_constraint");
    }
    await fixture.db.exec("savepoint service_constraint;set role service_role"); await expect(fixture.db.exec("select * from public.sentinel_constraints")).rejects.toMatchObject({ code: "42501" }); await fixture.db.exec("rollback to savepoint service_constraint;reset role;release savepoint service_constraint");
  });
});
