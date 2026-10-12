import "server-only";
import { z } from "zod";
import { getSupabaseAdminClient } from "../supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { IdSchema, InstantSchema, HashSchema, ScopeSchema, WorkerMutationSchema } from "./contracts";
import { SourceConfigurationSchema } from "./publication";
const amount=z.number().int().nonnegative().max(1_000_000_000_000);
export const ProviderPriceSchema=z.strictObject({id:IdSchema,organizationId:IdSchema,provider:z.enum(['tavily','nebius']),operation:z.enum(['search','extract','extract_claims','compare_claims']),modelId:z.string().max(160).nullable(),requestMicroUsd:amount,inputMicroUsdPerMillion:amount,outputMicroUsdPerMillion:amount,requestUnits:amount,authorityEvidenceHash:HashSchema,validFrom:InstantSchema,validUntil:InstantSchema}).superRefine((v,c)=>{
 if(Date.parse(v.validUntil)<=Date.parse(v.validFrom)||(v.provider==='tavily'?(v.modelId!==null||!['search','extract'].includes(v.operation)||v.requestUnits===0||v.inputMicroUsdPerMillion!==0||v.outputMicroUsdPerMillion!==0):(v.modelId===null||!/^nvidia\//.test(v.modelId)||!['extract_claims','compare_claims'].includes(v.operation)||v.requestUnits!==0)))c.addIssue({code:'custom',message:'Provider price binding is invalid.'});
});
export type ProviderPrice=z.infer<typeof ProviderPriceSchema>;
export type ProviderWorker=z.infer<typeof WorkerMutationSchema>;
export class SentinelProviderError extends Error{
 constructor(readonly code:'NOT_CONFIGURED'|'INPUT_INVALID'|'PRICE_UNAVAILABLE'|'BUDGET_STOPPED'|'ATTEMPT_UNAVAILABLE'|'DELIVERY_INCOMPLETE'|'RESPONSE_INVALID'|'STORAGE_UNAVAILABLE'){
  super({NOT_CONFIGURED:'The provider is not configured for this project.',INPUT_INVALID:'Provider input is unsupported or exceeds its bounds.',PRICE_UNAVAILABLE:'Current owner-qualified pricing and funding are unavailable.',BUDGET_STOPPED:'The provider account or run ceiling has been reached.',ATTEMPT_UNAVAILABLE:'The original provider attempt cannot dispatch again.',DELIVERY_INCOMPLETE:'The provider response is incomplete; its reservation remains charged.',RESPONSE_INVALID:'The provider response could not be validated; its reservation remains charged.',STORAGE_UNAVAILABLE:'Provider reservation storage is unavailable.'}[code]);this.name='SentinelProviderError';
 }
}
async function rpc(name:string,args:Record<string,unknown>){try{const db=getSupabaseAdminClient() as SupabaseClient|null;if(!db)throw new SentinelProviderError('STORAGE_UNAVAILABLE');const {data,error}=await db.rpc(name,args);if(error)throw new SentinelProviderError(error.code==='54000'?'BUDGET_STOPPED':error.code==='42501'||error.code==='40001'||error.code==='23505'?'ATTEMPT_UNAVAILABLE':'STORAGE_UNAVAILABLE');return data;}catch(e){if(e instanceof SentinelProviderError)throw e;throw new SentinelProviderError('STORAGE_UNAVAILABLE');}}
function parameters(input:ProviderWorker){const w=WorkerMutationSchema.parse(input);return {p_organization_id:w.scope.organizationId,p_incident_id:w.scope.incidentId,p_mode:w.scope.mode,p_run_id:w.runId,p_owner:w.owner,p_fence:w.fence};}
export async function readProviderPrice(worker:ProviderWorker,provider:ProviderPrice['provider'],operation:ProviderPrice['operation'],modelId:string|null){
 const args=parameters(worker);const raw=await rpc('sentinel_read_provider_price',{...args,p_provider:provider,p_operation:operation,p_model_id:modelId});if(raw===null)throw new SentinelProviderError('PRICE_UNAVAILABLE');
 const p=ProviderPriceSchema.safeParse(raw);if(!p.success||p.data.organizationId!==worker.scope.organizationId||p.data.provider!==provider||p.data.operation!==operation||p.data.modelId!==modelId)throw new SentinelProviderError('STORAGE_UNAVAILABLE');return p.data;
}
export async function readProviderSources(worker:ProviderWorker){
 const r=z.strictObject({scope:ScopeSchema,runId:IdSchema,sourceConfigRevision:IdSchema,configuration:SourceConfigurationSchema}).safeParse(await rpc('sentinel_read_provider_sources',parameters(worker)));
 if(!r.success||JSON.stringify(r.data.scope)!==JSON.stringify(worker.scope)||r.data.runId!==worker.runId)throw new SentinelProviderError('STORAGE_UNAVAILABLE');return r.data;
}
export async function reservePricedAttempt(worker:ProviderWorker,price:ProviderPrice,attemptId:string,stage:string,inputTokens:number,outputTokens:number){
 const args=parameters(worker);if(price.organizationId!==worker.scope.organizationId)throw new SentinelProviderError('INPUT_INVALID');
 const input=z.strictObject({attemptId:IdSchema,stage:z.string().regex(/^[a-z0-9_-]{1,80}$/),inputTokens:z.number().int().min(0).max(24000),outputTokens:z.number().int().min(0).max(1000)}).safeParse({attemptId,stage,inputTokens,outputTokens});if(!input.success)throw new SentinelProviderError('INPUT_INVALID');
 const r=z.strictObject({attemptId:IdSchema,dispatchAllowed:z.boolean(),dispatchDeadline:InstantSchema,priceId:IdSchema,reservedMicroUsd:amount,reservedUnits:amount.positive()}).safeParse(await rpc('sentinel_reserve_priced_provider_attempt',{...args,p_attempt_id:attemptId,p_stage:stage,p_price_id:price.id,p_input_tokens:inputTokens,p_output_tokens:outputTokens}));
 if(!r.success||r.data.attemptId!==attemptId||r.data.priceId!==price.id)throw new SentinelProviderError('STORAGE_UNAVAILABLE');return r.data;
}
