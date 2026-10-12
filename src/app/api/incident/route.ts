import { z } from "zod";
import { AuthError, requireCurrentUser } from "@/lib/auth";
import { errorMessage } from "@/lib/error-message";
import { createIncidentBundle, toClientDashboardBundle } from "@/lib/fireafter-data";
import {
  CountySearchUnavailableError,
} from "@/lib/live-sources";
import {
  COUNTY_SEARCH_UNAVAILABLE_CODE,
  COUNTY_SEARCH_UNAVAILABLE_MESSAGE,
} from "@/lib/search-query";
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

const IncidentRequest = z.object({
  locationId: z.string().min(1).max(256),
});

export async function POST(request: Request) {
  if (isCrossOriginMutation(request)) {
    return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await (await readBoundedRequestBody(request, STANDARD_MUTATION_BODY_BYTES)).json();
  } catch (error) {
    const failure = requestBodyFailure(error, "Incident request is too large");
    if (failure) return Response.json({ error: failure.message }, { status: failure.status });
    return Response.json({ error: "Invalid incident request" }, { status: 400 });
  }

  const parsed = IncidentRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid incident request" }, { status: 400 });
  }

  try {
    const user = await requireCurrentUser();
    if (process.env.FIREAFTER_DURABLE_REFRESH_ENABLED === "true") {
      const { enqueueIngestion } = await import("@/lib/ingestion-dispatch");
      return await enqueueIngestion(user, "create", parsed.data.locationId, request.headers.get("x-ingestion-operation-id"));
    }
    return Response.json(
      toClientDashboardBundle(await withRefreshOperation("create", () => createIncidentBundle(parsed.data.locationId, { kind: "user", actorId: user.id, organizationId: user.organizationId ?? "" }), request.signal)),
    );
  } catch (error) {
    if (error instanceof RefreshOperationError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    if (error instanceof BundleWriteError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    const isAuthError = error instanceof AuthError;
    if (error instanceof InventoryCapacityError) {
      console.warn("[fireafter] incident inventory unavailable", { code: error.code });
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    const isCountySearchUnavailable = error instanceof CountySearchUnavailableError;
    if (!isAuthError && !isCountySearchUnavailable) {
      console.error(
        "[fireafter] incident creation failed",
        errorMessage(error, "Incident creation failed"),
      );
    }
    if (isCountySearchUnavailable) {
      return Response.json(
        {
          error: COUNTY_SEARCH_UNAVAILABLE_MESSAGE,
          code: COUNTY_SEARCH_UNAVAILABLE_CODE,
          retryable: true,
        },
        { status: 502 },
      );
    }
    return Response.json(
      { error: isAuthError ? error.message : "Incident creation failed" },
      { status: isAuthError ? error.status : 500 },
    );
  }
}
