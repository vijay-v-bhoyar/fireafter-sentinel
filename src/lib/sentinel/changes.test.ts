import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishChanges, readChangePage } from "./changes";
import { changeLocatorFromUrl, encodeChangeCursor } from "./change-http";
const boundary=vi.hoisted(()=>({admin:vi.fn(),rpc:vi.fn(),user:vi.fn()}));
vi.mock("../supabase",()=>({getSupabaseAdminClient:()=>boundary.admin()}));vi.mock("../auth",()=>({getCurrentUser:()=>boundary.user()}));
const id=(n:number)=>`94000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const scope={organizationId:id(1),incidentId:id(2),mode:"synthetic" as const};
const draft={id:id(10),markerId:id(11),category:"addition",materiality:"material",claimIds:[id(12)],affectedEntityIds:[],explanation:"Synthetic notice requires review.",modelVersion:"synthetic",promptVersion:"synthetic"};
const c={scope,runId:id(3),owner:id(4),fence:2,commandId:id(5),expectedEvidenceGeneration:4,changes:[draft]};
const receipt={scope,runId:c.runId,commandId:c.commandId,fence:2,committedAt:"2026-10-11T10:00:00.000Z",evidenceGeneration:4,unresolvedSourceChanges:1,changeIds:[id(10)],markerIds:[id(11)],semanticAccepted:false};
const page={scope,evidenceGeneration:4,unresolvedSourceChanges:1,classificationPendingMarkers:0,observedAt:receipt.committedAt,
  items:[{sequence:1,isLatestDraft:true,currentEvidence:true,change:{...draft,scope,runId:c.runId,documentId:id(6),versionId:id(7),previousVersionId:null,createdAt:receipt.committedAt,stage:"draft",semanticAccepted:false}}],hasMore:false,nextAfterSequence:null};
beforeEach(()=>{vi.resetAllMocks();boundary.admin.mockReturnValue({rpc:boundary.rpc});boundary.user.mockResolvedValue({id:id(9),organizationId:scope.organizationId,role:"viewer"});boundary.rpc.mockResolvedValue({data:{receipt,replayed:false},error:null});});
describe("Comparison draft and cursor service boundary",()=>{
  it.each([{actorId:id(9)},{stage:"approved"},{semanticAccepted:true},{explanation:"\ud800"},{modelVersion:"\0"},{promptVersion:"\ud800"},{explanation:" "},{claimIds:[]},{affectedEntityIds:[id(8),id(8)]},{category:"conflict"},{category:"benign"}])("rejects invalid draft %j before storage",async patch=>{
    await expect(publishChanges({...c,changes:[{...draft,...patch}]})).rejects.toMatchObject({code:"INPUT_INVALID"});expect(boundary.admin).not.toHaveBeenCalled();
  });
  it("publishes a lease-bound immutable draft batch",async()=>{expect(await publishChanges(c)).toEqual({receipt,replayed:false});expect(boundary.rpc).toHaveBeenCalledWith("sentinel_publish_changes",{
    p_organization_id:scope.organizationId,p_incident_id:scope.incidentId,p_mode:scope.mode,p_run_id:c.runId,p_owner:c.owner,p_fence:2,p_command_id:c.commandId,p_expected_generation:4,p_changes:[draft]});});
  it.each(["scope","runId","commandId","fence","evidenceGeneration","changeIds","markerIds","semanticAccepted"])("rejects misbound receipt %s",async key=>{
    const r=structuredClone(receipt) as Record<string,unknown>;r[key]=key==="scope"?{...scope,mode:"live"}:key==="semanticAccepted"?true:key.endsWith("Ids")?[id(99)]:["fence","evidenceGeneration"].includes(key)?99:id(99);
    boundary.rpc.mockResolvedValue({data:{receipt:r,replayed:false},error:null});await expect(publishChanges(c)).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
  });
  it.each([["42501","SCOPE_DENIED"],["22023","INPUT_INVALID"],["40001","CHANGE_CONFLICT"],["23505","CHANGE_CONFLICT"],["XX000","STORAGE_UNAVAILABLE"]])("maps SQL %s safely",async(code,expected)=>{
    boundary.rpc.mockResolvedValue({data:null,error:{code,message:"PRIVATE_DATABASE_DETAILS"}});await expect(publishChanges(c)).rejects.toMatchObject({code:expected});
    try{await publishChanges(c);}catch(error){expect(String(error)).not.toContain("PRIVATE_DATABASE_DETAILS");}
  });
  it("handles missing authentication/storage and auth outages",async()=>{
    boundary.user.mockResolvedValue(null);await expect(readChangePage(scope.incidentId,scope.mode)).rejects.toMatchObject({code:"AUTH_REQUIRED"});
    boundary.user.mockRejectedValue(new Error("PRIVATE_AUTH"));await expect(readChangePage(scope.incidentId,scope.mode)).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
    boundary.admin.mockReturnValue(null);await expect(publishChanges(c)).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
  });
  it("derives member read scope from the session",async()=>{
    boundary.rpc.mockResolvedValue({data:page,error:null});expect(await readChangePage(scope.incidentId,scope.mode)).toEqual(page);
    expect(boundary.rpc).toHaveBeenCalledWith("sentinel_read_changes",{p_actor_id:id(9),p_organization_id:scope.organizationId,p_incident_id:scope.incidentId,p_mode:scope.mode,p_after_sequence:0});
  });
  it.each(["scope","sequence","accepted","stage","cursor","duplicate"])("rejects corrupt draft projection %s",async key=>{
    const p=structuredClone(page);
    if(key==="scope")p.items[0].change.scope.incidentId=id(99);
    else if(key==="sequence")p.items[0].sequence=0;
    else if(key==="accepted")p.items[0].change.semanticAccepted=true;
    else if(key==="stage")p.items[0].change.stage="approved";
    else if(key==="cursor")p.hasMore=true;
    else p.items.push({...p.items[0],sequence:2});
    boundary.rpc.mockResolvedValue({data:p,error:null});await expect(readChangePage(scope.incidentId,scope.mode)).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
  });
  const url=`https://sentinel.example/api/sentinel/changes?incidentId=${scope.incidentId}&mode=synthetic`;
  it("round-trips a canonical incident/mode cursor without granting authority",()=>{
    const cursor=encodeChangeCursor(scope.incidentId,scope.mode,25);expect(changeLocatorFromUrl(new Request(`${url}&cursor=${cursor}`))).toEqual({incidentId:scope.incidentId,mode:scope.mode,afterSequence:25});
  });
  it.each(["&organizationId=forged","&mode=live","&cursor=invalid","&cursor=","&cursor=a&cursor=b","&filter=material"])("rejects unknown/duplicate/malformed query %s",suffix=>{
    expect(()=>changeLocatorFromUrl(new Request(url+suffix))).toThrow();
  });
  it("rejects scope-swapped, noncanonical and overlong cursors",()=>{
    const valid=encodeChangeCursor(scope.incidentId,scope.mode,25);
    for(const request of [new Request(`${url.replace("synthetic","live")}&cursor=${valid}`),new Request(`${url}&cursor=${valid}%3D`),new Request(`${url}&cursor=${"x".repeat(257)}`)])expect(()=>changeLocatorFromUrl(request)).toThrow();
  });
});
