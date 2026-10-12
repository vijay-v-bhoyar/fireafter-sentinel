import 'server-only';
import {randomUUID} from 'node:crypto';
import {start,getRun} from 'workflow/api';
import {executeSentinel} from '@/workflows/sentinel';
import {RunProjectionSchema,type SentinelRun} from './contracts';
import {dispatchState,claimDispatch,acknowledgeDispatch} from './execution-store';

/** Admission is already durable. An uncertain scheduler response never means rollback. */
export async function dispatchSentinel(runInput:SentinelRun):Promise<{dispatchPending:boolean}>{
 const run=RunProjectionSchema.parse(runInput);
 try{
  const state=await dispatchState(run.id);
  if(state.run.scope.organizationId!==run.scope.organizationId||state.run.scope.incidentId!==run.scope.incidentId||state.run.scope.mode!==run.scope.mode)throw new Error('Dispatch scope mismatch');
  if(!['queued','retrieving','interpreting','validating'].includes(state.run.status)||Date.parse(state.run.deadlineAt)<=Date.now())return {dispatchPending:false};
  let runtimeTerminal=false;
  if(state.runtimeRunId){
   const status=await getRun(state.runtimeRunId).status;
   if(status==='pending'||status==='running')return {dispatchPending:false};
   runtimeTerminal=['failed','cancelled','completed'].includes(status);
  }
  const claim=await claimDispatch(run.id,randomUUID(),state.attemptId,runtimeTerminal);
  if(!claim)return {dispatchPending:true};
  const scheduled=await start(executeSentinel,[claim.dispatchId]);
  await acknowledgeDispatch(run.id,claim.attemptId,scheduled.runId);
  return {dispatchPending:false};
 }catch{return {dispatchPending:true};}
}
