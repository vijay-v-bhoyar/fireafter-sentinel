import { readRun } from "@/lib/sentinel/runs";
import { runFailure, runLocatorFromUrl, runResponseHeaders } from "@/lib/sentinel/run-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const run = await readRun(runLocatorFromUrl(request, id));
    if (!run) return Response.json({ error: "This run is unavailable in your workspace." }, { status: 404, headers: runResponseHeaders });
    return Response.json(run, { headers: runResponseHeaders });
  } catch (error) { return runFailure(error); }
}
