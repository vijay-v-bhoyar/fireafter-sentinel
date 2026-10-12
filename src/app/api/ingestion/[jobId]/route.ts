import { z } from "zod";
import { AuthError, requireCurrentUser } from "@/lib/auth";
import { ingestionRpc, publicIngestionStatus, readIngestionJob } from "@/lib/ingestion-store";
import { dispatchIngestion } from "@/lib/ingestion-dispatch";
import { isCrossOriginMutation } from "@/lib/request-origin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ jobId: string }> };
async function handle(request: Request, context: Context, resume: boolean) {
  if (resume && isCrossOriginMutation(request)) return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });
  try {
    const user = await requireCurrentUser();
    const { jobId } = await context.params;
    if (!z.uuid().safeParse(jobId).success) throw new AuthError("Invalid operation reference", 400);
    let job = await readIngestionJob(jobId);
    if (!job || job.actor_id !== user.id || job.organization_id !== user.organizationId) throw new AuthError("Operation not found", 404);
    if (resume) {
      await ingestionRpc("fireafter_resume_ingestion", { p_id: jobId, p_actor: user.id, p_org: user.organizationId });
      job = await readIngestionJob(jobId);
      if (!job) throw new AuthError("Operation not found", 404);
      if (!["completed", "failed"].includes(job.status)) await dispatchIngestion(job);
    }
    return Response.json({ ingestion: publicIngestionStatus(job) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof AuthError ? error.message : "Operation status unavailable. Keep the original operation reference and check again." },
      { status: error instanceof AuthError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
export const GET = (request: Request, context: Context) => handle(request, context, false);
export const POST = (request: Request, context: Context) => handle(request, context, true);
