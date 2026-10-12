import { z } from "zod";
import { AuthError, requireIncidentAccess } from "@/lib/auth";
import { lookupImportOperation } from "@/lib/import-operation-server";
import { bundleWriteFailure } from "@/lib/bundle-write";

export const dynamic = "force-dynamic";
const RequestSchema = z.object({ operationId: z.uuid(), incidentId: z.string().min(1).max(256) }).strict();
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = RequestSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success || url.searchParams.getAll("operationId").length !== 1 || url.searchParams.getAll("incidentId").length !== 1) {
    return Response.json({ error: "Invalid import operation reference" }, { status: 400, headers });
  }
  try {
    const user = await requireIncidentAccess(parsed.data.incidentId);
    const result = await lookupImportOperation({ ...parsed.data,
      principal: { kind: "user", actorId: user.id, organizationId: user.organizationId ?? "" } });
    return Response.json({ ...parsed.data, state: result.receipt ? "committed" : "unconfirmed", receipt: result.receipt }, { headers });
  } catch (error) {
    const failure = error instanceof AuthError ? error : bundleWriteFailure(error);
    return Response.json({ error: failure.message }, { status: failure.status, headers });
  }
}
