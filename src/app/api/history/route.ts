import { AuthError, requireCurrentUser } from "@/lib/auth";
import { assertResponderAuthority } from "@/lib/responder-command";
import { HistoryError, HistoryQuerySchema, HistoryRecordQuerySchema, HISTORY_UNAVAILABLE } from "@/lib/history-contract";
import { readHistoryPage, readHistoryRecord } from "@/lib/history-server";
import { canWriteOperationalRecords } from "@/lib/role-capabilities";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = HistoryQuerySchema.or(HistoryRecordQuerySchema).safeParse(Object.fromEntries(params));
  if (!parsed.success || [...params.keys()].some(key => params.getAll(key).length !== 1)) {
    return Response.json({ error: "Invalid history query", code: "H400" }, { status: 400, headers });
  }
  try {
    const user = await requireCurrentUser();
    assertResponderAuthority(request, user);
    if (!canWriteOperationalRecords(user)) throw new AuthError("History access denied", 403);
    const result = "recordId" in parsed.data ? await readHistoryRecord(parsed.data, user) : await readHistoryPage(parsed.data, user);
    const after = await requireCurrentUser();
    assertResponderAuthority(request, after);
    if (after.id !== user.id || after.organizationId !== user.organizationId || after.role !== user.role || !canWriteOperationalRecords(after)) {
      throw new AuthError("History authority changed", 403);
    }
    return Response.json(result, { headers });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof HistoryError ? error.status
      : error && typeof error === "object" && "code" in error && error.code === "FA401" ? 403 : 503;
    const message = error instanceof HistoryError ? error.message : status === 401 ? "Sign in to read complete history."
      : status === 403 ? "History access denied. Reload and verify your organization membership." : HISTORY_UNAVAILABLE;
    return Response.json({ error: message, code: `H${status}` }, { status, headers });
  }
}
