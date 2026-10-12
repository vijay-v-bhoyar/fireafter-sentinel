import { createResponseBudget, fetchBoundedResponse } from "./bounded-response";
import { responderAuthorityHeaders, type ResponderAuthority } from "./responder-command";
import { MAP_VIEW_BYTES, MapViewportError, MapViewportQuerySchema, validateMapViewportResponse, type MapViewportQuery } from "./map-viewport-contract";

export async function fetchMapViewport(raw: MapViewportQuery, authority: ResponderAuthority, signal: AbortSignal, fetchImpl = fetch) {
  const input = MapViewportQuerySchema.parse(raw);
  const params = new URLSearchParams(raw);
  const response = await fetchBoundedResponse(`/api/map/viewport?${params}`, {
    cache: "no-store", credentials: "same-origin", signal, headers: responderAuthorityHeaders(authority),
  }, createResponseBudget(MAP_VIEW_BYTES, 15000), fetchImpl);
  if (!response.ok) throw new MapViewportError(response.status, response.status === 409
    ? "The saved map index is missing or its revision changed. Reload the county; an operator may need to refresh its index."
    : response.status === 401 || response.status === 403 ? "Map access denied. Sign in again and verify your organization membership." : undefined);
  return validateMapViewportResponse(await response.json(), input);
}
