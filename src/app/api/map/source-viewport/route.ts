import { AuthError, createCurrentUserReader } from "@/lib/auth";
import { assertResponderAuthority, ResponderCommandError } from "@/lib/responder-command";
import { MAP_VIEW_UNAVAILABLE, MapViewportError } from "@/lib/map-viewport-contract";
import { SourceViewportQuerySchema } from "@/lib/source-viewport-contract";
import { getSourceViewport } from "@/lib/source-viewport-server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, x-fireafter-actor, x-fireafter-organization" };
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams, raw = Object.fromEntries(params);
  if (!SourceViewportQuerySchema.safeParse(raw).success || [...params.keys()].some(key => params.getAll(key).length !== 1)) {
    return Response.json({ error: "Invalid source view.", code: "MV400" }, { status: 400, headers });
  }
  if (process.env.FIREAFTER_VIEWPORT_MAP_ENABLED !== "true") return Response.json({ error: MAP_VIEW_UNAVAILABLE, code: "MV503" }, { status: 503, headers });
  try {
    const readUser = await createCurrentUserReader(), user = await readUser();
    if (!user) throw new AuthError("Authentication required", 401);
    assertResponderAuthority(request, user);
    const result = await getSourceViewport(raw as Parameters<typeof getSourceViewport>[0], user, request.signal);
    const after = await readUser();
    if (!after || after.id !== user.id || after.organizationId !== user.organizationId || after.role !== user.role) throw new AuthError("Authority changed", 403);
    if (request.signal.aborted) throw new MapViewportError();
    return Response.json(result, { headers });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof ResponderCommandError || error instanceof MapViewportError ? error.status : 503;
    return Response.json({ error: status === 409 ? "Source revision or index unavailable. Reload the county." : status === 401 || status === 403 ? "Map access denied." : MAP_VIEW_UNAVAILABLE,
      code: `MV${status}` }, { status, headers });
  }
}
