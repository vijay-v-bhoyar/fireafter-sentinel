import 'server-only';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {getSupabaseAdminClient} from '../supabase';
import {IdSchema,HashSchema,InstantSchema,RunProjectionSchema,DocumentVersionSchema,WorkerMutationSchema,type SentinelRun} from './contracts';
import {SourceConfigurationSchema} from './publication';
import {SentinelRunError} from './runs';
import {ClaimDraftSchema} from './claims';

export const WorkerContextSchema=z.strictObject({
 run:RunProjectionSchema,configuration:SourceConfigurationSchema,evidenceGeneration:z.number().int().nonnegative().safe(),
 versions:z.array(z.strictObject({documentId:IdSchema,versionId:IdSchema,previousVersionId:IdSchema.nullable(),markerId:IdSchema.nullable(),hasComparison:z.boolean(),current:DocumentVersionSchema,previous:DocumentVersionSchema.nullable()})).max(5),
 assets:z.array(z.strictObject({id:IdSchema,name:z.string().max(2000)})).max(10),
 outputs:z.array(z.strictObject({sequence:z.number().int().min(0).max(20),kind:z.enum(['context','search','extract','evidence','claims','changes']),payload:z.record(z.string(),z.unknown()),hash:HashSchema})).max(21),
 claims:z.array(ClaimDraftSchema).max(25),
});
export type WorkerContext=z.infer<typeof WorkerContextSchema>;
export type Worker=z.infer<typeof WorkerMutationSchema>;
const DispatchStateSchema=z.strictObject({run:RunProjectionSchema,attemptId:IdSchema.nullable(),runtimeRunId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable()});
async function rpc<T>(name:string,args:Record<string,unknown>,schema:z.ZodType<T>):Promise<T>{
 const db=getSupabaseAdminClient() as SupabaseClient|null;if(!db)throw new SentinelRunError('STORAGE_UNAVAILABLE');
 const {data,error}=await db.rpc(name,args);
 if(error)throw new SentinelRunError(error.code==='42501'?'SCOPE_DENIED':error.code==='22023'?'INPUT_INVALID':error.code==='55P03'?'RUN_BUSY':error.code==='54000'?'BUDGET_STOPPED':['40001','23505'].includes(error.code)?'RUN_CONFLICT':'STORAGE_UNAVAILABLE');
 const result=schema.safeParse(data);if(!result.success)throw new SentinelRunError('STORAGE_UNAVAILABLE');return result.data;
}
function parameters(worker:Worker){WorkerMutationSchema.parse(worker);return {p_org:worker.scope.organizationId,p_incident:worker.scope.incidentId,p_mode:worker.scope.mode,p_run:worker.runId,p_owner:worker.owner,p_fence:worker.fence};}
/** Same scope/lease-checked database clock used to validate publication bounds. */
export async function readWorkerClock(worker:Worker){return rpc('sentinel_read_worker_clock',parameters(worker),InstantSchema);}
export async function locateWorkerRun(runId:string){IdSchema.parse(runId);const run=await rpc('sentinel_worker_locator',{p_run_id:runId},RunProjectionSchema);if(run.id!==runId)throw new SentinelRunError('STORAGE_UNAVAILABLE');return run;}
export async function dispatchState(runId:string){IdSchema.parse(runId);const state=await rpc('sentinel_dispatch_state',{p_run_id:runId},DispatchStateSchema);if(state.run.id!==runId)throw new SentinelRunError('STORAGE_UNAVAILABLE');return state;}
export async function claimDispatch(runId:string,attemptId:string,previous:string|null,runtimeTerminal:boolean){
 IdSchema.parse(runId);IdSchema.parse(attemptId);IdSchema.nullable().parse(previous);
 const result=await rpc('sentinel_claim_dispatch',{p_run_id:runId,p_attempt_id:attemptId,p_expected_attempt:previous,p_runtime_terminal:runtimeTerminal},z.strictObject({attemptId:IdSchema,dispatchId:IdSchema}).nullable());
 if(result&&(result.attemptId!==attemptId||result.dispatchId!==runId))throw new SentinelRunError('STORAGE_UNAVAILABLE');return result;
}
export async function acknowledgeDispatch(runId:string,attemptId:string,runtimeRunId:string){return rpc('sentinel_ack_dispatch',{p_run_id:IdSchema.parse(runId),p_attempt_id:IdSchema.parse(attemptId),p_runtime_run_id:runtimeRunId},z.literal(true));}
export async function readWorkerContext(worker:Worker){
 const context=await rpc('sentinel_read_worker',parameters(worker),WorkerContextSchema);
 if(context.run.id!==worker.runId||context.run.scope.organizationId!==worker.scope.organizationId||context.run.scope.incidentId!==worker.scope.incidentId||context.run.scope.mode!==worker.scope.mode||context.run.fence!==worker.fence)throw new SentinelRunError('STORAGE_UNAVAILABLE');
 if(context.outputs.some((o,i)=>o.sequence!==i))throw new SentinelRunError('STORAGE_UNAVAILABLE');return context;
}
export async function saveWorkerOutput(worker:Worker,sequence:number,kind:'context'|'search'|'extract'|'evidence'|'claims'|'changes',payload:Record<string,unknown>,state:'retrieving'|'interpreting'|'validating'){
 const frame=JSON.stringify(payload);if(Buffer.byteLength(frame)>1048576)throw new SentinelRunError('INPUT_INVALID');
 return rpc('sentinel_save_worker_output',{...parameters(worker),p_sequence:sequence,p_kind:kind,p_frame:frame,p_hash:createHash('sha256').update(frame).digest('hex'),p_state:state},z.literal(true));
}
export async function finishWorker(worker:Worker,status:'completed'|'failed'|'budget_stopped',code:string):Promise<SentinelRun>{
 return rpc('sentinel_finish_worker',{...parameters(worker),p_status:status,p_code:code},RunProjectionSchema);
}
