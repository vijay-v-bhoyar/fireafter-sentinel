import { readHistory } from "@/lib/sentinel/briefings";
import { briefingQuery, historyCursor, briefingFailure } from "@/lib/sentinel/briefing-http";
import { evidenceJson } from "@/lib/sentinel/evidence-http";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET(request:Request){
 try{const q=briefingQuery(request,"cursor"),page=await readHistory(q.incidentId,q.mode,q.afterSequence);
  if(!page)return evidenceJson({error:"History is unavailable in this workspace."},404);
  const {nextAfterSequence,...body}=page;return evidenceJson({...body,nextCursor:nextAfterSequence===null?null:historyCursor(q.incidentId,q.mode,nextAfterSequence)});
 }catch(e){return briefingFailure(e);}
}
