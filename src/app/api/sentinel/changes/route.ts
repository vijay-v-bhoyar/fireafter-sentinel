import { readChangePage } from "@/lib/sentinel/changes";
import { changeFailure, changeLocatorFromUrl, encodeChangeCursor } from "@/lib/sentinel/change-http";
import { evidenceJson, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET(request:Request){
  try{
    const locator=changeLocatorFromUrl(request),page=await readChangePage(locator.incidentId,locator.mode,locator.afterSequence);
    if(page===null)return evidenceUnavailable();
    const {nextAfterSequence,...body}=page;
    return evidenceJson({...body,nextCursor:nextAfterSequence===null?null:encodeChangeCursor(locator.incidentId,locator.mode,nextAfterSequence)});
  }catch(error){return changeFailure(error);}
}
