import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { IdSchema, InstantSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS, WorkerMutationSchema, utf8Bytes } from "./contracts";
import { assertEvidenceScope } from "./evidence";
const id=IdSchema.transform(v=>v.toLowerCase()), generation=z.number().int().nonnegative().safe();
const text=z.string().min(1).max(2000).refine(v=>v===v.trim() && utf8Bytes(v)<=8000 && !v.includes("\0") &&
  new TextDecoder("utf-8",{ignoreBOM:true}).decode(new TextEncoder().encode(v))===v);
const label=z.string().min(1).max(200).refine(v=>!v.includes("\0") && new TextDecoder("utf-8",{ignoreBOM:true}).decode(new TextEncoder().encode(v))===v);
export const ChangeDraftSchema=z.strictObject({ id, markerId:id,
  category:z.enum(["addition","substantive","benign","conflict","withdrawal","unresolved"]),
  materiality:z.enum(["material","benign","unresolved"]), claimIds:z.array(id).max(SENTINEL_LIMITS.pageRows),
  affectedEntityIds:z.array(id).max(SENTINEL_LIMITS.tasks), explanation:text,
  modelVersion:label,promptVersion:label,
}).superRefine((c,ctx)=>{
  if(new Set(c.claimIds).size!==c.claimIds.length || new Set(c.affectedEntityIds).size!==c.affectedEntityIds.length ||
      (["conflict","unresolved"].includes(c.category) && c.materiality!=="unresolved") ||
      (c.category==="benign" && c.materiality!=="benign") ||
      (c.category!=="benign" && c.materiality==="benign") ||
      (c.materiality!=="unresolved" && c.category!=="withdrawal" && !c.claimIds.length)) ctx.addIssue({code:"custom",message:"Change draft is ambiguous or misbound."});
});
export const ChangePublicationSchema=WorkerMutationSchema.extend({commandId:id,expectedEvidenceGeneration:generation,
  changes:z.array(ChangeDraftSchema).min(1).max(SENTINEL_LIMITS.documents),
}).superRefine((c,ctx)=>{
  if(new Set(c.changes.map(v=>v.id)).size!==c.changes.length || new Set(c.changes.map(v=>v.markerId)).size!==c.changes.length ||
    utf8Bytes(JSON.stringify({expectedEvidenceGeneration:c.expectedEvidenceGeneration,changes:c.changes}))>SENTINEL_LIMITS.mutationBytes)
    ctx.addIssue({code:"custom",message:"Change publication exceeds identity or transport limits."});
});
export const ChangeSchema=ChangeDraftSchema.safeExtend({scope:ScopeSchema,runId:IdSchema,documentId:IdSchema,versionId:IdSchema,
  previousVersionId:IdSchema.nullable(),createdAt:InstantSchema,semanticAccepted:z.literal(false),stage:z.literal("draft")});
const receiptSchema=z.strictObject({scope:ScopeSchema,runId:IdSchema,commandId:IdSchema,fence:z.number().int().positive().safe(),
  committedAt:InstantSchema,evidenceGeneration:generation,unresolvedSourceChanges:generation,changeIds:z.array(IdSchema).min(1).max(SENTINEL_LIMITS.documents),
  markerIds:z.array(IdSchema).min(1).max(SENTINEL_LIMITS.documents),semanticAccepted:z.literal(false),reopenedMarkers:z.number().int().positive().max(SENTINEL_LIMITS.documents).optional()});
const publicationResult=z.strictObject({replayed:z.boolean(),receipt:receiptSchema});
const pageSchema=z.strictObject({scope:ScopeSchema,evidenceGeneration:generation,unresolvedSourceChanges:generation,
  classificationPendingMarkers:generation,observedAt:InstantSchema,items:z.array(z.strictObject({sequence:z.number().int().positive().safe(),
    change:ChangeSchema,isLatestDraft:z.boolean(),currentEvidence:z.boolean()})).max(SENTINEL_LIMITS.pageRows),
  hasMore:z.boolean(),nextAfterSequence:z.number().int().positive().safe().nullable()});
const messages={AUTH_REQUIRED:"Sign in to review source changes.",SCOPE_DENIED:"Changes are unavailable in your workspace.",
  INPUT_INVALID:"Change input is invalid or exceeds the supported bounds.",CHANGE_CONFLICT:"Evidence, lease or change command changed. Read the current state.",
  STORAGE_UNAVAILABLE:"Change storage is unavailable. Try again later."};
export class SentinelChangeError extends Error{constructor(readonly code:keyof typeof messages){super(messages[code]);this.name="SentinelChangeError";}}
async function rpc(name:string,params:Record<string,unknown>){
  const db=getSupabaseAdminClient() as SupabaseClient|null;if(!db)throw new SentinelChangeError("STORAGE_UNAVAILABLE");
  const {data,error}=await db.rpc(name,params);
  if(error)throw new SentinelChangeError(error.code==="42501"?"SCOPE_DENIED":error.code==="22023"?"INPUT_INVALID":["40001","23505"].includes(error.code)?"CHANGE_CONFLICT":"STORAGE_UNAVAILABLE");
  return data;
}
/** Private bounded worker publication; model comparison is a draft, never approval. */
export async function publishChanges(input:unknown){
  const parsed=ChangePublicationSchema.safeParse(input);if(!parsed.success)throw new SentinelChangeError("INPUT_INVALID");const c=parsed.data;
  try{
    const result=publicationResult.parse(await rpc("sentinel_publish_changes",{p_organization_id:c.scope.organizationId,p_incident_id:c.scope.incidentId,p_mode:c.scope.mode,
      p_run_id:c.runId,p_owner:c.owner,p_fence:c.fence,p_command_id:c.commandId,p_expected_generation:c.expectedEvidenceGeneration,p_changes:c.changes}));
    const r=result.receipt;assertEvidenceScope(r.scope,c.scope);
    if(r.runId!==c.runId || r.commandId!==c.commandId || (r.reopenedMarkers!==undefined && r.reopenedMarkers>c.changes.length) ||
      r.evidenceGeneration!==c.expectedEvidenceGeneration+(r.reopenedMarkers?1:0) || r.fence>c.fence || (!result.replayed && r.fence!==c.fence) ||
      JSON.stringify(r.changeIds)!==JSON.stringify(c.changes.map(v=>v.id)) || JSON.stringify(r.markerIds)!==JSON.stringify(c.changes.map(v=>v.markerId))) throw new SentinelChangeError("STORAGE_UNAVAILABLE");
    return result;
  }catch(e){if(e instanceof SentinelChangeError)throw e;throw new SentinelChangeError("STORAGE_UNAVAILABLE");}
}
/** Historical drafts are labeled separately from the latest; empty results do not mean no changes. */
export async function readChangePage(incidentId:string,mode:string,afterSequence=0){
  const parsed=z.strictObject({incidentId:id,mode:ModeSchema,afterSequence:generation}).safeParse({incidentId,mode,afterSequence});if(!parsed.success)throw new SentinelChangeError("INPUT_INVALID");
  try{
    const user=await getCurrentUser();if(!user)throw new SentinelChangeError("AUTH_REQUIRED");
    if(!user.organizationId || !user.role || !["analyst","incident_commander","viewer"].includes(user.role))throw new SentinelChangeError("SCOPE_DENIED");
    const scope={organizationId:user.organizationId,incidentId:parsed.data.incidentId,mode:parsed.data.mode};
    const data=await rpc("sentinel_read_changes",{p_actor_id:user.id,p_organization_id:scope.organizationId,p_incident_id:scope.incidentId,p_mode:scope.mode,p_after_sequence:afterSequence});
    if(data===null)return null;if(utf8Bytes(JSON.stringify(data))>SENTINEL_LIMITS.providerResponseBytes)throw new SentinelChangeError("STORAGE_UNAVAILABLE");
    const page=pageSchema.parse(data);assertEvidenceScope(page.scope,scope);let previous=afterSequence;const ids=new Set<string>();
    for(const item of page.items){assertEvidenceScope(item.change.scope,scope);if(item.sequence<=previous || ids.has(item.change.id))throw new SentinelChangeError("STORAGE_UNAVAILABLE");previous=item.sequence;ids.add(item.change.id);}
    if(page.hasMore!==(page.nextAfterSequence!==null) || (page.hasMore && (!page.items.length || page.nextAfterSequence!==previous)))throw new SentinelChangeError("STORAGE_UNAVAILABLE");
    return page;
  }catch(e){if(e instanceof SentinelChangeError)throw e;throw new SentinelChangeError("STORAGE_UNAVAILABLE");}
}
