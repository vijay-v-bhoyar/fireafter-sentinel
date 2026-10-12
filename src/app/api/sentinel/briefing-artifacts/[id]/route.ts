import { readBriefing } from "@/lib/sentinel/briefings";
import { briefingQuery, briefingResponse, briefingFailure } from "@/lib/sentinel/briefing-http";
import { evidenceJson } from "@/lib/sentinel/evidence-http";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){
 try{const q=briefingQuery(request),{id}=await context.params;const a=await readBriefing(q.incidentId,q.mode,id);
  return a?briefingResponse(a):evidenceJson({error:"Briefing is unavailable in this workspace."},404);
 }catch(e){return briefingFailure(e);}
}
