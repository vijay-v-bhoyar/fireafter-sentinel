import { readEvidenceSummary } from "@/lib/sentinel/sources";
import { evidenceFailure, evidenceJson, evidenceLocatorFromUrl, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const locator = evidenceLocatorFromUrl(request);
    const summary = await readEvidenceSummary(locator.incidentId, locator.mode);
    return summary === null ? evidenceUnavailable() : evidenceJson(summary);
  } catch (error) { return evidenceFailure(error); }
}
