import { MarkerReviewBodySchema, readMarkerReview, recordMarkerReview, SentinelMarkerReviewError } from "@/lib/sentinel/marker-reviews";
import { evidenceFailure, evidenceJson, evidenceLocatorFromUrl, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
import { runFailure, runMutationBody } from "@/lib/sentinel/run-http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
function failure(error: unknown) {
  if (error instanceof SentinelMarkerReviewError) return evidenceJson({ error: error.message, code: error.code },
    error.code === "AUTH_REQUIRED" ? 401 : error.code === "SCOPE_DENIED" ? 403 : error.code === "INPUT_INVALID" ? 400 : error.code === "REVIEW_CONFLICT" ? 409 : 503);
  return evidenceFailure(error);
}
export async function GET(request: Request, context: Context) {
  try {
    const locator = evidenceLocatorFromUrl(request), result = await readMarkerReview(locator.incidentId, locator.mode, (await context.params).id);
    return result === null ? evidenceUnavailable() : evidenceJson(result);
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    if (new URL(request.url).search) throw new SentinelMarkerReviewError("INPUT_INVALID");
    const input = await runMutationBody(request);
    if (input.response) { input.response.headers.set("X-Content-Type-Options", "nosniff"); return input.response; }
    const parsed = MarkerReviewBodySchema.safeParse(input.body);
    if (!parsed.success) throw new SentinelMarkerReviewError("INPUT_INVALID");
    return evidenceJson(await recordMarkerReview({ ...parsed.data, markerId: (await context.params).id }));
  } catch (error) {
    if (error instanceof SentinelMarkerReviewError) return failure(error);
    const response = runFailure(error); response.headers.set("X-Content-Type-Options", "nosniff"); return response;
  }
}
