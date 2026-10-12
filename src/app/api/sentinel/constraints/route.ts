import { recordConstraints, readConstraints, SentinelConstraintError } from "@/lib/sentinel/constraints";
import { evidenceFailure, evidenceJson, evidenceLocatorFromUrl, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
import { runFailure, runMutationBody } from "@/lib/sentinel/run-http";
import { proposeTaskAssignments } from "@/lib/sentinel/planning";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
function failure(error: unknown) {
  if (error instanceof SentinelConstraintError) return evidenceJson({ error: error.message, code: error.code },
    error.code === "AUTH_REQUIRED" ? 401 : error.code === "SCOPE_DENIED" ? 403 : error.code === "INPUT_INVALID" ? 400 : error.code === "CONSTRAINT_CONFLICT" ? 409 : 503);
  return evidenceFailure(error);
}
export async function GET(request: Request) {
  try {
    const locator = evidenceLocatorFromUrl(request), data = await readConstraints(locator.incidentId, locator.mode);
    return data === null ? evidenceUnavailable() : evidenceJson({ ...data, assessmentScope: "authored_constraints_only",
      allocation: data.revision === null ? null : proposeTaskAssignments(data.revision.configuration) });
  }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    if (new URL(request.url).search) throw new SentinelConstraintError("INPUT_INVALID");
    const input = await runMutationBody(request); if (input.response) { input.response.headers.set("X-Content-Type-Options", "nosniff"); return input.response; }
    return evidenceJson(await recordConstraints(input.body));
  } catch (error) { if (error instanceof SentinelConstraintError) return failure(error); const response = runFailure(error); response.headers.set("X-Content-Type-Options", "nosniff"); return response; }
}
