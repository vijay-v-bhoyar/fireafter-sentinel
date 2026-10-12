import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion, evidenceHash } from "./evidence";
import { publishEvidence } from "./publication";
import { publishClaims } from "./claims";
import { publishChanges } from "./changes";
import { GET, POST } from "../../app/api/sentinel/source-changes/[id]/review/route";
import { readMarkerReview, recordMarkerReview } from "./marker-reviews";
import { recordClaimReview } from "./claim-reviews";
const identity=vi.hoisted(()=>({user:null as unknown}));
vi.mock("../auth",()=>({getCurrentUser:async()=>identity.user}));
vi.mock("../supabase",()=>({getSupabaseAdminClient:()=>({rpc:async(name:string,args:Record<string,unknown>)=>{
  const keys=name==="sentinel_record_marker_review"?["p_actor_id","p_organization_id","p_incident_id","p_mode","p_marker_id","p_command_id","p_review"]
    :name==="sentinel_read_marker_review"?["p_actor_id","p_organization_id","p_incident_id","p_mode","p_marker_id"]
    :name==="sentinel_record_claim_review"?["p_actor_id","p_organization_id","p_incident_id","p_mode","p_claim_id","p_command_id","p_review"]
    :name==="sentinel_publish_changes"?["p_organization_id","p_incident_id","p_mode","p_run_id","p_owner","p_fence","p_command_id","p_expected_generation","p_changes"]
    :name==="sentinel_read_changes"?["p_actor_id","p_organization_id","p_incident_id","p_mode","p_after_sequence"]
    :name==="sentinel_publish_claims"?["p_organization_id","p_incident_id","p_mode","p_run_id","p_owner","p_fence","p_command_id","p_expected_generation","p_version_ids","p_claims","p_transient_texts"]
    :["p_organization_id","p_incident_id","p_mode","p_run_id","p_owner","p_fence","p_command_id","p_observations"];
  try{return {data:await fixture.rpc(name,keys.map(k=>typeof args[k]==="object"?JSON.stringify(args[k]):args[k])),error:null};}catch(error){return {data:null,error};}
}})}));
const id=(n:number)=>`95000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const scope={organizationId:id(1),incidentId:id(2),mode:"synthetic" as const},actor=id(9),owner=id(10),s=[scope.organizationId,scope.incidentId,scope.mode] as const;
const base={scope,documentId:id(3),sourceConfigRevision:id(4),issuer:"Synthetic county",jurisdiction:"Fixture county",canonicalUrl:"https://example.gov/notice",
  rawText:"Synthetic road closes today. More supporting text.",publishedAt:null,effectiveFrom:null,effectiveUntil:null,availability:"available",contentPermission:"full_text"};
const seeded=prepareDocumentVersion(base,{id:id(5),retrievedAt:"2026-10-11T10:00:00Z"}).version;
let fixture:Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>,run:{id:string;fence:number;createdAt:string},version:typeof seeded,generation:number,markerId:string;
beforeAll(async()=>{fixture=await sentinelEvidenceSqlFixture();},20_000);
beforeEach(async()=>{
  await fixture.db.exec("begin");await fixture.seed(seeded,actor,"analyst");identity.user={id:actor,organizationId:scope.organizationId,role:"analyst"};
  await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)",
    [id(44),...s,JSON.stringify({schemaVersion:1,sources:[{documentId:id(3),documentKey:id(3),canonicalUrl:base.canonicalUrl,issuer:base.issuer,jurisdiction:base.jurisdiction,contentPermission:"full_text"}]}),"a".repeat(64),actor]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1",[id(44)]);
  const admitted=await fixture.rpc<{run:typeof run}>("sentinel_admit_run",[actor,...s,id(44),id(11)]);run=(await fixture.rpc<typeof admitted>("sentinel_acquire_run_lease",[...s,admitted.run.id,owner])).run;
  version=prepareDocumentVersion({...base,sourceConfigRevision:id(44)},{id:id(100),retrievedAt:new Date().toISOString()}).version;
  await observe(version,id(80));
  await fixture.db.query("insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence) values($1,$2,'Synthetic road','road','Fixture','synthetic','High')",[id(500),scope.incidentId]);
  await publishClaims({scope,runId:run.id,owner,fence:run.fence,commandId:id(81),expectedEvidenceGeneration:generation,versionIds:[version.id],claims:[{
    id:id(200),documentVersionId:version.id,excerptStart:0,excerptEnd:27,excerpt:"Synthetic road closes today",excerptHash:evidenceHash("Synthetic road closes today"),kind:"road_status",
    claimText:"Synthetic road closes today",entityIds:[id(500)],modelVersion:"synthetic",promptVersion:"synthetic"}]});
});
afterEach(async()=>{await fixture.db.exec("rollback");});afterAll(async()=>{await fixture?.close();});
async function observe(v:typeof seeded,commandId:string){const out=await publishEvidence({scope,runId:run.id,owner,fence:run.fence,commandId,observations:[{
  documentId:id(3),outcome:"observed",requestedAt:run.createdAt,observedBytes:v.normalizedBytes,providerRequestId:null,version:v}]});generation=out.receipt.evidenceGeneration;markerId=out.receipt.observations[0].markerId!;}
function draft(n=300){return {id:id(n),markerId,category:"addition",materiality:"material",claimIds:[id(200)],affectedEntityIds:[id(500)],
  explanation:"Synthetic initial notice requires review.",modelVersion:"synthetic-not-live",promptVersion:"synthetic-comparison-v1"};}
function command(n=400){return {scope,runId:run.id,owner,fence:run.fence,commandId:id(n),expectedEvidenceGeneration:generation,changes:[draft()]};}
async function state(){return (await fixture.db.query<{evidence_generation:number;unresolved_source_change_count:number}>("select evidence_generation,unresolved_source_change_count from public.sentinel_incident_state")).rows[0];}

async function claimReview(overrides:Record<string,unknown>={}) {
  const result=await recordClaimReview({incidentId:scope.incidentId,mode:scope.mode,claimId:id(200),commandId:id(5000),expectedEvidenceGeneration:generation,
    expectedReviewId:null,support:"supported",applicability:"applicable",provenance:"verified",conflict:"clear",note:"Synthetic full source citation reviewed.",...overrides});
  generation=result.receipt.evidenceGeneration;return result;
}
async function prepared(){await publishChanges(command());await claimReview();}
async function markerCommand(action:"resolve"|"hold"="resolve"){
  const preview=await readMarkerReview(scope.incidentId,scope.mode,markerId);
  if(!preview)throw new Error("Missing synthetic marker");
  return {incidentId:scope.incidentId,mode:scope.mode,markerId,commandId:id(6000),expectedEvidenceGeneration:preview.evidenceGeneration,
    expectedReviewId:preview.latestReviewId,expectedReviewVectorHash:preview.reviewVectorHash,changeId:preview.latestChangeId,action,
    materiality:action==="resolve"?"material":"unresolved",completeReview:action==="resolve",provenance:action==="resolve"?"verified":"unresolved",
    note:"Synthetic source review; this does not approve a plan."};
}
async function resolve(){const result=await recordMarkerReview(await markerCommand());generation=result.receipt.evidenceGeneration;return result;}
async function count(name:string){return (await fixture.db.query<{n:number}>(`select count(*)::int n from public.${name}`)).rows[0].n;}
const context=()=>({params:Promise.resolve({id:markerId})});
function request(body:unknown,headers:Record<string,string>={}){return new Request(`https://sentinel.example/api/sentinel/source-changes/${markerId}/review`,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});}

describe("Human marker resolution and automatic invalidation through exact SQL",()=>{
  it("previews missing comparison and unresolved claims without falsely clearing a marker",async()=>{
    const p=await readMarkerReview(scope.incidentId,scope.mode,markerId);expect(p).toMatchObject({resolved:false,latestChangeId:null,unresolvedClaimReviews:1,unresolvedSourceChanges:1});
    expect(p?.resolutionIssues).toContain("comparison_missing");expect(p?.resolutionIssues).toContain("unresolved_claim_reviews");
    expect(p).not.toHaveProperty("claimReviewVector");
  });
  it("atomically resolves a complete supported current source and retains the snapshot",async()=>{
    await prepared();expect((await readMarkerReview(scope.incidentId,scope.mode,markerId))?.resolutionIssues).toEqual([]);
    const result=await resolve();expect(result).toMatchObject({replayed:false,review:{actorId:actor,markerId,action:"resolve",completeReview:true},
      receipt:{markerResolved:true,evidenceGeneration:generation,unresolvedSourceChanges:0}});
    expect(await state()).toEqual({evidence_generation:generation,unresolved_source_change_count:0});
    expect(await readMarkerReview(scope.incidentId,scope.mode,markerId)).toMatchObject({resolved:true,reason:"human_resolve",review:result.review,receipt:result.receipt});
    const row=(await fixture.db.query<{claim_review_vector:unknown[]}>("select claim_review_vector from public.sentinel_marker_reviews")).rows[0];expect(row.claim_review_vector).toHaveLength(1);
  });
  it("records hold with missing classification/provenance while retaining the approval fence",async()=>{
    const result=await recordMarkerReview(await markerCommand("hold"));expect(result.receipt).toMatchObject({markerResolved:false,unresolvedSourceChanges:1});
    expect(await readMarkerReview(scope.incidentId,scope.mode,markerId)).toMatchObject({resolved:false,reason:"human_hold"});
  });
  it("exact replay returns history after a later hold without reactivating resolution",async()=>{
    await prepared();const c=await markerCommand(),first=await recordMarkerReview(c);generation=first.receipt.evidenceGeneration;
    const hold=await recordMarkerReview({...await markerCommand("hold"),commandId:id(6001)});
    expect(await recordMarkerReview(c)).toEqual({...first,replayed:true});expect((await readMarkerReview(scope.incidentId,scope.mode,markerId))?.resolved).toBe(false);
    expect((await state()).evidence_generation).toBe(hold.receipt.evidenceGeneration);
    await expect(recordMarkerReview({...c,note:"Different command"})).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
  });
  it.each(["expectedEvidenceGeneration","expectedReviewId","expectedReviewVectorHash","changeId"])("rejects stale %s independently",async key=>{
    await prepared();const c=await markerCommand();
    await expect(recordMarkerReview({...c,[key]:key==="expectedEvidenceGeneration"?99:key==="expectedReviewVectorHash"?"a".repeat(64):id(999)})).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
    expect(await count("sentinel_marker_reviews")).toBe(0);expect((await state()).unresolved_source_change_count).toBe(1);
  });
  it.each(["viewer","deleted"])("fresh membership denies %s writes and replay",async role=>{
    await prepared();const c=await markerCommand();await recordMarkerReview(c);
    await fixture.db.exec(role==="deleted"?"delete from public.organization_members":"update public.organization_members set role='viewer'");
    await expect(recordMarkerReview(c)).rejects.toMatchObject({code:"SCOPE_DENIED"});
  });
  it.each(["viewer","analyst","incident_commander"])("permits %s preview reads",async role=>{
    await fixture.db.query("update public.organization_members set role=$1",[role]);expect(await readMarkerReview(scope.incidentId,scope.mode,markerId)).toMatchObject({markerId});
  });
  it("denies revoked reads and unavailable scope without leaking rows",async()=>{
    expect(await readMarkerReview(scope.incidentId,scope.mode,id(999))).toBeNull();expect(await readMarkerReview(id(999),scope.mode,markerId)).toBeNull();
    expect(await readMarkerReview(scope.incidentId,"replay",markerId)).toBeNull();await fixture.db.exec("delete from public.organization_members");
    await expect(readMarkerReview(scope.incidentId,scope.mode,markerId)).rejects.toMatchObject({code:"SCOPE_DENIED"});
  });
  it("a known comparison cannot resolve unreviewed claims",async()=>{
    await publishChanges(command());await expect(recordMarkerReview(await markerCommand())).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
  });
  it("rechecks incident entity candidates at marker commit",async()=>{
    await prepared();await fixture.db.exec("delete from public.assets");
    expect((await readMarkerReview(scope.incidentId,scope.mode,markerId))?.resolutionIssues).toContain("entity_candidates_changed");
    await expect(recordMarkerReview(await markerCommand())).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
  });
  it("an unsupported-only source cannot be resolved as material",async()=>{
    await publishChanges(command());await claimReview({support:"unsupported",applicability:"not_applicable"});
    await expect(recordMarkerReview(await markerCommand())).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
    expect((await recordMarkerReview({...await markerCommand(),materiality:"benign"})).receipt.markerResolved).toBe(true);
  });
  it("later claim review reopens once, advances generation once and retains the original decision",async()=>{
    await prepared();const priorClaim=await readClaimReviewId(),resolved=await resolve();
    const changed=await claimReview({commandId:id(5001),expectedReviewId:priorClaim,support:"unsupported",applicability:"not_applicable"});
    expect(changed.receipt).toMatchObject({evidenceGeneration:resolved.receipt.evidenceGeneration+1,unresolvedSourceChanges:1});
    expect(await readMarkerReview(scope.incidentId,scope.mode,markerId)).toMatchObject({resolved:false,reason:"claim_review_changed",review:resolved.review});
    expect(await count("sentinel_marker_invalidations")).toBe(1);
    const next=await claimReview({commandId:id(5002),expectedReviewId:changed.review.id});expect(next.receipt.unresolvedSourceChanges).toBe(1);expect(await count("sentinel_marker_invalidations")).toBe(1);
  });
  it("new claims reopen the source with an accurate publication receipt",async()=>{
    await prepared();await resolve();const result=await publishClaims(newClaims());
    expect(result.receipt).toMatchObject({reopenedMarkers:1,evidenceGeneration:generation+1,unresolvedSourceChanges:1});
    expect(await readMarkerReview(scope.incidentId,scope.mode,markerId)).toMatchObject({resolved:false,reason:"claim_changed",unresolvedClaimReviews:1});
  });
  it("new comparison drafts reopen the marker while exact replay leaves it resolved",async()=>{
    const old=command();await prepared();const resolved=await resolve();
    expect((await publishChanges(old)).replayed).toBe(true);expect((await readMarkerReview(scope.incidentId,scope.mode,markerId))?.resolved).toBe(true);
    const result=await publishChanges({...command(401),changes:[draft(301)]});expect(result.receipt).toMatchObject({reopenedMarkers:1,evidenceGeneration:generation+1,unresolvedSourceChanges:1});
    expect(await readMarkerReview(scope.incidentId,scope.mode,markerId)).toMatchObject({resolved:false,reason:"draft_changed",review:resolved.review});
  });
  it("rolls back reopening, generation and claims if the lease expires during command persistence",async()=>{
    await prepared();await resolve();await fixture.db.exec("create function public.slow_test_claim_command() returns trigger language plpgsql as $$ begin perform pg_sleep(0.20);return new;end $$;create trigger slow_claim_command before insert on public.sentinel_claim_publications for each row execute function public.slow_test_claim_command();update public.sentinel_runs set lease_until=clock_timestamp()+interval '0.10 second'");
    await expect(publishClaims(newClaims())).rejects.toMatchObject({code:"RUN_CONFLICT"});expect((await state()).unresolved_source_change_count).toBe(0);
    expect((await state()).evidence_generation).toBe(generation);expect((await readMarkerReview(scope.incidentId,scope.mode,markerId))?.resolved).toBe(true);
    expect(await count("sentinel_marker_invalidations")).toBe(0);expect(await count("sentinel_claims")).toBe(1);
  });
  it("a new source head prevents resolving the historical marker",async()=>{
    await prepared();const c=await markerCommand();const v=prepareDocumentVersion({...base,sourceConfigRevision:id(44),rawText:"Synthetic road now opens."},{id:id(101),retrievedAt:new Date().toISOString()}).version;
    await observe(v,id(82));const oldMarker=c.markerId;expect((await readMarkerReview(scope.incidentId,scope.mode,oldMarker))?.resolutionIssues).toContain("source_not_current");
    await expect(recordMarkerReview({...c,expectedEvidenceGeneration:generation})).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
  });
  it("changed configuration blocks resolution while the original version remains immutable",async()=>{
    await prepared();const ids=await fixture.db.query<{id:string}>("select id from public.sentinel_document_versions where id=$1",[version.id]);expect(ids.rows).toHaveLength(1);
    // The committed version itself is immutable; a restrictive new configuration leaves the old head historical.
    await fixture.db.exec("update public.sentinel_incident_state set current_source_config_revision=null");
    expect((await readMarkerReview(scope.incidentId,scope.mode,markerId))?.resolutionIssues).toContain("source_not_current");
    await expect(recordMarkerReview(await markerCommand())).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
  });
  it("excerpt-only source verification cannot masquerade as retained whole-version review",async()=>{
    await prepared();await fixture.db.exec("update public.sentinel_runs set status='canceled',lease_owner=null,lease_until=null");
    await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)",
      [id(45),...s,JSON.stringify({schemaVersion:1,sources:[{documentId:id(3),documentKey:id(3),canonicalUrl:base.canonicalUrl,issuer:base.issuer,jurisdiction:base.jurisdiction,contentPermission:"excerpt_only"}]}),"b".repeat(64),actor]);
    await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1",[id(45)]);
    const admitted=await fixture.rpc<{run:typeof run}>("sentinel_admit_run",[actor,...s,id(45),id(12)]);run=(await fixture.rpc<typeof admitted>("sentinel_acquire_run_lease",[...s,admitted.run.id,owner])).run;
    version=prepareDocumentVersion({...base,sourceConfigRevision:id(45),contentPermission:"excerpt_only"},{id:id(101),retrievedAt:new Date().toISOString()}).version;
    await observe(version,id(82));await publishClaims({...newClaims(),transientTexts:{[version.id]:base.rawText}});
    await publishChanges({...command(),changes:[{...draft(),id:id(301),category:"substantive",claimIds:[id(201)],affectedEntityIds:[]}]});
    await claimReview({claimId:id(201),commandId:id(5001),expectedReviewId:null});
    expect((await readMarkerReview(scope.incidentId,scope.mode,markerId))?.resolutionIssues).toContain("retained_full_text_required");
    await expect(recordMarkerReview(await markerCommand())).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
    expect((await recordMarkerReview(await markerCommand("hold"))).receipt.markerResolved).toBe(false);
  });
  it("withdrawn-source review stays held pending policy and coverage support",async()=>{
    await prepared();version=prepareDocumentVersion({...base,sourceConfigRevision:id(44),availability:"withdrawn",rawText:""},{id:id(101),retrievedAt:new Date().toISOString()}).version;
    await observe(version,id(82));await publishChanges({...command(401),changes:[{...draft(301),category:"withdrawal",claimIds:[],affectedEntityIds:[]}]});
    expect((await readMarkerReview(scope.incidentId,scope.mode,markerId))?.resolutionIssues).toContain("source_unavailable");
    await expect(recordMarkerReview(await markerCommand())).rejects.toMatchObject({code:"REVIEW_CONFLICT"});
    expect((await recordMarkerReview(await markerCommand("hold"))).receipt.unresolvedSourceChanges).toBe(2);
  });
  it("rolls back a marker decision if its append fails",async()=>{
    await prepared();await fixture.db.exec("create function public.reject_test_marker() returns trigger language plpgsql as $$ begin raise exception 'synthetic append failure';end $$;create trigger reject_marker before insert on public.sentinel_marker_reviews for each row execute function public.reject_test_marker()");
    await expect(recordMarkerReview(await markerCommand())).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});expect((await state()).unresolved_source_change_count).toBe(1);
    expect((await state()).evidence_generation).toBe(generation);
  });
  it("HTTP GET/POST bind the marker from the path and retain private headers",async()=>{
    await prepared();const c=await markerCommand();const {markerId:ignored,...body}=c;expect(ignored).toBe(markerId);
    const posted=await POST(request(body),context());expect(posted.status).toBe(200);
    const read=await GET(new Request(`https://sentinel.example/api/sentinel/source-changes/${markerId}/review?incidentId=${scope.incidentId}&mode=synthetic`),context());expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({resolved:true});for(const response of [read,posted]){expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("x-content-type-options")).toBe("nosniff");}
    expect((await POST(request({...body,actorId:actor}),context())).status).toBe(400);expect((await POST(request(body,{Origin:"https://attacker.example"}),context())).status).toBe(403);
  });
  it("HTTP rejects unauthenticated and malformed/oversized source-review requests",async()=>{
    await prepared();const c=await markerCommand();const {markerId:bound,...body}=c;expect(bound).toBe(markerId);
    identity.user=null;expect((await POST(request(body),context())).status).toBe(401);
    const url=`https://sentinel.example/api/sentinel/source-changes/${markerId}/review?incidentId=${scope.incidentId}&mode=synthetic`;
    expect((await GET(new Request(url),context())).status).toBe(401);
    expect((await GET(new Request(url+"&mode=live"),context())).status).toBe(400);
    expect((await POST(request(body,{"Content-Type":"text/plain"}),context())).status).toBe(415);
    expect((await POST(request({...body,note:"x".repeat(131072)}),context())).status).toBe(413);
  });
  it("guards raw table writes and immutable source-review history",async()=>{
    await prepared();await resolve();for(const name of ["sentinel_marker_reviews","sentinel_marker_invalidations"]){
      await fixture.db.exec("savepoint marker_immutable");if(name==="sentinel_marker_invalidations")await claimReview({commandId:id(5001),expectedReviewId:await readClaimReviewId()});
      await expect(fixture.db.exec(`delete from public.${name}`)).rejects.toBeDefined();await fixture.db.exec("rollback to savepoint marker_immutable;release savepoint marker_immutable");
    }
    await fixture.db.exec("savepoint role_guard;set role service_role");await expect(fixture.db.exec("select * from public.sentinel_marker_status")).rejects.toMatchObject({code:"42501"});await fixture.db.exec("rollback to savepoint role_guard;reset role;release savepoint role_guard");
  });
});
async function readClaimReviewId(){return (await fixture.db.query<{id:string}>("select id from public.sentinel_claim_reviews order by review_sequence desc limit 1")).rows[0].id;}
function newClaims(){return {scope,runId:run.id,owner,fence:run.fence,commandId:id(82),expectedEvidenceGeneration:generation,versionIds:[version.id],claims:[{
  id:id(201),documentVersionId:version.id,excerptStart:0,excerptEnd:27,excerpt:"Synthetic road closes today",excerptHash:evidenceHash("Synthetic road closes today"),kind:"road_status",
  claimText:"Another synthetic extracted assertion.",entityIds:[],modelVersion:"synthetic",promptVersion:"synthetic"}]};}

