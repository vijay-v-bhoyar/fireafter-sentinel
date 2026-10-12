import { prepareBriefing } from "@/lib/sentinel/briefings";
import { briefingQuery, briefingResponse, briefingFailure } from "@/lib/sentinel/briefing-http";
import { evidenceJson } from "@/lib/sentinel/evidence-http";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{revision:string}>}){
 try{const q=briefingQuery(request,"format"),{revision}=await context.params;const a=await prepareBriefing(q.incidentId,q.mode,revision,q.format);
  return a?briefingResponse(a):evidenceJson({error:"Briefing is unavailable in this workspace."},404);
 }catch(e){return briefingFailure(e);}
}
