import { z } from "zod";
import {
  STANDARD_MUTATION_BODY_BYTES,
  readBoundedRequestBody,
  requestBodyFailure,
} from "@/lib/request-limits";
import { isCrossOriginMutation } from "@/lib/request-origin";
import { getPasswordRecoveryRedirectUrl } from "@/lib/public-app-url";
import { getSupabaseServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const RecoveryRequest = z.object({
  email: z.string().trim().email().max(320),
});

const recoveryAcceptedMessage =
  "If an issued account matches this email, a recovery link has been sent.";

export async function POST(request: Request) {
  if (isCrossOriginMutation(request)) {
    return recoveryErrorResponse(request, "Cross-origin request rejected", 403);
  }

  const contentType = request.headers.get("content-type") ?? "";
  let submitted: Record<string, unknown>;
  try {
    const body = await readBoundedRequestBody(request, STANDARD_MUTATION_BODY_BYTES);
    submitted = contentType.includes("application/json")
      ? await body.json()
      : Object.fromEntries(await body.formData());
  } catch (error) {
    const failure = requestBodyFailure(error, "Recovery request is too large");
    return recoveryErrorResponse(
      request,
      failure?.message ?? "Invalid recovery request",
      failure?.status ?? 400,
    );
  }

  const parsed = RecoveryRequest.safeParse({
    email: String(submitted?.email ?? ""),
  });
  if (!parsed.success) {
    return recoveryErrorResponse(request, "Invalid recovery request", 400);
  }

  const redirectTo = getPasswordRecoveryRedirectUrl();
  if (!redirectTo) {
    console.error("[fireafter] password recovery is unavailable", {
      reason: "invalid_public_app_url",
    });
    return recoveryErrorResponse(
      request,
      "Password recovery is temporarily unavailable",
      503,
    );
  }

  try {
    const supabase = await getSupabaseServerClient();
    if (!supabase) {
      return recoveryErrorResponse(
        request,
        "Password recovery is temporarily unavailable",
        503,
      );
    }

    const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
      redirectTo,
    });
    if (error) {
      console.error("[fireafter] password recovery request failed", {
        code: error.name,
      });
      return recoveryErrorResponse(
        request,
        "Password recovery is temporarily unavailable",
        503,
      );
    }
  } catch (error) {
    console.error("[fireafter] password recovery request failed", {
      code: error instanceof Error ? error.name : "unknown",
    });
    return recoveryErrorResponse(
      request,
      "Password recovery is temporarily unavailable",
      503,
    );
  }

  if (contentType.includes("application/json")) {
    return Response.json({ ok: true, message: recoveryAcceptedMessage }, { status: 202 });
  }

  const redirectUrl = new URL("/recover", request.url);
  redirectUrl.searchParams.set("submitted", "1");
  return Response.redirect(redirectUrl, 303);
}

function recoveryErrorResponse(request: Request, message: string, status: number) {
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    return Response.json({ error: message }, { status });
  }

  const redirectUrl = new URL("/recover", request.url);
  redirectUrl.searchParams.set("error", message);
  return Response.redirect(redirectUrl, 303);
}
