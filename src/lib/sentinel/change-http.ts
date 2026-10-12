import "server-only";
import { z } from "zod";
import { IdSchema, ModeSchema } from "./contracts";
import { SentinelChangeError } from "./changes";
import { evidenceFailure, evidenceJson } from "./evidence-http";
const locator=z.strictObject({incidentId:IdSchema.transform(v=>v.toLowerCase()),mode:ModeSchema});
const cursor=locator.extend({v:z.literal(1),afterSequence:z.number().int().positive().safe()});
export function encodeChangeCursor(incidentId:string,mode:string,afterSequence:number){
  return Buffer.from(JSON.stringify(cursor.parse({v:1,incidentId,mode,afterSequence})),"utf8").toString("base64url");
}
export function changeLocatorFromUrl(request:Request){
  const params=new URL(request.url).searchParams;
  if(Array.from(params.keys()).some(k=>!["incidentId","mode","cursor"].includes(k)) || params.getAll("incidentId").length!==1 || params.getAll("mode").length!==1 || params.getAll("cursor").length>1)
    throw new SentinelChangeError("INPUT_INVALID");
  const parsed=locator.safeParse({incidentId:params.get("incidentId"),mode:params.get("mode")});if(!parsed.success)throw new SentinelChangeError("INPUT_INVALID");
  const token=params.get("cursor");if(token===null)return {...parsed.data,afterSequence:0};
  try{
    if(!/^[A-Za-z0-9_-]{1,256}$/.test(token))throw new Error("Invalid token");
    const c=cursor.parse(JSON.parse(Buffer.from(token,"base64url").toString("utf8")));
    if(c.incidentId!==parsed.data.incidentId || c.mode!==parsed.data.mode || encodeChangeCursor(c.incidentId,c.mode,c.afterSequence)!==token)throw new Error("Invalid cursor scope");
    return {...parsed.data,afterSequence:c.afterSequence};
  }catch{throw new SentinelChangeError("INPUT_INVALID");}
}
export function changeFailure(error:unknown){
  if(error instanceof SentinelChangeError)return evidenceJson({error:error.message,code:error.code},error.code==="AUTH_REQUIRED"?401:error.code==="SCOPE_DENIED"?403:error.code==="INPUT_INVALID"?400:error.code==="CHANGE_CONFLICT"?409:503);
  return evidenceFailure(error);
}
