import {sleep,FatalError} from 'workflow';
import {runSentinelStep} from '@/lib/sentinel/worker';

/** Workflow history contains only the logical run UUID and bounded step outcomes. */
export async function executeSentinel(runId:string){
 'use workflow';
 for(let index=0;index<64;index++){
  const outcome=await step(runId);
  if(outcome==='stop')return;
  if(outcome==='wait')await sleep('2s');
 }
 throw new FatalError('Sentinel orchestration bound reached; reconcile the original run.');
}
async function step(runId:string){
 'use step';
 return runSentinelStep(runId);
}
step.maxRetries=0;
