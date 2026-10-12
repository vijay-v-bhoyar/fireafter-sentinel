import { recordPolicy, readPolicy, SentinelPolicyError } from "@/lib/sentinel/policies";
import { evidenceJson, evidenceLocatorFromUrl, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
import { policyFailure } from "@/lib/sentinel/policy-http";
import { runMutationBody } from "@/lib/sentinel/run-http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const loc = evidenceLocatorFromUrl(request), result = await readPolicy(loc.incidentId, loc.mode); return result === null ? evidenceUnavailable() : evidenceJson(result); }
  catch (error) { return policyFailure(error); }
}
export async function POST(request: Request) {
  try {
    if (new URL(request.url).search) throw new SentinelPolicyError("INPUT_INVALID"); const input = await runMutationBody(request);
    if (input.response) { input.response.headers.set("X-Content-Type-Options", "nosniff"); return input.response; }
    return evidenceJson(await recordPolicy(input.body));
  } catch (error) { return policyFailure(error, true); }
}
