import { readSourceChangePage } from "@/lib/sentinel/sources";
import { encodeSourceChangeCursor, evidenceFailure, evidenceJson, evidenceLocatorFromUrl, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const locator = evidenceLocatorFromUrl(request, true);
    const page = await readSourceChangePage(locator.incidentId, locator.mode, locator.afterGeneration);
    if (page === null) return evidenceUnavailable();
    const { nextAfterGeneration, ...projection } = page;
    const nextCursor = nextAfterGeneration === null ? null : encodeSourceChangeCursor(locator.incidentId, locator.mode, nextAfterGeneration);
    return evidenceJson({ ...projection, nextCursor });
  } catch (error) { return evidenceFailure(error); }
}
