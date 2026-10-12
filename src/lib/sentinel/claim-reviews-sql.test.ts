import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion, evidenceHash } from "./evidence";
import { publishEvidence } from "./publication";
import { publishClaims } from "./claims";
import { recordClaimReview, readClaimReview } from "./claim-reviews";
import { readFeedbackForEvaluation } from "./feedback";
import { GET, POST } from "../../app/api/sentinel/claims/[id]/review/route";
const identity = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("../auth", () => ({ getCurrentUser: async () => identity.user }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
  const keys = name === "sentinel_read_feedback_for_evaluation" ? ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode", "p_feedback_id", "p_destination", "p_retention_revision"]
    : name === "sentinel_record_claim_review" ? ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode", "p_claim_id", "p_command_id", "p_review"]
    : name === "sentinel_read_claim_review" ? ["p_actor_id", "p_organization_id", "p_incident_id", "p_mode", "p_claim_id"]
      : name === "sentinel_publish_claims" ? ["p_organization_id", "p_incident_id", "p_mode", "p_run_id", "p_owner", "p_fence", "p_command_id", "p_expected_generation", "p_version_ids", "p_claims", "p_transient_texts"]
        : ["p_organization_id", "p_incident_id", "p_mode", "p_run_id", "p_owner", "p_fence", "p_command_id", "p_observations"];
  try { return { data: await fixture.rpc(name, keys.map(k => typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])), error: null }; }
  catch (error) { return { data: null, error }; }
} }) }));
const id = (n: number) => `91000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const }, actor = id(9), owner = id(10);
const s = [scope.organizationId, scope.incidentId, scope.mode] as const;
const base = { scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Synthetic county", jurisdiction: "Fixture county",
  canonicalUrl: "https://example.gov/notice", rawText: "Synthetic road closes today. More retained supporting text.", publishedAt: null,
  effectiveFrom: null, effectiveUntil: null, availability: "available", contentPermission: "full_text" };
const seeded = prepareDocumentVersion(base, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
let generation: number, version: typeof seeded;
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  await fixture.db.exec("begin"); await fixture.seed(seeded, actor, "analyst");
  identity.user = { id: actor, organizationId: scope.organizationId, role: "analyst" };
  await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)",
    [id(44), ...s, JSON.stringify({ schemaVersion: 1, sources: [{ documentId: id(3), documentKey: id(3), canonicalUrl: base.canonicalUrl,
      issuer: base.issuer, jurisdiction: base.jurisdiction, contentPermission: "full_text" }] }), "a".repeat(64), actor]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1", [id(44)]);
  const admitted = await fixture.rpc<{ run: { id: string; fence: number; createdAt: string } }>("sentinel_admit_run", [actor, ...s, id(44), id(11)]);
  const run = (await fixture.rpc<typeof admitted>("sentinel_acquire_run_lease", [...s, admitted.run.id, owner])).run;
  version = prepareDocumentVersion({ ...base, sourceConfigRevision: id(44) }, { id: id(100), retrievedAt: new Date().toISOString() }).version;
  generation = (await publishEvidence({ scope, runId: run.id, owner, fence: run.fence, commandId: id(80), observations: [{
    documentId: id(3), outcome: "observed", requestedAt: run.createdAt, observedBytes: Buffer.byteLength(base.rawText), providerRequestId: null, version,
  }] })).receipt.evidenceGeneration;
  await fixture.db.query("insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence) values($1,$2,'Synthetic road','road','Fixture','synthetic','High')", [id(500), scope.incidentId]);
  await publishClaims({ scope, runId: run.id, owner, fence: run.fence, commandId: id(81), expectedEvidenceGeneration: generation,
    versionIds: [version.id], claims: [{ id: id(200), documentVersionId: version.id, excerptStart: 0, excerptEnd: 27,
      excerpt: "Synthetic road closes today", excerptHash: evidenceHash("Synthetic road closes today"), kind: "road_status",
      claimText: "Synthetic road closes today", entityIds: [id(500)], modelVersion: "synthetic", promptVersion: "synthetic" }] });
});
afterEach(async () => { await fixture.db.exec("rollback"); });
afterAll(async () => { await fixture?.close(); });
function command() { return { incidentId: scope.incidentId, mode: scope.mode, claimId: id(200), commandId: id(300), expectedEvidenceGeneration: generation,
  expectedReviewId: null as string | null, support: "supported" as const, applicability: "applicable" as const,
  provenance: "verified" as const, conflict: "clear" as const, note: "Reviewed synthetic source; no operational approval." }; }
async function raw(payload: Record<string, unknown>, commandId = id(300)) {
  return fixture.rpc("sentinel_record_claim_review", [actor, ...s, id(200), commandId, JSON.stringify(payload)]);
}
function payload() { const c = command(); return { expectedEvidenceGeneration: c.expectedEvidenceGeneration, expectedReviewId: c.expectedReviewId,
  support: c.support, applicability: c.applicability, provenance: c.provenance, conflict: c.conflict, note: c.note }; }
async function state() { return (await fixture.db.query<{ evidence_generation: number; unresolved_source_change_count: number }>("select evidence_generation,unresolved_source_change_count from public.sentinel_incident_state")).rows[0]; }
const context = () => ({ params: Promise.resolve({ id: id(200) }) });
const url = `https://sentinel.example/api/sentinel/claims/${id(200)}/review`;
function request(body: unknown, headers: Record<string, string> = {}) { return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); }
function body() { const c = command(); return { incidentId: c.incidentId, mode: c.mode, commandId: c.commandId, ...payload() }; }

describe("Human claim reviews through authenticated helpers, HTTP and exact SQL", () => {
  it("appends a server-stamped review and advances generation without resolving a marker", async () => {
    const result = await recordClaimReview(command());
    expect(result).toMatchObject({ replayed: false, review: { claimId: id(200), actorId: actor, scope, support: "supported" },
      receipt: { commandId: id(300), previousReviewId: null, evidenceGeneration: generation + 1, unresolvedSourceChanges: 1 } });
    expect(result.review.receiptId).toBe(result.receipt.id); expect(result.review.createdAt).toBe(result.receipt.committedAt);
    expect(await state()).toEqual({ evidence_generation: generation + 1, unresolved_source_change_count: 1 });
    expect(await readClaimReview(scope.incidentId, scope.mode, id(200))).toMatchObject({ currentEvidence: true, review: result.review, receipt: result.receipt });
  });
  it("reads an unreviewed claim without declaring support", async () => {
    expect(await readClaimReview(scope.incidentId, scope.mode, id(200))).toMatchObject({ review: null, receipt: null, unresolvedSourceChanges: 1 });
  });
  it("replays the original command after later reviews without reactivating it", async () => {
    const c = command(), first = await recordClaimReview(c);
    const next = await recordClaimReview({ ...c, commandId: id(301), expectedReviewId: first.review.id, expectedEvidenceGeneration: generation + 1, support: "unsupported" });
    expect(await recordClaimReview(c)).toEqual({ ...first, replayed: true });
    expect((await readClaimReview(scope.incidentId, scope.mode, id(200)))?.review?.id).toBe(next.review.id);
    expect((await state()).evidence_generation).toBe(generation + 2);
    await expect(recordClaimReview({ ...c, note: "Changed payload" })).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
  });
  it.each(["supported", "unsupported", "unresolved"] as const)("records %s as judgment without plan or marker approval", async support => {
    const r = await recordClaimReview({ ...command(), support, applicability: "unresolved", provenance: "unresolved", conflict: "unresolved" });
    expect(r.review.support).toBe(support); expect(r.receipt.unresolvedSourceChanges).toBe(1);
  });
  it("rejects stale review identity independently of generation", async () => {
    await recordClaimReview(command());
    await expect(recordClaimReview({ ...command(), commandId: id(301), expectedEvidenceGeneration: generation + 1 })).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    expect((await fixture.db.query<{ n: number }>("select count(*)::int n from public.sentinel_claim_reviews")).rows[0].n).toBe(1);
  });
  it("rejects stale evidence even with the current review ID", async () => {
    const r = await recordClaimReview(command());
    await expect(recordClaimReview({ ...command(), commandId: id(301), expectedReviewId: r.review.id })).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
  });
  it("permits a commander review without implying a plan decision", async () => {
    await fixture.db.exec("update public.organization_members set role='incident_commander'");
    expect((await recordClaimReview(command())).receipt.unresolvedSourceChanges).toBe(1);
  });
  it("revalidates incident asset candidates after extraction", async () => {
    await fixture.db.exec("delete from public.assets");
    await expect(recordClaimReview(command())).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    expect((await state()).evidence_generation).toBe(generation);
  });
  it("rejects a second reviewer holding an obsolete revision", async () => {
    const first = await recordClaimReview(command());
    await fixture.db.query("insert into auth.users(id) values($1)", [id(90)]);
    await fixture.db.query("insert into public.organization_members(organization_id,user_id,role) values($1,$2,'analyst')", [scope.organizationId, id(90)]);
    identity.user = { id: id(90), organizationId: scope.organizationId, role: "analyst" };
    await expect(recordClaimReview({ ...command(), expectedEvidenceGeneration: generation + 1 })).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    expect((await recordClaimReview({ ...command(), expectedEvidenceGeneration: generation + 1, expectedReviewId: first.review.id })).review.actorId).toBe(id(90));
  });
  it("grants review RPCs only to the service role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const rows = (await fixture.db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.sentinel_record_claim_review(uuid,uuid,uuid,text,uuid,uuid,jsonb)','EXECUTE') allowed", [role])).rows;
      expect(rows[0].allowed).toBe(role === "service_role");
    }
  });
  it.each(["viewer", "deleted"])("fresh SQL membership rejects %s writes and replay", async role => {
    const c = command(); await recordClaimReview(c);
    await fixture.db.exec(role === "deleted" ? "delete from public.organization_members" : "update public.organization_members set role='viewer'");
    await expect(recordClaimReview(c)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(recordClaimReview({ ...c, commandId: id(301) })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });
  it.each(["viewer", "analyst", "incident_commander"])("permits private reads by current %s", async role => {
    await fixture.db.query("update public.organization_members set role=$1", [role]);
    expect(await readClaimReview(scope.incidentId, scope.mode, id(200))).toMatchObject({ claimId: id(200), review: null });
  });
  it("revoked membership cannot read despite a cached session", async () => {
    await fixture.db.exec("delete from public.organization_members");
    await expect(readClaimReview(scope.incidentId, scope.mode, id(200))).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });
  it.each([{ incidentId: id(700) }, { mode: "replay" }, { claimId: id(700) }])("does not join foreign locators %j", async locator => {
    await expect(recordClaimReview({ ...command(), ...locator })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const c = { ...command(), ...locator }; expect(await readClaimReview(c.incidentId, c.mode, c.claimId)).toBeNull();
  });
  it("rejects an organization from the session without a membership", async () => {
    identity.user = { id: actor, organizationId: id(700), role: "analyst" };
    await expect(recordClaimReview(command())).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });
  it.each(["head", "config"])("prevents a new review of stale %s evidence while preserving history", async kind => {
    const c = command(), first = await recordClaimReview(c);
    await fixture.db.exec(kind === "head" ? "delete from public.sentinel_document_heads" : "update public.sentinel_incident_state set current_source_config_revision=null");
    expect(await recordClaimReview(c)).toEqual({ ...first, replayed: true });
    await expect(recordClaimReview({ ...c, commandId: id(301), expectedReviewId: first.review.id, expectedEvidenceGeneration: generation + 1 })).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    expect(await readClaimReview(scope.incidentId, scope.mode, id(200))).toMatchObject({ currentEvidence: false, review: first.review });
  });
  it.each([{ support: "approve" }, { applicability: "yes" }, { provenance: "automatic" }, { conflict: "none" },
    { expectedEvidenceGeneration: 0.5 }, { expectedReviewId: "broken" }, { note: "x".repeat(2001) }, { actorId: actor }, { scope }, { planApproved: true }])("SQL rejects invalid raw review %j atomically", async patch => {
    await expect(raw({ ...payload(), ...patch })).rejects.toMatchObject({ code: "22023" });
    expect(await state()).toEqual({ evidence_generation: generation, unresolved_source_change_count: 1 });
  });
  it("rolls back generation when the append fails", async () => {
    await fixture.db.exec("create function public.reject_test_review() returns trigger language plpgsql as $$ begin raise exception 'injected insertion failure'; end $$; create trigger test_review_fail before insert on public.sentinel_claim_reviews for each row execute function public.reject_test_review()");
    await expect(recordClaimReview(command())).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await state()).toEqual({ evidence_generation: generation, unresolved_source_change_count: 1 });
  });
  it("denies raw service-role writes and updates/deletes of retained history", async () => {
    await recordClaimReview(command());
    await expect(fixture.db.exec("update public.sentinel_claim_reviews set body='{}'" )).rejects.toBeDefined();
    await fixture.db.exec("rollback; begin");
    await fixture.db.exec("set role service_role");
    await expect(fixture.db.exec("select * from public.sentinel_claim_reviews")).rejects.toMatchObject({ code: "42501" });
    await fixture.db.exec("rollback; begin");
  });
  it("HTTP GET and POST retain private headers and exact committed results", async () => {
    const posted = await POST(request(body()), context()); expect(posted.status).toBe(200);
    const result = await posted.json();
    const read = await GET(new Request(`${url}?incidentId=${scope.incidentId}&mode=synthetic`), context());
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ review: result.review, receipt: result.receipt });
    for (const response of [posted, read]) { expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie"); }
  });
  it.each([{ actorId: actor }, { organizationId: id(700) }, { claimId: id(700) }, { receiptId: id(700) }])("HTTP rejects caller-owned authority %j", async patch => {
    expect((await POST(request({ ...body(), ...patch }), context())).status).toBe(400);
    expect((await state()).evidence_generation).toBe(generation);
  });
  it("rejects cross-origin writes, malformed JSON, unsupported content type and oversized bodies", async () => {
    expect((await POST(request(body(), { Origin: "https://attacker.example" }), context())).status).toBe(403);
    expect((await POST(request(body(), { "Content-Type": "text/plain" }), context())).status).toBe(415);
    expect((await POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), context())).status).toBe(400);
    expect((await POST(request({ ...body(), note: "x".repeat(131072) }), context())).status).toBe(413);
  });
  it("rejects duplicate read scope, mutation query parameters and unknown scoped claims", async () => {
    expect((await GET(new Request(`${url}?incidentId=${scope.incidentId}&incidentId=${scope.incidentId}&mode=synthetic`), context())).status).toBe(400);
    expect((await POST(new Request(`${url}?organizationId=${scope.organizationId}`, { method: "POST", body: "{}" }), context())).status).toBe(400);
    expect((await GET(new Request(`${url}?incidentId=${scope.incidentId}&mode=synthetic`), { params: Promise.resolve({ id: id(700) }) })).status).toBe(404);
  });
  it("requires authentication through HTTP", async () => {
    identity.user = null;
    expect((await POST(request(body()), context())).status).toBe(401);
    expect((await GET(new Request(`${url}?incidentId=${scope.incidentId}&mode=synthetic`), context())).status).toBe(401);
  });
});

function correction() { return { schemaVersion: 1 as const, claimId: id(200), originalClaimHash: evidenceHash("Synthetic road closes today"),
  correctedClaimText: "Synthetic corrected meaning.", correctedClaimId: null as string | null, reasonCode: "unsupported_claim" as const, permissionRecordId: null as string | null }; }
async function feedbackCount() { return (await fixture.db.query<{count:number}>("select count(*)::int count from public.sentinel_feedback_observations")).rows[0].count; }
async function ownerGrant() {
  await fixture.db.query("update public.organization_members set role='incident_commander' where user_id=$1",[actor]);
  identity.user={id:actor,organizationId:scope.organizationId,role:"incident_commander"};
  await fixture.db.query(`insert into public.sentinel_permission_records(organization_id,incident_id,mode,id,data_owner_id,grantee_actor_id,purpose,destination,retention_policy_revision,authority_evidence_hash,granted_at,expires_at)
    values($1,$2,$3,$4,$5,$5,'offline_internal_evaluation','sentinel_internal_evaluation',$6,$7,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`,[...s,id(600),actor,id(601),"f".repeat(64)]);
  return id(600);
}
function evaluation(feedbackId:string) { return {incidentId:scope.incidentId,mode:scope.mode,feedbackId,destination:"sentinel_internal_evaluation",retentionPolicyRevision:id(601)}; }
describe("Optional feedback committed with claim review and owner-scoped offline permission",()=>{
 it("captures without a learning grant, preserves original claim and replays one immutable signal",async()=>{
  const c={...command(),feedback:correction()},out=await recordClaimReview(c);
  expect(out.feedback).toMatchObject({claimId:id(200),documentVersionId:version.id,claimReviewId:out.review.id,reviewDecisionId:null,receiptId:out.receipt.id,actorId:actor,permissionRecordId:null});
  expect((await recordClaimReview(c)).feedback).toEqual(out.feedback);expect(await feedbackCount()).toBe(1);
  expect((await readClaimReview(scope.incidentId,scope.mode,id(200)))?.feedback).toEqual(out.feedback);
  expect((await fixture.db.query<{text:string}>("select body->>'claimText' text from public.sentinel_claims where id=$1",[id(200)])).rows[0].text).toBe("Synthetic road closes today");
  await fixture.db.query("update public.organization_members set role='incident_commander' where user_id=$1",[actor]);identity.user={id:actor,organizationId:scope.organizationId,role:"incident_commander"};
  expect(await readFeedbackForEvaluation(evaluation(out.feedback!.id))).toBeNull();
 });
 it("rejects changed or omitted feedback on the original command and cannot retrofit a historical review",async()=>{
  const c={...command(),feedback:correction()};await recordClaimReview(c);
  await expect(recordClaimReview({...c,feedback:{...c.feedback,correctedClaimText:"Different correction"}})).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
  await expect(recordClaimReview(command())).rejects.toMatchObject({code:"REVIEW_CONFLICT"});expect(await feedbackCount()).toBe(1);
 });
 it("normal review has no signal and a retry cannot add one",async()=>{
  const out=await recordClaimReview(command());expect(out.feedback).toBeUndefined();
  await expect(recordClaimReview({...command(),feedback:correction()})).rejects.toMatchObject({code:"REVIEW_CONFLICT"});expect(await feedbackCount()).toBe(0);
 });
 for(const patch of [{claimId:id(999)},{originalClaimHash:"a".repeat(64)},{permissionRecordId:id(999)},{correctedClaimText:null,correctedClaimId:id(999)}]){
  it("rolls back review, generation and signal for an unavailable or mismatched correction reference",async()=>{
   const before=await fixture.db.query("select evidence_generation,unresolved_source_change_count from public.sentinel_incident_state");
   await expect(recordClaimReview({...command(),feedback:{...correction(),...patch}})).rejects.toBeDefined();
   expect(await feedbackCount()).toBe(0);expect((await fixture.db.query<{count:number}>("select count(*)::int count from public.sentinel_claim_reviews")).rows[0].count).toBe(0);
   expect((await fixture.db.query("select evidence_generation,unresolved_source_change_count from public.sentinel_incident_state")).rows).toEqual(before.rows);
  });
 }
 it("accepts exactly 2 KiB of UTF-8 correction, rejects bytes above it without adding another review",async()=>{
  await expect(recordClaimReview({...command(),feedback:{...correction(),correctedClaimText:"é".repeat(1025)}})).rejects.toMatchObject({code:"INPUT_INVALID"});
  const out=await recordClaimReview({...command(),feedback:{...correction(),correctedClaimText:"é".repeat(1024)}});expect(Buffer.byteLength(out.feedback!.correctedClaimText!)).toBe(2048);
 });
 it("returns permissioned input only for the exact owner grant, destination and retention version; revocation leaves reviews usable",async()=>{
  const permissionRecordId=await ownerGrant(),c={...command(),feedback:{...correction(),permissionRecordId}},out=await recordClaimReview(c),request=evaluation(out.feedback!.id);
  expect(await readFeedbackForEvaluation(request)).toEqual(out.feedback);
  expect(await readFeedbackForEvaluation({...request,retentionPolicyRevision:id(999)})).toBeNull();
  expect(await fixture.rpc("sentinel_read_feedback_for_evaluation",[actor,...s,out.feedback!.id,"wrong_destination",id(601)])).toBeNull();
  await fixture.db.query("update public.sentinel_permission_records set revoked_at=clock_timestamp() where id=$1",[permissionRecordId]);
  expect(await readFeedbackForEvaluation(request)).toBeNull();expect((await recordClaimReview(c)).feedback).toEqual(out.feedback);
  expect((await readClaimReview(scope.incidentId,scope.mode,id(200)))?.review?.id).toBe(out.review.id);
 });
 it("denies evaluation when the current SQL role is revoked despite cached commander identity",async()=>{
  const permissionRecordId=await ownerGrant(),out=await recordClaimReview({...command(),feedback:{...correction(),permissionRecordId}});
  await fixture.db.query("update public.organization_members set role='viewer' where user_id=$1",[actor]);
  await expect(readFeedbackForEvaluation(evaluation(out.feedback!.id))).rejects.toMatchObject({code:"SCOPE_DENIED"});
 });
 it("rolls back the original review if feedback storage fails",async()=>{
  await fixture.db.exec("create function public.fail_feedback() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure';end;$$;create trigger fail_feedback before insert on public.sentinel_feedback_observations for each row execute function public.fail_feedback()");
  await expect(recordClaimReview({...command(),feedback:correction()})).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
  expect(await feedbackCount()).toBe(0);expect((await fixture.db.query<{count:number}>("select count(*)::int count from public.sentinel_claim_reviews")).rows[0].count).toBe(0);
 });
 it("feedback is immutable and runtime roles cannot mint grants or bypass wrappers",async()=>{
  const out=await recordClaimReview({...command(),feedback:correction()});
  await expectDeniedSql("update public.sentinel_feedback_observations set body='{}' where id=$1",[out.feedback!.id]);
  const grants=(await fixture.db.query<{mint:boolean;read:boolean;core:boolean}>("select has_table_privilege('service_role','public.sentinel_permission_records','INSERT') mint,has_table_privilege('authenticated','public.sentinel_feedback_observations','SELECT') read,has_function_privilege('service_role','public.sentinel_record_claim_review_core(uuid,uuid,uuid,text,uuid,uuid,jsonb)','EXECUTE') core")).rows[0];
  expect(grants).toEqual({mint:false,read:false,core:false});
 });
 it("captures optional feedback through the existing private HTTP review and rejects a checkbox as grant authority",async()=>{
  const response=await POST(request({...body(),feedback:correction()}),context());expect(response.status).toBe(200);
  expect((await response.json()).feedback.claimReviewId).toBeDefined();expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect((await POST(request({...body(),feedback:{...correction(),learningPermission:true}}),context())).status).toBe(400);
 });
});

describe("Feedback storage boundaries independent of the application parser",()=>{
 for(const bad of [{...correction(),correctedClaimText:"é".repeat(1025)},{...correction(),actorId:actor},{...correction(),correctedClaimText:null},{...correction(),correctedClaimId:id(200)},{...correction(),schemaVersion:2},{...correction(),permissionRecordId:42}]) {
  it("raw SQL rejects malformed feedback before a review is committed",async()=>{
   await expect(raw({...payload(),feedback:bad})).rejects.toMatchObject({code:"22023"});expect(await feedbackCount()).toBe(0);
   expect((await fixture.db.query<{count:number}>("select count(*)::int count from public.sentinel_claim_reviews")).rows[0].count).toBe(0);
  });
 }
 it("supports an immutable corrected-claim reference from the same source version without rewriting either claim",async()=>{
  await fixture.db.query("insert into public.sentinel_claims(organization_id,incident_id,mode,id,document_version_id,run_id,publication_command_id,excerpt_start,excerpt_end,excerpt,body,created_at) select organization_id,incident_id,mode,$1::uuid,document_version_id,run_id,publication_command_id,excerpt_start,excerpt_end,excerpt,body||jsonb_build_object('id',$1::uuid::text,'claimText','Corrected synthetic assertion'),created_at from public.sentinel_claims where id=$2",[id(201),id(200)]);
  const out=await recordClaimReview({...command(),feedback:{...correction(),correctedClaimText:null,correctedClaimId:id(201)}});
  expect(out.feedback?.correctedClaimId).toBe(id(201));expect(out.feedback?.correctedClaimText).toBeNull();
 });
 for(const timing of ["expired","future"]){it(`excludes ${timing} grants while preserving ordinary feedback capture`,async()=>{
  await ownerGrant();await fixture.db.query(`insert into public.sentinel_permission_records select organization_id,incident_id,mode,$1,data_owner_id,grantee_actor_id,purpose,destination,retention_policy_revision,authority_evidence_hash,
   clock_timestamp()+($2::text)::interval,clock_timestamp()+($3::text)::interval,null from public.sentinel_permission_records where id=$4`,[id(610),timing==="expired"?"-2 hours":"1 hour",timing==="expired"?"-1 hour":"2 hours",id(600)]);
  const out=await recordClaimReview({...command(),feedback:{...correction(),permissionRecordId:id(610)}});expect(await readFeedbackForEvaluation(evaluation(out.feedback!.id))).toBeNull();
 });}
 it("a grant cannot be expanded, unrevoked or deleted",async()=>{
  const grant=await ownerGrant();await expectDeniedSql("update public.sentinel_permission_records set retention_policy_revision=$1 where id=$2",[id(999),grant]);
  await fixture.db.query("update public.sentinel_permission_records set revoked_at=clock_timestamp() where id=$1",[grant]);
  await expectDeniedSql("update public.sentinel_permission_records set revoked_at=null where id=$1",[grant]);
  await expectDeniedSql("delete from public.sentinel_permission_records where id=$1",[grant]);
 });
});

async function expectDeniedSql(statement:string,parameters:unknown[]) {
 await fixture.db.exec("savepoint feedback_denial");
 try { await expect(fixture.db.query(statement,parameters)).rejects.toBeDefined(); }
 finally { await fixture.db.exec("rollback to savepoint feedback_denial;release savepoint feedback_denial"); }
}
