import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { IdSchema, ModeSchema, SENTINEL_LIMITS, utf8Bytes } from "./contracts";
import { BriefingLocatorSchema, BriefingPayloadSchema, BriefingReceiptSchema, HistoryPageSchema } from "./briefing-contracts";
const id=IdSchema.transform(v=>v.toLowerCase());
const resultSchema=z.strictObject({content:z.string().min(1).max(SENTINEL_LIMITS.briefingBytes),receipt:BriefingReceiptSchema});
const messages={AUTH_REQUIRED:"Sign in to read history or prepare a briefing.",SCOPE_DENIED:"This briefing or history is unavailable in your workspace.",
 INPUT_INVALID:"Briefing or history request is invalid.",CAPACITY_EXCEEDED:"The complete briefing exceeds the supported export size. No partial export was prepared.",STORAGE_UNAVAILABLE:"Briefing or history storage is unavailable."};
export class SentinelBriefingError extends Error{constructor(readonly code:keyof typeof messages){super(messages[code]);this.name="SentinelBriefingError";}}
async function actor(){const u=await getCurrentUser();if(!u)throw new SentinelBriefingError("AUTH_REQUIRED");
 if(!u.organizationId||!u.role||!["viewer","analyst","incident_commander"].includes(u.role))throw new SentinelBriefingError("SCOPE_DENIED");
 return {id:id.parse(u.id),organizationId:id.parse(u.organizationId),role:u.role};}
async function rpc(name:string,args:Record<string,unknown>){const db=getSupabaseAdminClient() as SupabaseClient|null;
 if(!db)throw new SentinelBriefingError("STORAGE_UNAVAILABLE");const {data,error}=await db.rpc(name,args);
 if(error)throw new SentinelBriefingError(error.code==="42501"?"SCOPE_DENIED":error.code==="22023"?"INPUT_INVALID":error.code==="54000"?"CAPACITY_EXCEEDED":"STORAGE_UNAVAILABLE");return data;}
function bind(value:unknown,organizationId:string,incidentId:string,mode:string,role:string,expected:{revisionId?:string;artifactId?:string}){
 const a=resultSchema.parse(value),r=a.receipt;
 if(r.scope.organizationId!==organizationId||r.scope.incidentId!==incidentId||r.scope.mode!==mode||expected.revisionId&&r.planRevisionId!==expected.revisionId||
  expected.artifactId&&r.artifactId!==expected.artifactId||role==="viewer"&&r.redactionProfile!=="viewer_reference_only"||
  utf8Bytes(a.content)!==r.contentBytes||createHash("sha256").update(a.content,"utf8").digest("hex")!==r.contentHash)throw new SentinelBriefingError("STORAGE_UNAVAILABLE");
 if(r.format==="json"){
  const p=BriefingPayloadSchema.parse(JSON.parse(a.content));
  if(p.id!==r.artifactId||p.receiptId!==r.id||p.plan.id!==r.planRevisionId||p.scope.organizationId!==organizationId||p.scope.incidentId!==incidentId||p.scope.mode!==mode||
   p.redactionProfile!==r.redactionProfile||p.createdAt!==r.createdAt)throw new SentinelBriefingError("STORAGE_UNAVAILABLE");
 }else if(!a.content.startsWith("<!doctype html>")||!a.content.includes(`<meta name="sentinel-artifact-id" content="${r.artifactId}">`))throw new SentinelBriefingError("STORAGE_UNAVAILABLE");
 return a;
}
export async function prepareBriefing(incidentId:string,mode:string,revisionId:string,format:"json"|"html"){
 const c=BriefingLocatorSchema.extend({format:z.enum(["json","html"])}).safeParse({incidentId,mode,id:revisionId,format});if(!c.success)throw new SentinelBriefingError("INPUT_INVALID");
 try{const u=await actor(),args={p_actor_id:u.id,p_organization_id:u.organizationId,p_incident_id:c.data.incidentId,p_mode:c.data.mode};
  const data=await rpc("sentinel_create_briefing",{...args,p_revision_id:c.data.id});if(data===null)return null;
  const json=bind(data,u.organizationId,c.data.incidentId,c.data.mode,u.role,{revisionId:c.data.id});if(json.receipt.format!=="json")throw new SentinelBriefingError("STORAGE_UNAVAILABLE");
  if(format==="json")return json;
  const html=bind(await rpc("sentinel_create_html_briefing",{...args,p_source_artifact_id:json.receipt.artifactId}),u.organizationId,c.data.incidentId,c.data.mode,u.role,{revisionId:c.data.id});
  if(html.receipt.format!=="html"||html.receipt.sourceArtifactId!==json.receipt.artifactId)throw new SentinelBriefingError("STORAGE_UNAVAILABLE");return html;
 }catch(e){if(e instanceof SentinelBriefingError)throw e;throw new SentinelBriefingError("STORAGE_UNAVAILABLE");}
}
export async function readBriefing(incidentId:string,mode:string,artifactId:string){
 const c=BriefingLocatorSchema.safeParse({incidentId,mode,id:artifactId});if(!c.success)throw new SentinelBriefingError("INPUT_INVALID");
 try{const u=await actor(),data=await rpc("sentinel_read_briefing",{p_actor_id:u.id,p_organization_id:u.organizationId,p_incident_id:c.data.incidentId,p_mode:c.data.mode,p_artifact_id:c.data.id});
  return data===null?null:bind(data,u.organizationId,c.data.incidentId,c.data.mode,u.role,{artifactId:c.data.id});
 }catch(e){if(e instanceof SentinelBriefingError)throw e;throw new SentinelBriefingError("STORAGE_UNAVAILABLE");}
}
export async function readHistory(incidentId:string,mode:string,afterSequence=0){
 const c=z.strictObject({incidentId:id,mode:ModeSchema,afterSequence:z.number().int().nonnegative().safe()}).safeParse({incidentId,mode,afterSequence});if(!c.success)throw new SentinelBriefingError("INPUT_INVALID");
 try{const u=await actor(),data=await rpc("sentinel_read_history",{p_actor_id:u.id,p_organization_id:u.organizationId,p_incident_id:c.data.incidentId,p_mode:c.data.mode,p_after_sequence:c.data.afterSequence});
  if(data===null)return null;if(utf8Bytes(JSON.stringify(data))>SENTINEL_LIMITS.providerResponseBytes)throw new SentinelBriefingError("STORAGE_UNAVAILABLE");
  const page=HistoryPageSchema.parse(data);if(page.scope.organizationId!==u.organizationId||page.scope.incidentId!==c.data.incidentId||page.scope.mode!==c.data.mode||page.items.some(x=>x.sequence<=afterSequence))throw new SentinelBriefingError("STORAGE_UNAVAILABLE");return page;
 }catch(e){if(e instanceof SentinelBriefingError)throw e;throw new SentinelBriefingError("STORAGE_UNAVAILABLE");}
}
