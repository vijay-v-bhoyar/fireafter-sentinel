import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {build} from 'esbuild';
import {openLocalWorkspace,parseAccountOptions} from './sentinel-local-accounts.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function createBatch(workspace,batch){
 if(!/^[a-z0-9][a-z0-9-]{0,40}$/.test(batch??''))throw Error('Invalid batch name.');
 const parent=path.join(workspace,'fixtures');await mkdir(parent,{recursive:true});
 if(await realpath(parent)!==parent)throw Error('Redirected fixture directory.');
 const out=path.join(parent,batch);await mkdir(out);
 await writeFile(path.join(out,'attempt.json'),JSON.stringify({status:'PREPARING',batch,mode:'synthetic',providerCalls:0}),{flag:'wx'});
 return out;
}
async function main(){
 const args=process.argv.slice(2);if(args[0]!=='--batch'||!args[1])throw Error('Use --batch NAME followed by workspace/home options.');
 const batch=args[1];const {workspace,status,manifest,sql}=await openLocalWorkspace(parseAccountOptions(args.slice(2)));
 const auth=JSON.parse(await readFile(path.join(workspace,'portable-accounts.private.json'),'utf8'));
 assert.equal(auth.stack,manifest.stack);
 const dbConfig=status.env;const out=await createBatch(workspace,batch);
const lit=v=>v===null?'null':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
await writeFile(path.join(out,'empty-server-only.mjs'),'export {};');
await build({stdin:{contents:'export {prepareDocumentVersion,evidenceHash} from '+JSON.stringify(path.join(root,'src/lib/sentinel/evidence').replaceAll('\\','/'))+'; export {nativeRowFrame} from '+JSON.stringify(path.join(root,'src/lib/sentinel/native-provenance').replaceAll('\\','/'))+';',resolveDir:root,loader:'ts'},outfile:path.join(out,'fixture-helpers.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',alias:{'server-only':path.join(out,'empty-server-only.mjs')},logLevel:'silent'});
const {prepareDocumentVersion,evidenceHash,nativeRowFrame}=await import(pathToFileURL(path.join(out,'fixture-helpers.mjs')).href);
const admin=createClient(dbConfig.API_URL,dbConfig.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
async function rpc(name,args){const {data,error}=await admin.rpc(name,args); if(error)throw Error(name+': '+error.code+' '+error.message);return data;}
const commander=auth.users.find(u=>u.role==='incident_commander'); assert.ok(commander);
const atBase=Math.floor(Date.parse(sql('select clock_timestamp();'))/60000)*60000+30*60000;
const at=mins=>new Date(atBase+mins*60000).toISOString();
const fixtures=[];
sql(`insert into public.sentinel_source_operators(organization_id,user_id) values(${lit(auth.org)},${lit(commander.userId)}) on conflict do nothing;`);
for(const branch of ['manual-approve','manual-reject','manual-modify']){
 const incident=randomUUID(),doc=randomUUID(),scope={organizationId:auth.org,incidentId:incident,mode:'synthetic'};
 const assets=[1,2,3].map(n=>({id:randomUUID(),name:`Synthetic ${branch} inspection ${n}`}));
 const configuration={schemaVersion:1,sources:[{documentId:doc,documentKey:'synthetic-notice',canonicalUrl:'https://example.gov/sentinel-fixture',issuer:'Synthetic county fixture',jurisdiction:'Synthetic fixture county',contentPermission:'full_text'}]};
 sql(`begin; insert into public.incidents(id,organization_id,county,state,title,status,storm_window,selected_fire) values(${lit(incident)},${lit(auth.org)},'Ventura County','CA',${lit('Synthetic Sentinel '+batch+' '+branch)},'active','Synthetic only',${lit({domainIncidentId:manifest.stack+'-'+batch+'-'+branch,inventoryManifest:{version:'2026-09-13-inventory-v1',revision:randomUUID(),assetIds:assets.map(a=>a.id),recommendationIds:[],sourceSnapshotIds:[]}})}::jsonb); insert into public.sentinel_incident_state(organization_id,incident_id,mode) values(${lit(auth.org)},${lit(incident)},'synthetic'); ${assets.map(a=>`insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence,local_or_uploaded,properties) values(${lit(a.id)},${lit(incident)},${lit(a.name)},'Bridge','Synthetic fixture','Synthetic approved fixture','Medium',true,${lit({domainAssetId:a.id,coordinates:[-119.2,34.4],geometry:{type:"Point",coordinates:[-119.2,34.4]},evidence:[],metrics:{}})}::jsonb);`).join(' ')} commit;`);
 const configHash=sql(`select public.sentinel_source_config_hash(${lit(configuration)}::jsonb);`);
 sql(`update public.incidents set location_context=${lit({id:'ventura-ca',county:'Ventura County',state:'CA',label:'Ventura County, CA',centroid:[-119.2,34.4],bbox:[-119.6,34,-118.6,34.7],fips:'06111',fireWeatherZone:'auto',population:1,wildfireContext:'Synthetic fixture context; not field evidence'})}::jsonb where id=${lit(incident)};`);
 for(const a of assets)sql(`update public.assets set asset_type='Bridge',confidence='Medium',local_or_uploaded=true,properties=${lit({domainAssetId:a.id,coordinates:[-119.2,34.4],geometry:{type:"Point",coordinates:[-119.2,34.4]},evidence:[],metrics:{}})}::jsonb where id=${lit(a.id)};`);
 const activated=await rpc('sentinel_activate_source_config',{p_actor_id:commander.userId,p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_command_id:randomUUID(),p_expected_config:null,p_configuration:configuration,p_config_hash:configHash});
 const source=activated.configuration?.id??activated.revision?.id??activated.receipt?.configRevision??sql(`select current_source_config_revision from public.sentinel_incident_state where incident_id=${lit(incident)} and mode='synthetic';`);
 assert.match(source,/^[a-f0-9-]{36}$/);
 const admitted=await rpc('sentinel_admit_run',{p_actor_id:commander.userId,p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_config_id:source,p_command_id:randomUUID()});
 const owner=randomUUID(); const leased=await rpc('sentinel_acquire_run_lease',{p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_run_id:admitted.run.id,p_owner:owner});
 const run=leased.run; await new Promise(resolve=>setTimeout(resolve,50)); let published; const versions=[];
 for(const text of ['Synthetic notice: Canyon Road has no recorded inspection restriction.','Synthetic notice: Canyon Road inspection requires review of the new access restriction.']){
  const version=prepareDocumentVersion({scope,documentId:doc,sourceConfigRevision:source,issuer:configuration.sources[0].issuer,jurisdiction:configuration.sources[0].jurisdiction,canonicalUrl:configuration.sources[0].canonicalUrl,rawText:text,publishedAt:at(-40),effectiveFrom:at(-90),effectiveUntil:at(540),availability:'available',contentPermission:'full_text'},{id:randomUUID(),retrievedAt:sql(`select to_char((clock_timestamp()-interval '10 milliseconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`)}).version;
  published=await rpc('sentinel_publish_evidence',{p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_run_id:run.id,p_owner:owner,p_fence:run.fence,p_command_id:randomUUID(),p_observations:[{documentId:doc,outcome:'observed',requestedAt:run.createdAt,observedBytes:version.normalizedBytes,providerRequestId:null,version}]}); versions.push(version); let baselineClaim;
  if(versions.length===1){baselineClaim={id:randomUUID(),documentVersionId:version.id,excerptStart:0,excerptEnd:version.normalizedBytes,excerpt:version.normalizedText,excerptHash:evidenceHash(version.normalizedText),kind:'general_notice',claimText:'Synthetic pre-reviewed baseline notice has no recorded restriction.',entityIds:[],modelVersion:'synthetic-fixture',promptVersion:'synthetic-fixture'};
   await rpc('sentinel_publish_claims',{p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_run_id:run.id,p_owner:owner,p_fence:run.fence,p_command_id:randomUUID(),p_expected_generation:published.receipt.evidenceGeneration,p_version_ids:[version.id],p_claims:[baselineClaim],p_transient_texts:{}});
   await rpc('sentinel_record_claim_review',{p_actor_id:commander.userId,p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_claim_id:baselineClaim.id,p_command_id:randomUUID(),p_review:{expectedEvidenceGeneration:published.receipt.evidenceGeneration,expectedReviewId:null,support:'supported',applicability:'applicable',provenance:'verified',conflict:'clear',note:'Authored synthetic baseline fixture review, not participant research.'}});
  }
  if(versions.length===1){const initialMarker=published.receipt.observations[0].markerId;
   await rpc('sentinel_publish_changes',{p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_run_id:run.id,p_owner:owner,p_fence:run.fence,p_command_id:randomUUID(),p_expected_generation:Number(sql(`select evidence_generation from public.sentinel_incident_state where incident_id=${lit(incident)} and mode='synthetic';`)),p_changes:[{id:randomUUID(),markerId:initialMarker,category:'addition',materiality:'material',claimIds:[baselineClaim.id],affectedEntityIds:[],explanation:'Authored synthetic pre-reviewed baseline, no material restriction; not real human/domain evidence.',modelVersion:'synthetic-fixture',promptVersion:'synthetic-fixture'}]});
   const context=await rpc('sentinel_read_marker_review',{p_actor_id:commander.userId,p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_marker_id:initialMarker});
   await rpc('sentinel_record_marker_review',{p_actor_id:commander.userId,p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_marker_id:initialMarker,p_command_id:randomUUID(),p_review:{expectedEvidenceGeneration:context.evidenceGeneration,expectedReviewId:context.latestReviewId,expectedReviewVectorHash:context.reviewVectorHash,changeId:context.latestChangeId,action:'resolve',materiality:'material',completeReview:true,provenance:'verified',note:'Synthetic authored pre-reviewed baseline; automated fixture preparation only.'}});
  }
 }
 const version=versions.at(-1),claim={id:randomUUID(),documentVersionId:version.id,excerptStart:0,excerptEnd:version.normalizedBytes,excerpt:version.normalizedText,excerptHash:evidenceHash(version.normalizedText),kind:'general_notice',claimText:'Synthetic changed access assumption requires human inspection review.',entityIds:assets.map(a=>a.id),modelVersion:'explicit-synthetic-fixture-no-model-call',promptVersion:'explicit-synthetic-fixture'};
 await rpc('sentinel_publish_claims',{p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_run_id:run.id,p_owner:owner,p_fence:run.fence,p_command_id:randomUUID(),p_expected_generation:published.receipt.evidenceGeneration,p_version_ids:[version.id],p_claims:[claim],p_transient_texts:{}});
 await rpc('sentinel_publish_changes',{p_organization_id:auth.org,p_incident_id:incident,p_mode:'synthetic',p_run_id:run.id,p_owner:owner,p_fence:run.fence,p_command_id:randomUUID(),p_expected_generation:published.receipt.evidenceGeneration,p_changes:[{id:randomUUID(),markerId:published.receipt.observations[0].markerId,category:'substantive',materiality:'material',claimIds:[claim.id],affectedEntityIds:assets.map(a=>a.id),explanation:'Synthetic notice pair; changed inspection access assumption. No provider execution or field determination.',modelVersion:'explicit-synthetic-fixture',promptVersion:'explicit-synthetic-fixture'}]});
 const snapshot=randomUUID(),keyId=randomUUID(),secret=randomBytes(32);
 sql(`begin; insert into public.sentinel_native_signing_keys(organization_id,id,secret_key,authority_evidence_hash,valid_from,valid_until) values(${lit(auth.org)},${lit(keyId)},decode(${lit(secret.toString('hex'))},'hex'),${lit('c'.repeat(64))},clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day'); insert into public.source_snapshots(id,incident_id,source_name,fetched_at,source_updated_at,status,stale,freshness_label,raw_payload) values(${lit(snapshot)},${lit(incident)},'Synthetic NWS fixture',${lit(at(-1))},${lit(at(-1))},'online',false,'Synthetic',${lit({sourceKey:'nws-forecast',sentinelMode:'synthetic',dataOrigin:'synthetic',coverageStatus:'available',sourceTimeBasis:'provider',validUntil:at(60)})}::jsonb); commit;`);
 sql(`update public.source_snapshots set source_key='nws-forecast',coverage_status='available' where id=${lit(snapshot)};`);
 const row=JSON.parse(sql(`select row_to_json(n) from public.source_snapshots n where id=${lit(snapshot)};`));
 const frame=nativeRowFrame(row),message=[keyId,auth.org,incident,'synthetic',frame].join('\n');
 const binding={schemaVersion:1,keyId,organizationId:auth.org,mode:'synthetic',frame,signature:createHmac('sha256',secret).update(message).digest('hex')};
 sql(`update public.source_snapshots set raw_payload=jsonb_set(raw_payload,'{sentinelNativeBinding}',${lit(binding)}::jsonb) where id=${lit(snapshot)};`);
 const nativeValid=sql(`select public.sentinel_native_binding_valid(n,${lit(auth.org)},${lit(incident)},'synthetic',${lit(at(0))}::timestamptz) from public.source_snapshots n where id=${lit(snapshot)};`); assert.equal(nativeValid,'t','synthetic fixture binding valid');
 fixtures.push({branch,scope,assets,sourceConfigRevision:source,documentId:doc,versions:versions.map(v=>v.id),claimId:claim.id,markerId:published.receipt.observations[0].markerId,runId:run.id,runOwner:owner,runFence:run.fence,nativeSnapshotId:snapshot,scenarioAt:at(0),shiftEnd:at(480),crewIds:[randomUUID(),randomUUID()],fixtureScope:'Synthetic notice/model/native records; real local PostgreSQL and RPCs. No provider or field truth.'});
 await writeFile(out+'/manual-fixtures.json',JSON.stringify({at:new Date().toISOString(),organizationId:auth.org,fixtures},null,2));
 console.log(JSON.stringify({branch,incident,seeded:true}));
}

await writeFile(path.join(out,'attempt.json'),JSON.stringify({status:'SYNTHETIC_INPUTS_SEEDED',batch,scenarios:fixtures.length,decisions:'NONE',constraints:'NOT_CONFIGURED',providerCalls:0}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Synthetic fixture setup stopped; retain the batch and inspect it before attempting any new batch.');process.exitCode=1;});
