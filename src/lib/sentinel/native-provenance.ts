import "server-only";
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {IdSchema,ModeSchema} from './contracts';
export const NativeAcquisitionSchema=z.strictObject({schemaVersion:z.literal(1),keyId:IdSchema,organizationId:IdSchema,incidentAlias:z.string().min(1).max(256),mode:ModeSchema,contentHash:z.string().regex(/^[a-f0-9]{64}$/),signature:z.string().regex(/^[a-f0-9]{64}$/)});
export type NativeAcquisition=z.infer<typeof NativeAcquisitionSchema>;
type Source={sourceKey?:string;sourceUrl?:string;sourceName:string;fetchedAt:string;sourceUpdatedAt:string;sourceTimeBasis?:string;validUntil?:string;status:string;coverageStatus?:string;rawPayload?:Record<string,unknown>;derivedSignals?:object;nativeAcquisition?:NativeAcquisition};
function key(){const id=process.env.SENTINEL_NATIVE_SIGNING_KEY_ID,org=process.env.SENTINEL_NATIVE_SIGNING_ORGANIZATION_ID,secret=process.env.SENTINEL_NATIVE_SIGNING_KEY_HEX;
 if(!IdSchema.safeParse(id).success||!IdSchema.safeParse(org).success||!secret||!/^[a-f0-9]{64}$/.test(secret))return null;return {id:id!.toLowerCase(),org:org!.toLowerCase(),secret:Buffer.from(secret,'hex')};}
function stable(value:unknown):string{return JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
function content(source:Source){return createHash('sha256').update(stable([source.sourceKey??null,source.sourceUrl??null,source.sourceName,instant(source.fetchedAt),instant(source.sourceUpdatedAt),source.sourceTimeBasis??'unknown',instant(source.validUntil),source.status,source.coverageStatus??'not_available',source.rawPayload??{},source.derivedSignals??{}])).digest('hex');}
function signature(secret:Buffer,text:string){return createHmac('sha256',secret).update(text,'utf8').digest('hex');}
function acquisitionText(a:Omit<NativeAcquisition,'signature'>){return JSON.stringify(['sentinel-acquisition-v1',a.keyId,a.organizationId,a.incidentAlias,a.mode,a.contentHash]);}
/** Call only at a closed fresh-adapter boundary. Cached/custom results must retain an existing verified seal. */
export function sealNativeAcquisition<T extends Source>(source:T,incidentAlias:string,mode:z.infer<typeof ModeSchema>):T&{nativeAcquisition?:NativeAcquisition}{
 const configured=key();if(!configured)return source;
 const unsigned={schemaVersion:1 as const,keyId:configured.id,organizationId:configured.org,incidentAlias,mode:ModeSchema.parse(mode),contentHash:content(source)};
 const acquisition=NativeAcquisitionSchema.parse({...unsigned,signature:signature(configured.secret,acquisitionText(unsigned))});return {...source,nativeAcquisition:acquisition};
}
export function verifiedNativeAcquisition(source:Source,incidentAlias:string,organizationId?:string){
 try{const configured=key(),parsed=NativeAcquisitionSchema.safeParse(source.nativeAcquisition);if(!configured||!parsed.success)return null;const a=parsed.data;
  if(a.keyId!==configured.id||a.organizationId!==configured.org||organizationId!==undefined&&a.organizationId!==organizationId.toLowerCase()||a.incidentAlias!==incidentAlias||a.contentHash!==content(source))return null;
  const {signature:given,...unsigned}=a;if(!timingSafeEqual(Buffer.from(given,'hex'),Buffer.from(signature(configured.secret,acquisitionText(unsigned)),'hex')))return null;return a;
 }catch{return null;}
}
const instant=(value:unknown)=>{if(value===null||value===undefined||value==='')return null;const date=new Date(String(value));return Number.isFinite(date.getTime())?date.toISOString():null;};
/** Mirrors the SQL stored-row projection; JSONB comparison handles object order and numeric serialization. */
export function nativeRowFrame(row:Record<string,unknown>){const raw={...(row.raw_payload as Record<string,unknown>)};delete raw.sentinelNativeBinding;
 return JSON.stringify({id:row.id,incident_id:row.incident_id,source_name:row.source_name,fetched_at:instant(row.fetched_at),source_updated_at:instant(row.source_updated_at),status:row.status,stale:row.stale,freshness_label:row.freshness_label,
  source_key:row.source_key??null,source_url:row.source_url??null,coverage_status:row.coverage_status??null,warnings:row.warnings??null,derived_signals:row.derived_signals??null,raw_payload:raw});}
export function bindNativeRow<T extends {id:string;incident_id:string;raw_payload:Record<string,unknown>}>(row:T,source:Source,incidentAlias:string,organizationId:string):T{
 const acquisition=verifiedNativeAcquisition(source,incidentAlias,organizationId),configured=key();if(!acquisition||!configured)return row;
 const raw={...row.raw_payload,sentinelMode:acquisition.mode,dataOrigin:acquisition.mode,nativeAcquisition:acquisition};delete (raw as Record<string,unknown>).sentinelNativeBinding;
 const unsigned={...row,raw_payload:raw},frame=nativeRowFrame(unsigned);if(Buffer.byteLength(frame,'utf8')>1048576)return row;
 const text=[configured.id,configured.org,row.incident_id.toLowerCase(),acquisition.mode,frame].join('\n');
 return {...unsigned,raw_payload:{...raw,sentinelNativeBinding:{schemaVersion:1,keyId:configured.id,organizationId:configured.org,mode:acquisition.mode,frame,signature:signature(configured.secret,text)}}};
}
