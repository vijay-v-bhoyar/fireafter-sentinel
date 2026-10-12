import { readDecisionCommand, SentinelDecisionError } from "@/lib/sentinel/decisions";
import { evidenceJson } from "@/lib/sentinel/evidence-http";
import { decisionFailure } from "@/lib/sentinel/decision-http";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET(request:Request){
 try{const q=new URL(request.url).searchParams,keys=[...q.keys()];
  if(keys.length!==3||new Set(keys).size!==3||keys.some(k=>!["incidentId","mode","commandId"].includes(k)))throw new SentinelDecisionError("INPUT_INVALID");
  const result=await readDecisionCommand(q.get("incidentId")!,q.get("mode")!,q.get("commandId")!);
  return evidenceJson({status:result===null?"not_observed":"confirmed",result});
 }catch(error){return decisionFailure(error);}
}
