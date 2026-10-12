import { createResponseBudget, fetchBoundedResponse } from "./bounded-response";
import { responderAuthorityHeaders, type ResponderAuthority } from "./responder-command";
import { ASSET_PAGE_BYTES, ASSET_PAGE_UNAVAILABLE, AssetInventoryError, AssetInventoryPageSchema, AssetInventoryQuerySchema, type AssetInventoryQuery } from "./asset-inventory-contract";

export async function fetchAssetInventoryPage(raw: AssetInventoryQuery, authority: ResponderAuthority, signal: AbortSignal, fetchImpl = fetch) {
  const input = AssetInventoryQuerySchema.parse(raw);
  const params = new URLSearchParams(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const response = await fetchBoundedResponse(`/api/assets/page?${params}`, { cache: "no-store", signal, headers: responderAuthorityHeaders(authority) },
    createResponseBudget(ASSET_PAGE_BYTES, 20_000), fetchImpl);
  if (!response.ok) throw new AssetInventoryError(response.status, response.status === 401 || response.status === 403
    ? "Asset access denied. Sign in again and verify your organization membership."
    : response.status === 409 ? "The saved inventory changed or its membership is unverified. Start from the first page; ask an operator to refresh if this repeats."
      : ASSET_PAGE_UNAVAILABLE);
  const page = AssetInventoryPageSchema.parse(await response.json());
  const expectedCount = Math.min(page.limit, Math.max(0, page.totalStoredAssets - page.start));
  const expectedNext = page.start + expectedCount < page.totalStoredAssets ? page.start + expectedCount : null;
  if (page.incidentId !== input.incidentId || page.start !== Number(input.start) || page.limit !== Number(input.limit) ||
      (page.start !== 0 && page.start >= page.totalStoredAssets) ||
      (input.revision && page.revision !== input.revision) || page.items.length !== expectedCount || page.nextStart !== expectedNext ||
      page.items.some((item, index) => item.position !== page.start + index + 1)) throw new AssetInventoryError(503);
  return page;
}
