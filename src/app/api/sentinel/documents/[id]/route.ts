import { readDocumentVersion } from "@/lib/sentinel/store";
import { IdSchema } from "@/lib/sentinel/contracts";
import { SentinelSourceError } from "@/lib/sentinel/sources";
import { evidenceFailure, evidenceJson, evidenceLocatorFromUrl, evidenceUnavailable } from "@/lib/sentinel/evidence-http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const locator = evidenceLocatorFromUrl(request);
    const id = IdSchema.safeParse((await context.params).id);
    if (!id.success) throw new SentinelSourceError("INPUT_INVALID");
    const version = await readDocumentVersion(locator.incidentId, locator.mode, id.data.toLowerCase());
    return version === null ? evidenceUnavailable() : evidenceJson(version);
  } catch (error) { return evidenceFailure(error); }
}
