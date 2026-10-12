import { ResponderCommandSchema, ResponderCommandError, responderCommandFailure, assertResponderAuthority } from "@/lib/responder-command";
import { AuthError, requireRecommendationAccess } from "@/lib/auth";
import { recordResponderAction } from "@/lib/fireafter-data";
import { InventoryCapacityError } from "@/lib/inventory-error";
import {
  STANDARD_MUTATION_BODY_BYTES,
  readBoundedRequestBody,
  requestBodyFailure,
} from "@/lib/request-limits";
import { isCrossOriginMutation } from "@/lib/request-origin";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  if (isCrossOriginMutation(request)) {
    return Response.json({ error: "Cross-origin request rejected" }, { status: 403, headers });
  }
  let body: unknown;
  try {
    body = await (await readBoundedRequestBody(request, STANDARD_MUTATION_BODY_BYTES)).json();
  } catch (error) {
    const failure = requestBodyFailure(error, "Responder action is too large");
    if (failure) return Response.json({ error: failure.message }, { status: failure.status, headers });
    return Response.json({ error: "Invalid responder action" }, { status: 400, headers });
  }

  const parsed = ResponderCommandSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid responder action" }, { status: 400, headers });
  }

  try {
    const user = await requireRecommendationAccess(parsed.data.recommendationId);
    assertResponderAuthority(request, user);
    return Response.json(
      await recordResponderAction({
        ...parsed.data,
        actorId: user.id,
        actorName: user.email,
        actorOrganizationId: user.organizationId ?? undefined,
      }), { headers },
    );
  } catch (error) {
    if (error instanceof ResponderCommandError) {
      console.warn("[fireafter] responder command rejected", { code: error.code });
      return Response.json({ error: error.message, code: error.code }, {
        status: error.status, headers: { "cache-control": "no-store" },
      });
    }
    if (error instanceof InventoryCapacityError) {
      console.warn("[fireafter] responder inventory rejected", { code: error.code });
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    }
    const isAuthError = error instanceof AuthError;
    if (!isAuthError) {
      console.error("[fireafter] responder action failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return Response.json(
      {
        error: isAuthError
          ? error.message
          : "Action failed. Review Operational Health and History & Audit, then retry.",
        ...(isAuthError ? { code: responderCommandFailure(undefined, error.status).code } : {}),
      },
      { status: isAuthError ? error.status : 500, headers: { "cache-control": "no-store" } },
    );
  }
}
