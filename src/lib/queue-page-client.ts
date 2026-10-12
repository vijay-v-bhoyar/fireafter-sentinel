import { createResponseBudget, fetchBoundedResponse } from "./bounded-response";
import { responderAuthorityHeaders, type ResponderAuthority } from "./responder-command";
import { QueuePageError, QueuePageQuerySchema, QUEUE_PAGE_BYTES, validateQueuePage, type QueuePageQuery } from "./queue-page-contract";

export async function fetchQueuePage(raw: QueuePageQuery, authority: ResponderAuthority, signal: AbortSignal, fetchImpl = fetch) {
  const input = QueuePageQuerySchema.parse(raw);
  const params = new URLSearchParams(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const response = await fetchBoundedResponse(`/api/queue/page?${params}`, { cache: "no-store", signal, headers: responderAuthorityHeaders(authority) },
    createResponseBudget(QUEUE_PAGE_BYTES, 20_000), fetchImpl);
  if (!response.ok) throw new QueuePageError(response.status, response.status === 401 || response.status === 403
    ? "Queue access denied. Sign in again and verify your organization membership."
    : response.status === 409 ? "The inventory or evidence state changed. Start from the first page to review the current order." : undefined);
  return validateQueuePage(await response.json(), input);
}
