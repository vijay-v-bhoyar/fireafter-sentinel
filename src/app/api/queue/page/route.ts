import { AuthError, requireCurrentUser } from "@/lib/auth";
import { assertResponderAuthority, ResponderCommandError } from "@/lib/responder-command";
import { QueuePageError, QueuePageQuerySchema, QUEUE_PAGE_UNAVAILABLE } from "@/lib/queue-page-contract";
import { getSupabaseQueuePage } from "@/lib/fireafter-supabase";
import { QueueSourceReadError } from "@/lib/queue-source-read-model";
import { InventoryCapacityError } from "@/lib/inventory-error";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams, parsed = QueuePageQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success || [...params.keys()].some(key => params.getAll(key).length !== 1)) return Response.json({ error: "Invalid queue page query", code: "QP400" }, { status: 400, headers });
  try {
    const user = await requireCurrentUser(); assertResponderAuthority(request, user);
    const { page } = await getSupabaseQueuePage(parsed.data, user);
    const after = await requireCurrentUser(); assertResponderAuthority(request, after);
    if (after.id !== user.id || after.organizationId !== user.organizationId || after.role !== user.role) throw new AuthError("Identity changed", 403);
    return Response.json(page, { headers });
  } catch (error) {
    const status = error instanceof InventoryCapacityError && error.code === "read_generation" ? 409
      : error instanceof AuthError || error instanceof ResponderCommandError || error instanceof QueuePageError || error instanceof QueueSourceReadError ? error.status : 503;
    const message = status === 401 || status === 403 ? "Queue access denied. Sign in again and verify your organization membership."
      : status === 409 ? "The inventory or evidence state changed or does not support paging. Reload; ask an operator to refresh if this repeats." : QUEUE_PAGE_UNAVAILABLE;
    return Response.json({ error: message, code: `QP${status}` }, { status, headers });
  }
}
