import { z } from "zod";
import { AuthError, requireIncidentAccess } from "@/lib/auth";
import { lookupResponderCommandReceipt } from "@/lib/responder-recovery-server";
import { responderCommandFailure, assertResponderAuthority } from "@/lib/responder-command";

export const dynamic = "force-dynamic";
const RequestSchema = z.object({ commandId: z.uuid(), incidentId: z.string().min(1).max(256) }).strict();
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = RequestSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success || url.searchParams.getAll("commandId").length !== 1 || url.searchParams.getAll("incidentId").length !== 1) {
    return Response.json({ error: "Invalid decision recovery reference", code: "FA422" }, { status: 400, headers });
  }
  try {
    const user = await requireIncidentAccess(parsed.data.incidentId);
    assertResponderAuthority(request, user);
    const result = await lookupResponderCommandReceipt({ ...parsed.data, actorId: user.id, organizationId: user.organizationId ?? "" });
    return Response.json({ ...parsed.data, ...result, state: result.receipt ? "committed" : "unconfirmed" }, { headers });
  } catch (error) {
    const failure = responderCommandFailure(error, error instanceof AuthError ? error.status : undefined);
    return Response.json({ error: failure.message, code: failure.code }, { status: failure.status, headers });
  }
}
