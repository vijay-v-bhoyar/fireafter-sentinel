import { cancelRun, SentinelRunError } from "@/lib/sentinel/runs";
import { RunCancelSchema } from "@/lib/sentinel/contracts";
import { runFailure, runMutationBody, runResponseHeaders } from "@/lib/sentinel/run-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const input = await runMutationBody(request);
    if (input.response) return input.response;
    const parsed = RunCancelSchema.omit({ runId: true }).safeParse(input.body);
    if (!parsed.success) throw new SentinelRunError("INPUT_INVALID");
    const { id } = await context.params;
    return Response.json(await cancelRun({ ...parsed.data, runId: id }), { headers: runResponseHeaders });
  } catch (error) { return runFailure(error); }
}
