import { createPlanDraft, readPlanDraft, SentinelPlanError } from "@/lib/sentinel/plans";
import { evidenceJson, evidenceLocatorFromUrl, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
import { planFailure } from "@/lib/sentinel/plan-http";
import { runMutationBody } from "@/lib/sentinel/run-http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const loc = evidenceLocatorFromUrl(request), result = await readPlanDraft(loc.incidentId, loc.mode); return result === null ? evidenceUnavailable() : evidenceJson(result); }
  catch (error) { return planFailure(error); }
}
export async function POST(request: Request) {
  try {
    if (new URL(request.url).search) throw new SentinelPlanError("INPUT_INVALID"); const input = await runMutationBody(request);
    if (input.response) { input.response.headers.set("X-Content-Type-Options", "nosniff"); return input.response; }
    return evidenceJson(await createPlanDraft(input.body));
  } catch (error) { return planFailure(error, true); }
}
