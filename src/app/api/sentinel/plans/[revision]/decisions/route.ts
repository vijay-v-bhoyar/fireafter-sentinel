import { recordDecision, SentinelDecisionError } from "@/lib/sentinel/decisions";
import { evidenceJson } from "@/lib/sentinel/evidence-http";
import { IdSchema } from "@/lib/sentinel/contracts";
import { decisionFailure } from "@/lib/sentinel/decision-http";
import { runMutationBody } from "@/lib/sentinel/run-http";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function POST(request:Request,context:{params:Promise<{revision:string}>}){
 try{
  if(new URL(request.url).search)throw new SentinelDecisionError("INPUT_INVALID");const {revision}=await context.params;const parsed=IdSchema.safeParse(revision);
  if(!parsed.success)throw new SentinelDecisionError("INPUT_INVALID");const planRevisionId=parsed.data.toLowerCase();
  const input=await runMutationBody(request);if(input.response){input.response.headers.set("X-Content-Type-Options","nosniff");return input.response;}
  if(!input.body||typeof input.body!=="object"||Array.isArray(input.body)||Object.hasOwn(input.body,"planRevisionId"))throw new SentinelDecisionError("INPUT_INVALID");
  return evidenceJson(await recordDecision({...input.body,planRevisionId}));
 }catch(error){return decisionFailure(error,true);}
}
