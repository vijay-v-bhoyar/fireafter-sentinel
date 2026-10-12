import { previewPlanAdmission, SentinelPolicyError } from "@/lib/sentinel/policies";
import { evidenceJson, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
import { policyFailure } from "@/lib/sentinel/policy-http";
import { runMutationBody } from "@/lib/sentinel/run-http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    if (new URL(request.url).search) throw new SentinelPolicyError("INPUT_INVALID"); const input = await runMutationBody(request);
    if (input.response) { input.response.headers.set("X-Content-Type-Options", "nosniff"); return input.response; }
    const result = await previewPlanAdmission(input.body); return result === null ? evidenceUnavailable() : evidenceJson(result);
  } catch (error) { return policyFailure(error, true); }
}
