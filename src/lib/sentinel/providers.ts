import "server-only";
import { z } from "zod";
import { IdSchema, RegisteredUrlSchema, SENTINEL_LIMITS } from "./contracts";
import { SourceConfigurationSchema } from "./publication";
import { readProviderPrice,readProviderSources,reservePricedAttempt,SentinelProviderError,type ProviderWorker,type ProviderPrice } from "./provider-budget";
import {reservedPromptInputTokens} from './prompt-tokens';
import { settleProviderAttempt } from "./runs";

const endpoints={search:'https://api.tavily.com/search',extract:'https://api.tavily.com/extract',completion:'https://api.tokenfactory.nebius.com/v1/chat/completions'} as const;
const requestId=z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const creditUsage=z.object({credits:z.number().finite().nonnegative().max(1_000_000)});
const searchResult=z.object({url:z.string().min(1).max(2048),title:z.string().max(1000),content:z.string().max(20000),score:z.number().min(0).max(1).optional(),published_date:z.string().max(100).nullable().optional()});
const searchResponse=z.object({results:z.array(searchResult).max(5),request_id:requestId,usage:creditUsage,response_time:z.number().nonnegative().optional()});
const extractResponse=z.object({results:z.array(z.object({url:RegisteredUrlSchema,raw_content:z.string(),images:z.array(z.unknown()).max(100).optional()})).max(5),failed_results:z.array(z.object({url:RegisteredUrlSchema,error:z.string().max(4000)})).max(5),request_id:requestId,usage:creditUsage});
type CompletionUsage={inputTokens:number;outputTokens:number};
type OperationContext={worker:ProviderWorker;attemptId:string;stage:string};
function configuredKey(name:string){const key=process.env[name];if(!key||key.length>4096||/[\r\n\0]/.test(key))throw new SentinelProviderError('NOT_CONFIGURED');return key;}
function validContext(c:OperationContext){IdSchema.parse(c.attemptId);if(!/^[a-z0-9_-]{1,80}$/.test(c.stage))throw new SentinelProviderError('INPUT_INVALID');}
/** Each dispatch consumes the original SQL reservation. No transport retry or endpoint redirect is automatic. */
async function dispatch<T>(c:OperationContext,price:ProviderPrice,url:string,key:string,body:unknown,inputTokens:number,outputTokens:number,parse:(value:unknown)=>{value:T;usage:CompletionUsage}){
 const reservation=await reservePricedAttempt(c.worker,price,c.attemptId,c.stage,inputTokens,outputTokens);if(!reservation.dispatchAllowed)throw new SentinelProviderError('ATTEMPT_UNAVAILABLE');
 const until=Math.min(Date.parse(reservation.dispatchDeadline),Date.parse(price.validUntil));if(until<=Date.now())throw new SentinelProviderError('ATTEMPT_UNAVAILABLE');
 let settled=false;
 try{const response=await fetch(url,{method:'POST',redirect:'error',cache:'no-store',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(Math.min(until-Date.now(),30000))});
  if(!response.ok||!response.body||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new SentinelProviderError('DELIVERY_INCOMPLETE');
  const reader=response.body.getReader(),buffer=new Uint8Array(SENTINEL_LIMITS.providerResponseBytes);let length=0;
  try{while(true){const s=await reader.read();if(s.done)break;if(length+s.value.byteLength>buffer.byteLength)throw new SentinelProviderError('DELIVERY_INCOMPLETE');buffer.set(s.value,length);length+=s.value.byteLength;}}
  catch{await reader.cancel().catch(()=>{});throw new SentinelProviderError('DELIVERY_INCOMPLETE');}finally{reader.releaseLock();}
  let result:{value:T;usage:CompletionUsage};try{result=parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length))));}catch{throw new SentinelProviderError('RESPONSE_INVALID');}
  if(result.usage.inputTokens>inputTokens||result.usage.outputTokens>outputTokens||Date.now()>=until)throw new SentinelProviderError('RESPONSE_INVALID');
  await settleProviderAttempt({...c.worker,attemptId:c.attemptId,state:'completed',...result.usage,responseBytes:length});settled=true;return {result:result.value,attemptId:c.attemptId,priceId:price.id,responseBytes:length,reservedMicroUsd:reservation.reservedMicroUsd,reservedUnits:reservation.reservedUnits};
 }catch(e){if(!settled){try{await settleProviderAttempt({...c.worker,attemptId:c.attemptId,state:'uncertain',inputTokens:null,outputTokens:null,responseBytes:null});}catch{/* Original reserved attempt remains occupied through its unchanged dispatch deadline. */}}
  if(e instanceof SentinelProviderError)throw e;throw new SentinelProviderError('DELIVERY_INCOMPLETE');}
}
export async function searchRegisteredSources(context:OperationContext,configuration:unknown){
 validContext(context);if(context.worker.scope.mode!=='live')throw new SentinelProviderError('INPUT_INVALID');
 const cfg=SourceConfigurationSchema.parse(configuration),key=configuredKey('SENTINEL_TAVILY_API_KEY'),registered=await readProviderSources(context.worker);
 if(JSON.stringify(cfg)!==JSON.stringify(registered.configuration))throw new SentinelProviderError('INPUT_INVALID');
 const query=z.string().max(500).parse(`${cfg.sources[0].issuer} ${cfg.sources[0].jurisdiction} official updates`);
 const domains=[...new Set(cfg.sources.map(s=>new URL(s.canonicalUrl).hostname))],price=await readProviderPrice(context.worker,'tavily','search',null);
 return dispatch(context,price,endpoints.search,key,{query,search_depth:'basic',max_results:5,include_domains:domains,include_domains_mode:'restrict',include_answer:false,include_raw_content:false,include_images:false,include_favicon:false,auto_parameters:false,include_usage:true},0,0,value=>{
  const r=searchResponse.parse(value);
  if(new Set(r.results.map(x=>x.url)).size!==r.results.length||Math.ceil(r.usage.credits*1_000_000)>price.requestUnits)throw Error('Unqualified discovery');
  // Provider domain filters may include sibling hosts. Never expand the registry.
  const results=r.results.filter(x=>RegisteredUrlSchema.safeParse(x.url).success&&domains.includes(new URL(x.url).hostname)),withheldResultCount=r.results.length-results.length;
  return {value:{...r,results,withheldResultCount,stage:'discovery_only' as const},usage:{inputTokens:0,outputTokens:0}};
 });
}
export async function extractRegisteredSources(context:OperationContext,configuration:unknown){
 validContext(context);if(context.worker.scope.mode!=='live')throw new SentinelProviderError('INPUT_INVALID');
 const cfg=SourceConfigurationSchema.parse(configuration),key=configuredKey('SENTINEL_TAVILY_API_KEY'),registered=await readProviderSources(context.worker);
 if(JSON.stringify(cfg)!==JSON.stringify(registered.configuration))throw new SentinelProviderError('INPUT_INVALID');
 const price=await readProviderPrice(context.worker,'tavily','extract',null),urls=cfg.sources.map(s=>s.canonicalUrl);
 return dispatch(context,price,endpoints.extract,key,{urls,extract_depth:'basic',format:'text',include_images:false,include_favicon:false,include_usage:true,timeout:20},0,0,value=>{
  const r=extractResponse.parse(value),returned=[...r.results.map(x=>x.url),...r.failed_results.map(x=>x.url)];
  if(returned.length!==urls.length||new Set(returned).size!==returned.length||returned.some(u=>!urls.includes(u))||Math.ceil(r.usage.credits*1_000_000)>price.requestUnits)throw Error('URL accounting invalid');
  const observations=urls.map(url=>{const x=r.results.find(x=>x.url===url);if(!x)return {url,outcome:'failed' as const,errorCode:'PROVIDER_URL_FAILED'};
   if(Buffer.byteLength(x.raw_content,'utf8')>SENTINEL_LIMITS.sourceBytes||!x.raw_content.trim()||x.raw_content.includes('\0')||!x.raw_content.isWellFormed())return {url,outcome:'incomplete' as const,errorCode:'CONTENT_INCOMPLETE'};
   return {url,outcome:'observed' as const,rawText:x.raw_content,representation:'tavily_extracted_text' as const,providerProvenance:'original_html_and_redirects_unattested' as const};});
  return {value:{observations,requestId:r.request_id,credits:r.usage.credits,complete:observations.every(x=>x.outcome==='observed')},usage:{inputTokens:0,outputTokens:0}};
 });
}
export type VerifiedPrompt={messages:{role:'system'|'user';content:string}[];inputTokens:number;tokenizerEvidenceHash:string};
/** The caller must provide an account/model-qualified token count, not an unverified character heuristic. */
export async function completeNemotron(context:OperationContext,operation:'extract_claims'|'compare_claims',prompt:VerifiedPrompt,outputTokens:number){
 validContext(context);const key=configuredKey('SENTINEL_NEBIUS_API_KEY'),model=configuredKey(operation==='extract_claims'?'SENTINEL_NEMOTRON_EXTRACTION_MODEL':'SENTINEL_NEMOTRON_RECONCILIATION_MODEL');
 if(!/^nvidia\/[A-Za-z0-9._/-]{1,150}$/.test(model)||!/nemotron/i.test(model)||process.env.SENTINEL_NEBIUS_BASE_URL!=='https://api.tokenfactory.nebius.com/v1/')throw new SentinelProviderError('NOT_CONFIGURED');
 z.object({messages:z.array(z.strictObject({role:z.enum(['system','user']),content:z.string().min(1).max(200000)})).min(2).max(3),inputTokens:z.number().int().min(1).max(24000),tokenizerEvidenceHash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(prompt);z.number().int().min(1).max(1000).parse(outputTokens);
 if(prompt.messages[0].role!=='system'||prompt.messages.slice(1).some(m=>m.role!=='user')||prompt.inputTokens<reservedPromptInputTokens(prompt.messages,model))throw new SentinelProviderError('INPUT_INVALID');
 if(process.env.SENTINEL_TOKENIZER_EVIDENCE_HASH!==prompt.tokenizerEvidenceHash)throw new SentinelProviderError('NOT_CONFIGURED');
 const price=await readProviderPrice(context.worker,'nebius',operation,model);
 if(price.authorityEvidenceHash!==prompt.tokenizerEvidenceHash)throw new SentinelProviderError('PRICE_UNAVAILABLE');
 return dispatch(context,price,endpoints.completion,key,{model,messages:prompt.messages,temperature:0,max_tokens:outputTokens,stream:false,chat_template_kwargs:{enable_thinking:false},response_format:{type:'json_object'}},prompt.inputTokens,outputTokens,value=>{
  const r=z.object({id:requestId,model:z.literal(model),choices:z.array(z.object({index:z.literal(0),finish_reason:z.literal('stop'),message:z.object({role:z.literal('assistant'),content:z.string().min(1).max(200000),tool_calls:z.array(z.unknown()).max(0).optional()})})).length(1),usage:z.object({prompt_tokens:z.number().int().nonnegative(),completion_tokens:z.number().int().nonnegative(),total_tokens:z.number().int().nonnegative()})}).parse(value);
  if(r.usage.total_tokens!==r.usage.prompt_tokens+r.usage.completion_tokens)throw Error('Usage inconsistent');const text=r.choices[0].message.content;
  return {value:{requestId:r.id,model:r.model,text,output:JSON.parse(text) as unknown,tokenizerEvidenceHash:prompt.tokenizerEvidenceHash},usage:{inputTokens:r.usage.prompt_tokens,outputTokens:r.usage.completion_tokens}};
 });
}
