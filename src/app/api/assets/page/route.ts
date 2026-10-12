import { AuthError, requireCurrentUser } from "@/lib/auth";
import { assertResponderAuthority, ResponderCommandError } from "@/lib/responder-command";
import { ASSET_PAGE_UNAVAILABLE, AssetInventoryError, AssetInventoryQuerySchema } from "@/lib/asset-inventory-contract";
import { getSupabaseAssetInventoryPage } from "@/lib/fireafter-supabase";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = AssetInventoryQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success || [...params.keys()].some(key => params.getAll(key).length !== 1)) {
    return Response.json({ error: "Invalid asset page query", code: "AP400" }, { status: 400, headers });
  }
  try {
    const user = await requireCurrentUser();
    assertResponderAuthority(request, user);
    const page = await getSupabaseAssetInventoryPage(parsed.data, user);
    const after = await requireCurrentUser();
    assertResponderAuthority(request, after);
    if (after.id !== user.id || after.organizationId !== user.organizationId) throw new AuthError("Identity changed", 403);
    return Response.json(page, { headers });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof AssetInventoryError || error instanceof ResponderCommandError ? error.status : 503;
    const message = error instanceof AssetInventoryError ? error.message : status === 401 ? "Sign in to browse stored assets."
      : status === 403 ? "Asset inventory access denied. Reload and verify your organization membership." : ASSET_PAGE_UNAVAILABLE;
    return Response.json({ error: message, code: `AP${status}` }, { status, headers });
  }
}
