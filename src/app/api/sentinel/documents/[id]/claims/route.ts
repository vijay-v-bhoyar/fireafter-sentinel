import { z } from "zod";
import { IdSchema, ModeSchema } from "@/lib/sentinel/contracts";
import { readClaimPage } from "@/lib/sentinel/claims";
import { SentinelRunError } from "@/lib/sentinel/runs";
import { evidenceJson, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
import { runFailure } from "@/lib/sentinel/run-http";
export const dynamic="force-dynamic";
export const runtime="nodejs";
const id=IdSchema.transform(v=>v.toLowerCase());
const cursor=z.strictObject({v:z.literal(1),kind:z.literal("claim_page"),incidentId:id,mode:ModeSchema,versionId:id,afterSequence:z.number().int().positive().safe()});
const encode=(c:z.infer<typeof cursor>)=>Buffer.from(JSON.stringify(c),"utf8").toString("base64url");
export async function GET(request:Request,context:{params:Promise<{id:string}>}){
 try{const p=new URL(request.url).searchParams,{id:version}=await context.params;
  if([...p.keys()].some(k=>!["incidentId","mode","cursor"].includes(k))||p.getAll("incidentId").length!==1||p.getAll("mode").length!==1||p.getAll("cursor").length>1)throw new SentinelRunError("INPUT_INVALID");
  const loc=z.strictObject({incidentId:id,mode:ModeSchema,versionId:id}).safeParse({incidentId:p.get("incidentId"),mode:p.get("mode"),versionId:version});if(!loc.success)throw new SentinelRunError("INPUT_INVALID");
  let afterSequence=0;const token=p.get("cursor");if(token!==null){try{if(!/^[A-Za-z0-9_-]{1,256}$/.test(token))throw Error();const c=cursor.parse(JSON.parse(Buffer.from(token,"base64url").toString("utf8")));
   if(encode(c)!==token||c.incidentId!==loc.data.incidentId||c.mode!==loc.data.mode||c.versionId!==loc.data.versionId)throw Error();afterSequence=c.afterSequence;
  }catch{throw new SentinelRunError("INPUT_INVALID");}}
  const page=await readClaimPage(loc.data.incidentId,loc.data.mode,loc.data.versionId,afterSequence);if(!page)return evidenceUnavailable();
  const {nextAfterSequence,...body}=page;return evidenceJson({...body,nextCursor:nextAfterSequence===null?null:encode({v:1,kind:"claim_page",...loc.data,afterSequence:nextAfterSequence})});
 }catch(e){return runFailure(e);}
}
