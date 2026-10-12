import { AuthError, requireIncidentAccess } from "@/lib/auth";
import { refreshIncidentBundle, toClientDashboardBundle } from "@/lib/fireafter-data";
import { isCrossOriginMutation } from "@/lib/request-origin";
import { InventoryCapacityError } from "@/lib/inventory-error";
import { BundleWriteError } from "@/lib/bundle-write";
import { RefreshOperationError, withRefreshOperation } from "@/lib/refresh-operation";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ incidentId: string }> },
) {
  if (isCrossOriginMutation(request)) {
    return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  const { incidentId } = await context.params;
  try {
    const user = await requireIncidentAccess(incidentId);
    if (process.env.FIREAFTER_DURABLE_REFRESH_ENABLED === "true") {
      const { enqueueIngestion } = await import("@/lib/ingestion-dispatch");
      return await enqueueIngestion(user, "refresh", incidentId, request.headers.get("x-ingestion-operation-id"));
    }
    return Response.json(
      toClientDashboardBundle(await withRefreshOperation("refresh", () => refreshIncidentBundle(incidentId, { kind: "user", actorId: user.id, organizationId: user.organizationId ?? "" }), request.signal)),
    );
  } catch (error) {
    if (error instanceof RefreshOperationError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    if (error instanceof BundleWriteError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    if (error instanceof InventoryCapacityError) {
      console.warn("[fireafter] refresh inventory unavailable", { code: error.code });
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    const isAuthError = error instanceof AuthError;
    if (!isAuthError) {
      console.error("[fireafter] incident refresh failed", error);
    }
    return Response.json(
      {
        error: isAuthError
          ? error.message
          : "Refresh failed. Review Operational Health and Data Source Coverage, then retry.",
      },
      { status: isAuthError ? error.status : 500 },
    );
  }
}
