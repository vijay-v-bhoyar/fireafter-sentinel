import { getSupabaseServerClient } from "@/lib/supabase";
import { safeInternalPath } from "@/lib/safe-navigation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = safeInternalPath(requestUrl.searchParams.get("next"));

  if (!code) {
    return loginErrorRedirect(requestUrl, "Invalid sign-in callback");
  }

  try {
    const supabase = await getSupabaseServerClient();
    if (!supabase) {
      return loginErrorRedirect(
        requestUrl,
        "Responder authentication is unavailable",
      );
    }

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return loginErrorRedirect(requestUrl, "Unable to complete sign in");
    }
  } catch {
    return loginErrorRedirect(requestUrl, "Unable to complete sign in");
  }

  return Response.redirect(new URL(next, requestUrl.origin), 303);
}

function loginErrorRedirect(requestUrl: URL, message: string) {
  const redirectUrl = new URL("/login", requestUrl.origin);
  redirectUrl.searchParams.set("error", message);
  return Response.redirect(redirectUrl, 303);
}
