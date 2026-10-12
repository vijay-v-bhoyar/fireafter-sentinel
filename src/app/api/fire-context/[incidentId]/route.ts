import { z } from "zod";
import { AuthError, requireIncidentAccess } from "@/lib/auth";
import {
  FireContextSelectionError,
  selectIncidentFireBundle,
  toClientDashboardBundle,
} from "@/lib/fireafter-data";
import {
  STANDARD_MUTATION_BODY_BYTES,
  readBoundedRequestBody,
  requestBodyFailure,
} from "@/lib/request-limits";
import { isCrossOriginMutation } from "@/lib/request-origin";
import { InventoryCapacityError } from "@/lib/inventory-error";
import { BundleWriteError } from "@/lib/bundle-write";
import { RefreshOperationError, withRefreshOperation } from "@/lib/refresh-operation";

export const dynamic = "force-dynamic";

const FireContextRequest = z.object({
  sourceKey: z.enum(["wfigs", "wfigs-ytd"]),
  sourceFeatureId: z.string().trim().min(1).max(256),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ incidentId: string }> },
) {
  if (isCrossOriginMutation(request)) {
    return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await (await readBoundedRequestBody(request, STANDARD_MUTATION_BODY_BYTES)).json();
  } catch (error) {
    const failure = requestBodyFailure(error, "Fire context request is too large");
    if (failure) return Response.json({ error: failure.message }, { status: failure.status });
    return Response.json({ error: "Invalid fire context request" }, { status: 400 });
  }

  const parsed = FireContextRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid fire context request" }, { status: 400 });
  }

  const { incidentId } = await context.params;
  try {
    const user = await requireIncidentAccess(incidentId);
    const bundle = await withRefreshOperation("fire_context", () => selectIncidentFireBundle({
      incidentId,
      ...parsed.data,
      actorId: user.id,
      actorName: user.email,
      principal: { kind: "user", actorId: user.id, organizationId: user.organizationId ?? "" },
    }), request.signal);
    return Response.json(toClientDashboardBundle(bundle));
  } catch (error) {
    const isAuthError = error instanceof AuthError;
    if (error instanceof RefreshOperationError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    if (error instanceof BundleWriteError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    if (error instanceof InventoryCapacityError) {
      console.warn("[fireafter] fire context inventory unavailable", { code: error.code });
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    const isSelectionError = error instanceof FireContextSelectionError;
    if (!isAuthError && !isSelectionError) {
      console.error("[fireafter] fire context selection failed", error);
    }
    return Response.json(
      {
        error:
          isAuthError || isSelectionError
            ? error.message
            : "Fire context selection failed. Review Operational Health and Data Source Coverage, then retry.",
      },
      {
        status: isAuthError
          ? error.status
          : isSelectionError
            ? error.status
            : 500,
      },
    );
  }
}
