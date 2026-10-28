import 'server-only';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DocumentVersionSchema} from './contracts';
import {prepareDocumentVersion,normalizeEvidenceText,evidenceHash,assertVersionIntegrity} from './evidence';
import {publishEvidence,PublicationResultSchema} from './publication';
import {publishClaims,ClaimDraftSchema} from './claims';
import {publishChanges} from './changes';
import {searchRegisteredSources,extractRegisteredSources,completeNemotron} from './providers';
import {acquireRunLease,renewRunLease,SentinelRunError} from './runs';
import {SentinelProviderError} from './provider-budget';
import {workerVerificationFailureCode} from './run-failure';
import {locateWorkerRun,readWorkerContext,readWorkerClock,saveWorkerOutput,finishWorker,type Worker} from './execution-store';
import {executionId,extractionPrompt,extractClaims,comparisonPrompt,extractChanges,EXTRACTION_PROMPT,type ComparisonPair} from './interpretation';

const EvidenceStageSchema=z.strictObject({versions:z.array(z.strictObject({documentId:z.uuid(),versionId:z.uuid(),changed:z.boolean()})).min(1).max(5)});
const ExtractionStageSchema=z.strictObject({requestedAt:z.string(),providerRequestId:z.string().nullable(),observations:z.array(z.strictObject({documentId:z.uuid(),rawText:z.string(),publishedAt:z.string().nullable(),effectiveFrom:z.string().nullable(),effectiveUntil:z.string().nullable(),retrievedAt:z.string()})).min(1).max(5)});
const ClaimsStageSchema=z.strictObject({documentId:z.uuid(),versionId:z.uuid(),claims:z.array(ClaimDraftSchema).max(4),reused:z.boolean()});
export async function runSentinelStep(runId:string):Promise<'continue'|'wait'|'stop'>{
 let worker:Worker|undefined;
 try{
  const run=await locateWorkerRun(runId);
  if(!['queued','retrieving','interpreting','validating'].includes(run.status)||Date.parse(run.deadlineAt)<=Date.now())return 'stop';
  const leased=await acquireRunLease({scope:run.scope,runId,owner:randomUUID()});worker={scope:run.scope,runId,owner:leased.owner,fence:leased.run.fence};
  const ctx=await readWorkerContext(worker),sequence=ctx.outputs.length;
  if(ctx.configuration.sources.some(s=>s.contentPermission!=='full_text'))throw new Error('RETENTION_UNSUPPORTED');
  const saved=async(kind:'context'|'search'|'extract'|'evidence'|'claims'|'changes',payload:Record<string,unknown>,state:'retrieving'|'interpreting'|'validating')=>{
   await saveWorkerOutput(worker!,sequence,kind,payload,state);return 'continue' as const;
  };
  const operation=(stage:string)=>({worker:worker!,attemptId:executionId(runId,`attempt-${stage}`),stage});
  if(sequence===0)return await saved('context',{configuration:ctx.configuration,versionIds:ctx.versions.map(v=>v.versionId),assetIds:ctx.assets.map(a=>a.id)},'retrieving');
  if(sequence===1){
   if(run.scope.mode!=='live')return await saved('search',{mode:run.scope.mode,source:'retained_corpus',providerCalled:false},'retrieving');
   await renewRunLease(worker);const response=await searchRegisteredSources(operation('search'),ctx.configuration);
   return await saved('search',{requestId:response.result.request_id,results:response.result.results.map(c=>({url:c.url,title:c.title})),withheldResultCount:response.result.withheldResultCount,source:'discovery_only'},'retrieving');
  }
  if(sequence===2){
   const requestedAt=run.scope.mode==='live'?await readWorkerClock(worker):new Date().toISOString();
   if(run.scope.mode!=='live'){
    if(ctx.versions.length!==ctx.configuration.sources.length||ctx.versions.some(v=>v.current.normalizedText===null||v.current.availability!=='available'))throw new Error('CORPUS_INCOMPLETE');
    return await saved('extract',{requestedAt,providerRequestId:null,observations:ctx.versions.map(v=>({documentId:v.documentId,rawText:v.current.normalizedText!,publishedAt:v.current.publishedAt,effectiveFrom:v.current.effectiveFrom,effectiveUntil:v.current.effectiveUntil,retrievedAt:v.current.retrievedAt}))},'retrieving');
   }
   await renewRunLease(worker);const response=await extractRegisteredSources(operation('extract'),ctx.configuration),retrievedAt=await readWorkerClock(worker);
   if(!response.result.complete){
    const observations=ctx.configuration.sources.map(s=>{
     const item=response.result.observations.find(o=>o.url===s.canonicalUrl);
     if(item?.outcome==='observed'&&item.rawText!==undefined){
      const previous=ctx.versions.find(v=>v.documentId===s.documentId)?.current,unchanged=previous?.normalizedHash===evidenceHash(normalizeEvidenceText(item.rawText));
      const version=prepareDocumentVersion({scope:run.scope,documentId:s.documentId,sourceConfigRevision:run.sourceConfigRevision,issuer:s.issuer,jurisdiction:s.jurisdiction,canonicalUrl:s.canonicalUrl,rawText:item.rawText,publishedAt:unchanged?previous!.publishedAt:null,effectiveFrom:unchanged?previous!.effectiveFrom:null,effectiveUntil:unchanged?previous!.effectiveUntil:null,availability:'available',contentPermission:'full_text'},{id:executionId(runId,`version-${s.documentId}`),retrievedAt}).version;
      return {documentId:s.documentId,requestedAt,observedBytes:Buffer.byteLength(item.rawText),providerRequestId:response.result.requestId,outcome:'observed' as const,version};
     }
     return {documentId:s.documentId,requestedAt,observedBytes:0,providerRequestId:response.result.requestId,outcome:item?.outcome==='failed'?'failed' as const:'incomplete' as const,safeErrorCode:item?.outcome==='failed'?'SOURCE_UNAVAILABLE' as const:'PROVIDER_PARTIAL' as const};
    });
    await publishEvidence({...worker,commandId:executionId(runId,'partial-evidence'),observations});
    throw new Error('RETRIEVAL_INCOMPLETE');
   }
   const observations=ctx.configuration.sources.map(s=>{
    const item=response.result.observations.find(o=>o.url===s.canonicalUrl);if(!item||item.outcome!=='observed'||item.rawText===undefined)throw new Error('RETRIEVAL_INCOMPLETE');
    const previous=ctx.versions.find(v=>v.documentId===s.documentId)?.current;
    const unchanged=previous?.normalizedHash===evidenceHash(normalizeEvidenceText(item.rawText));
    return {documentId:s.documentId,rawText:item.rawText,publishedAt:unchanged?previous!.publishedAt:null,effectiveFrom:unchanged?previous!.effectiveFrom:null,effectiveUntil:unchanged?previous!.effectiveUntil:null,retrievedAt};
   });
   return await saved('extract',{requestedAt,providerRequestId:response.result.requestId,observations},'retrieving');
  }
  if(sequence===3){
   const extraction=ExtractionStageSchema.parse(ctx.outputs[2].payload);
   if(run.scope.mode!=='live')return await saved('evidence',{versions:ctx.versions.map(v=>({documentId:v.documentId,versionId:v.versionId,changed:false}))},'interpreting');
   const observations=extraction.observations.map(o=>{
    const source=ctx.configuration.sources.find(s=>s.documentId===o.documentId);if(!source)throw new Error('SOURCE_CONFIGURATION_CHANGED');
    const version=prepareDocumentVersion({scope:run.scope,documentId:o.documentId,sourceConfigRevision:run.sourceConfigRevision,issuer:source.issuer,jurisdiction:source.jurisdiction,canonicalUrl:source.canonicalUrl,rawText:o.rawText,publishedAt:o.publishedAt,effectiveFrom:o.effectiveFrom,effectiveUntil:o.effectiveUntil,availability:'available',contentPermission:'full_text'},{id:executionId(runId,`version-${o.documentId}`),retrievedAt:o.retrievedAt}).version;
    return {documentId:o.documentId,requestedAt:extraction.requestedAt,observedBytes:Buffer.byteLength(o.rawText),providerRequestId:extraction.providerRequestId,outcome:'observed' as const,version};
   });
   const publication=await publishEvidence({...worker,commandId:executionId(runId,'evidence'),observations});PublicationResultSchema.parse(publication);
   return await saved('evidence',{versions:publication.receipt.observations.map(o=>({documentId:o.documentId,versionId:o.versionId,changed:o.changed}))},'interpreting');
  }
  const evidence=EvidenceStageSchema.parse(ctx.outputs[3].payload),documents=ctx.configuration.sources;
  if(sequence<4+documents.length){
   const source=documents[sequence-4],reference=evidence.versions.find(v=>v.documentId===source.documentId),current=ctx.versions.find(v=>v.documentId===source.documentId)?.current;
   if(!reference||!current||current.id!==reference.versionId)throw new Error('EVIDENCE_CHANGED');
   const model=process.env.SENTINEL_NEMOTRON_EXTRACTION_MODEL;
   const old=ctx.claims.filter(c=>c.documentVersionId===current.id);
   if(!reference.changed&&old.length>0&&old.length<=4&&old.every(c=>c.modelVersion===model&&c.promptVersion===EXTRACTION_PROMPT)){
    for(const c of old){const bytes=Buffer.from(current.normalizedText??'');if(bytes.subarray(c.excerptStart,c.excerptEnd).toString()!==c.excerpt||evidenceHash(c.excerpt)!==c.excerptHash)throw new Error('CITATION_INVALID');}
    return await saved('claims',{documentId:source.documentId,versionId:current.id,claims:old,reused:true},'interpreting');
   }
   await renewRunLease(worker);const result=await completeNemotron(operation(`claims_${sequence-4}`),'extract_claims',extractionPrompt(current),1000);
   const claims=extractClaims(result.result.output,current,ctx.assets,runId,result.result.model);
   await publishClaims({...worker,commandId:executionId(runId,`claims-${source.documentId}`),expectedEvidenceGeneration:ctx.evidenceGeneration,versionIds:[current.id],claims});
   return await saved('claims',{documentId:source.documentId,versionId:current.id,claims,reused:false},'interpreting');
  }
  if(sequence===4+documents.length){
   const claimStages=ctx.outputs.filter(o=>o.kind==='claims').map(o=>ClaimsStageSchema.parse(o.payload)),pairs:ComparisonPair[]=[];
   for(const version of ctx.versions){
    const ref=evidence.versions.find(r=>r.documentId===version.documentId),stage=claimStages.find(c=>c.versionId===version.current.id);
    if(!ref||ref.versionId!==version.current.id||!stage)throw new Error('EVIDENCE_CHANGED');
    if(version.markerId&&(ref.changed||!version.hasComparison||!stage.reused))pairs.push({markerId:version.markerId,current:assertVersionIntegrity(version.current),previous:version.previous?DocumentVersionSchema.parse(version.previous):null,claims:stage.claims});
   }
   if(pairs.length){
    await renewRunLease(worker);const result=await completeNemotron(operation('comparison'),'compare_claims',comparisonPrompt(pairs),1000);
    const changes=extractChanges(result.result.output,pairs,runId,result.result.model);
    await publishChanges({...worker,commandId:executionId(runId,'changes'),expectedEvidenceGeneration:ctx.evidenceGeneration,changes});
    return await saved('changes',{changeIds:changes.map(c=>c.id),compared:pairs.length,semanticAccepted:false},'validating');
   }
   return await saved('changes',{changeIds:[],compared:0,semanticAccepted:false},'validating');
  }
  await finishWorker(worker,'completed','published');return 'stop';
 }catch(error){
  if(error instanceof SentinelRunError&&['RUN_BUSY','STORAGE_UNAVAILABLE'].includes(error.code))return 'wait';
  if(worker){try{const budget=(error instanceof SentinelRunError||error instanceof SentinelProviderError)&&error.code==='BUDGET_STOPPED';const code=error instanceof SentinelProviderError?'provider_'+error.code.toLowerCase():error instanceof SentinelRunError?'run_'+error.code.toLowerCase():workerVerificationFailureCode(error);await finishWorker(worker,budget?'budget_stopped':'failed',code);}catch{/* Revoked, canceled or expired work cannot reacquire mutation authority. */}}
  return 'stop';
 }
}
