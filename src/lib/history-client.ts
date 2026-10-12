import { createResponseBudget, fetchBoundedResponse } from "./bounded-response";
import { responderAuthorityHeaders, type ResponderAuthority } from "./responder-command";
import { HISTORY_PAGE_BYTES, HISTORY_RECORD_BYTES, HISTORY_UNAVAILABLE, HistoryError, HistoryPageSchema, HistoryRecordSchema, type HistoryRecordQuery, type HistoryQuery } from "./history-contract";

export async function fetchHistoryPage(input: HistoryQuery, authority: ResponderAuthority, signal: AbortSignal, fetchImpl = fetch) {
  const params = new URLSearchParams(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const response = await fetchBoundedResponse(`/api/history?${params}`, {
    cache: "no-store", signal, headers: responderAuthorityHeaders(authority),
  }, createResponseBudget(HISTORY_PAGE_BYTES, 15_000), fetchImpl);
  if (!response.ok) throw new HistoryError(response.status, response.status === 401 || response.status === 403
    ? "History access denied. Sign in again and verify your organization membership."
    : response.status === 400 ? "Invalid history reference. Clear the command filter and start from Latest records."
      : HISTORY_UNAVAILABLE);
  const page = HistoryPageSchema.parse(await response.json());
  if (page.incidentId !== input.incidentId || page.lane !== input.lane || page.commandId !== (input.commandId ?? null) || page.limit !== Number(input.limit) ||
    page.entries.length > page.limit || new Set(page.entries.map(entry => entry.id)).size !== page.entries.length ||
    (input.cursor && page.nextCursor === input.cursor)) throw new HistoryError(503);
  return page;
}

export async function fetchHistoryRecord(input: HistoryRecordQuery, authority: ResponderAuthority, signal: AbortSignal, fetchImpl = fetch) {
  const response = await fetchBoundedResponse(`/api/history?${new URLSearchParams(input)}`, {
    cache: "no-store", signal, headers: responderAuthorityHeaders(authority),
  }, createResponseBudget(HISTORY_RECORD_BYTES, 15_000), fetchImpl);
  if (!response.ok) throw new HistoryError(response.status, response.status === 401 || response.status === 403
    ? "History access denied. Sign in again and verify your organization membership."
    : "Recorded evidence could not be read within the safe reader limits. Retry or ask your operator for an authorized database export. Other history pages remain accessible.");
  const result = HistoryRecordSchema.parse(await response.json());
  if (result.incidentId !== input.incidentId || result.lane !== input.lane || result.record.id !== input.recordId) throw new HistoryError(503);
  return result;
}
