import { readPlanDraft } from "@/lib/sentinel/plans";
import { evidenceJson, evidenceLocatorFromUrl, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
import { planFailure } from "@/lib/sentinel/plan-http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ revision: string }> }) {
  try {
    const loc = evidenceLocatorFromUrl(request), result = await readPlanDraft(loc.incidentId, loc.mode, (await context.params).revision);
    return result === null ? evidenceUnavailable() : evidenceJson(result);
  } catch (error) { return planFailure(error); }
}
