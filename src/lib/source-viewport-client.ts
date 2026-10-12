import { createResponseBudget, fetchBoundedResponse } from "./bounded-response";
import { responderAuthorityHeaders, type ResponderAuthority } from "./responder-command";
import { MapViewportError } from "./map-viewport-contract";
import { SOURCE_VIEW_BYTES, SourceViewportQuerySchema, validateSourceViewportResponse, type SourceViewportQuery } from "./source-viewport-contract";

export async function fetchSourceViewport(raw: SourceViewportQuery, authority: ResponderAuthority, signal: AbortSignal, fetchImpl = fetch) {
  const input = SourceViewportQuerySchema.parse(raw);
  const response = await fetchBoundedResponse(`/api/map/source-viewport?${new URLSearchParams(raw)}`, {
    cache: "no-store", credentials: "same-origin", signal, headers: responderAuthorityHeaders(authority),
  }, createResponseBudget(SOURCE_VIEW_BYTES, 15000), fetchImpl);
  if (!response.ok) throw new MapViewportError(response.status, response.status === 409
    ? "The saved source index is missing or changed. Reload the county; an operator may need to refresh its index."
    : response.status === 401 || response.status === 403 ? "Map access denied. Sign in again and verify your organization membership." : undefined);
  return validateSourceViewportResponse(await response.json(), input);
}
