import "server-only";
import { SentinelDecisionError } from "./decisions";
import { evidenceJson, evidenceFailure } from "./evidence-http";
import { runFailure } from "./run-http";
export function decisionFailure(error:unknown,mutation=false){
 if(error instanceof SentinelDecisionError)return evidenceJson({error:error.message,code:error.code},error.code==="AUTH_REQUIRED"?401:error.code==="SCOPE_DENIED"?403:error.code==="INPUT_INVALID"?400:error.code==="DECISION_CONFLICT"?409:503);
 const response=mutation?runFailure(error):evidenceFailure(error);response.headers.set("X-Content-Type-Options","nosniff");return response;
}
