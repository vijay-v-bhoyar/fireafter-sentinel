import { admitRun } from "@/lib/sentinel/runs";
import {dispatchSentinel} from "@/lib/sentinel/dispatch";
import { runFailure, runMutationBody, runResponseHeaders } from "@/lib/sentinel/run-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const input = await runMutationBody(request);
    if (input.response) return input.response;
    const result = await admitRun(input.body);
    const dispatch = await dispatchSentinel(result.run);
    const statusUrl = `/api/sentinel/runs/${result.run.id}?incidentId=${result.run.scope.incidentId}&mode=${result.run.scope.mode}`;
    return Response.json({ ...result, ...dispatch, runId: result.run.id, statusUrl }, { status: 202, headers: runResponseHeaders });
  } catch (error) { return runFailure(error); }
}
