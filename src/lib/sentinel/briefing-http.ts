import "server-only";
import { z } from "zod";
import { IdSchema, ModeSchema } from "./contracts";
import { evidenceJson, evidenceResponseHeaders } from "./evidence-http";
import { SentinelBriefingError } from "./briefings";
import type { BriefingReceipt } from "./briefing-contracts";
const id=IdSchema.transform(v=>v.toLowerCase());
const cursorSchema=z.strictObject({v:z.literal(1),kind:z.literal("sentinel_history"),incidentId:id,mode:ModeSchema,afterSequence:z.number().int().positive().safe()});
export function historyCursor(incidentId:string,mode:string,afterSequence:number){return Buffer.from(JSON.stringify(cursorSchema.parse({v:1,kind:"sentinel_history",incidentId,mode,afterSequence})),"utf8").toString("base64url");}
export function briefingQuery(request:Request,extra:"format"|"cursor"|null=null){
 const p=new URL(request.url).searchParams,allowed=["incidentId","mode",...(extra?[extra]:[])];
 if([...p.keys()].some(k=>!allowed.includes(k))||p.getAll("incidentId").length!==1||p.getAll("mode").length!==1||extra&&p.getAll(extra).length>1)throw new SentinelBriefingError("INPUT_INVALID");
 const c=z.strictObject({incidentId:id,mode:ModeSchema}).safeParse({incidentId:p.get("incidentId"),mode:p.get("mode")});if(!c.success)throw new SentinelBriefingError("INPUT_INVALID");
 const format=p.get("format")??"json";if(extra==="format"&&!["json","html"].includes(format))throw new SentinelBriefingError("INPUT_INVALID");
 let afterSequence=0;const token=p.get("cursor");
 if(token!==null){try{if(!/^[A-Za-z0-9_-]{1,256}$/.test(token))throw Error();const x=cursorSchema.parse(JSON.parse(Buffer.from(token,"base64url").toString("utf8")));
  if(x.incidentId!==c.data.incidentId||x.mode!==c.data.mode||historyCursor(x.incidentId,x.mode,x.afterSequence)!==token)throw Error();afterSequence=x.afterSequence;
 }catch{throw new SentinelBriefingError("INPUT_INVALID");}}
 return {...c.data,format:format as "json"|"html",afterSequence};
}
export function briefingResponse(a:{content:string;receipt:BriefingReceipt}){
 const r=a.receipt;return new Response(a.content,{headers:{...evidenceResponseHeaders,"Content-Type":r.format==="json"?"application/json; charset=utf-8":"text/html; charset=utf-8",
 "Content-Disposition":`attachment; filename="sentinel-${r.planRevisionId}.${r.format}"`,"X-Sentinel-Artifact-Bytes":String(r.contentBytes),"X-Sentinel-Artifact-SHA256":r.contentHash,
 "X-Sentinel-Artifact-Receipt":Buffer.from(JSON.stringify(r),"utf8").toString("base64url"),"Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
}
export function briefingFailure(e:unknown){const error=e instanceof SentinelBriefingError?e:new SentinelBriefingError("STORAGE_UNAVAILABLE");
 const status={AUTH_REQUIRED:401,SCOPE_DENIED:403,INPUT_INVALID:400,CAPACITY_EXCEEDED:413,STORAGE_UNAVAILABLE:503}[error.code];return evidenceJson({error:error.message,code:error.code},status);}
