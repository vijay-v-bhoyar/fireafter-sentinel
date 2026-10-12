import { z } from "zod";
import {
  AuthError,
  signInWithPassword,
  verifySignedInOrganizationMembership,
} from "@/lib/auth";
import {
  STANDARD_MUTATION_BODY_BYTES,
  readBoundedRequestBody,
  requestBodyFailure,
} from "@/lib/request-limits";
import { isCrossOriginMutation } from "@/lib/request-origin";
import { safeInternalPath } from "@/lib/safe-navigation";

export const dynamic = "force-dynamic";

const LoginRequest = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
  returnTo: z.string().max(2048).optional(),
});

export async function POST(request: Request) {
  if (isCrossOriginMutation(request)) {
    return loginErrorResponse(request, "Cross-origin request rejected", 403);
  }
  const contentType = request.headers.get("content-type") ?? "";
  let credentials: Record<string, unknown>;
  try {
    const body = await readBoundedRequestBody(request, STANDARD_MUTATION_BODY_BYTES);
    credentials = contentType.includes("application/json")
      ? await body.json()
      : Object.fromEntries(await body.formData());
  } catch (error) {
    const failure = requestBodyFailure(error, "Login request is too large");
    if (failure) return loginErrorResponse(request, failure.message, failure.status);
    if (contentType.includes("application/json")) {
      return loginErrorResponse(request, "Invalid login request", 400);
    }
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("error", "Invalid login request");
    return Response.redirect(redirectUrl, 303);
  }

  const submitted =
    credentials && typeof credentials === "object" && !Array.isArray(credentials)
      ? credentials
      : {};
  const parsed = LoginRequest.safeParse({
    email: String(submitted.email ?? ""),
    password: String(submitted.password ?? ""),
    returnTo: submitted.returnTo === undefined ? undefined : String(submitted.returnTo),
  });
  if (!parsed.success) {
    return loginErrorResponse(
      request,
      "Invalid login request",
      400,
      safeInternalPath(submitted.returnTo),
    );
  }
  const returnTo = safeInternalPath(parsed.data.returnTo);

  try {
    const user = await signInWithPassword(parsed.data);
    await verifySignedInOrganizationMembership(user.id);
  } catch (error) {
    const isAuthError = error instanceof AuthError;
    const status = isAuthError ? error.status : 500;
    const message = isAuthError ? error.message : "Login failed";
    if (!isAuthError) {
      console.error("[fireafter] login failed", error);
    }
    if (contentType.includes("application/json")) {
      return Response.json({ error: message }, { status });
    }
    return loginErrorResponse(request, message, status, returnTo);
  }

  if (contentType.includes("application/json")) {
    return Response.json({ ok: true });
  }

  return Response.redirect(new URL(returnTo, request.url), 303);
}

function loginErrorResponse(
  request: Request,
  message: string,
  status: number,
  returnTo = "/",
) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return Response.json({ error: message }, { status });
  }
  const redirectUrl = new URL("/login", request.url);
  redirectUrl.searchParams.set("error", message);
  const safeReturnTo = safeInternalPath(returnTo);
  if (safeReturnTo !== "/") {
    redirectUrl.searchParams.set("returnTo", safeReturnTo);
  }
  return Response.redirect(redirectUrl, 303);
}
