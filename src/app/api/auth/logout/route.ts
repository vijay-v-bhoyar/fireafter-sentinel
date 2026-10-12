import { signOutCurrentUser } from "@/lib/auth";
import { isCrossOriginMutation } from "@/lib/request-origin";
import { SIGN_OUT_UNCONFIRMED_CODE, SIGN_OUT_UNCONFIRMED_MESSAGE } from "@/lib/logout-contract";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (isCrossOriginMutation(request)) {
    return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  try {
    await signOutCurrentUser();
  } catch {
    console.warn("[fireafter] sign-out unconfirmed", { code: SIGN_OUT_UNCONFIRMED_CODE });
    return Response.json({ error: SIGN_OUT_UNCONFIRMED_MESSAGE, code: SIGN_OUT_UNCONFIRMED_CODE }, {
      status: 503, headers: { "cache-control": "no-store" },
    });
  }
  const acceptsJson = request.headers
    .get("accept")
    ?.includes("application/json");

  if (acceptsJson) {
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  }

  return new Response(null, {
    status: 303,
    headers: { location: new URL("/login", request.url).toString(), "cache-control": "no-store" },
  });
}
