import { z } from "zod";
import {
  STANDARD_MUTATION_BODY_BYTES,
  readBoundedRequestBody,
  requestBodyFailure,
} from "@/lib/request-limits";
import { isCrossOriginMutation } from "@/lib/request-origin";
import { getSupabaseServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const PasswordUpdateRequest = z
  .object({
    password: z.string().min(12).max(1024),
    confirmation: z.string().max(1024),
  })
  .refine(({ password, confirmation }) => password === confirmation, {
    message: "Passwords do not match",
    path: ["confirmation"],
  });

export async function POST(request: Request) {
  if (isCrossOriginMutation(request)) {
    return updateErrorResponse(request, "Cross-origin request rejected", 403);
  }

  const contentType = request.headers.get("content-type") ?? "";
  let submitted: Record<string, unknown>;
  try {
    const body = await readBoundedRequestBody(request, STANDARD_MUTATION_BODY_BYTES);
    submitted = contentType.includes("application/json")
      ? await body.json()
      : Object.fromEntries(await body.formData());
  } catch (error) {
    const failure = requestBodyFailure(error, "Password update request is too large");
    return updateErrorResponse(
      request,
      failure?.message ?? "Invalid password update request",
      failure?.status ?? 400,
    );
  }

  const parsed = PasswordUpdateRequest.safeParse({
    password: String(submitted?.password ?? ""),
    confirmation: String(submitted?.confirmation ?? ""),
  });
  if (!parsed.success) {
    return updateErrorResponse(request, "Password must be at least 12 characters and match confirmation", 400);
  }

  try {
    const supabase = await getSupabaseServerClient({ requireCookieWrites: true });
    if (!supabase) {
      return updateErrorResponse(request, "Password recovery is temporarily unavailable", 503);
    }

    const { data: current, error: currentUserError } = await supabase.auth.getUser();
    if (currentUserError || !current.user) {
      return updateErrorResponse(
        request,
        "Recovery session is missing or expired. Request a new link.",
        401,
      );
    }

    const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
    if (error) {
      console.error("[fireafter] password update failed", { code: error.name });
      return updateErrorResponse(request, "Unable to update password. Request a new link.", 400);
    }
  } catch (error) {
    console.error("[fireafter] password update failed", {
      code: error instanceof Error ? error.name : "unknown",
    });
    return updateErrorResponse(request, "Password recovery is temporarily unavailable", 503);
  }

  if (contentType.includes("application/json")) {
    return Response.json({ ok: true });
  }

  const redirectUrl = new URL("/login", request.url);
  redirectUrl.searchParams.set("notice", "Password updated. Sign in with your new password.");
  return Response.redirect(redirectUrl, 303);
}

function updateErrorResponse(request: Request, message: string, status: number) {
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    return Response.json({ error: message }, { status });
  }

  const redirectUrl = new URL("/reset-password", request.url);
  redirectUrl.searchParams.set("error", message);
  return Response.redirect(redirectUrl, 303);
}
