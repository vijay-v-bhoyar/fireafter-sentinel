export const COUNTY_SEARCH_QUERY_MIN_CHARS = 2;
export const COUNTY_SEARCH_QUERY_MAX_CHARS = 80;
export const COUNTY_SEARCH_UNAVAILABLE_CODE = "county_search_unavailable";
export const COUNTY_SEARCH_UNAVAILABLE_MESSAGE =
  "County search is temporarily unavailable. Retry when TIGERweb is reachable.";

export type CountySearchQueryResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function validateCountySearchQuery(value: unknown): CountySearchQueryResult {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length < COUNTY_SEARCH_QUERY_MIN_CHARS ||
    normalized.length > COUNTY_SEARCH_QUERY_MAX_CHARS
  ) {
    return {
      ok: false,
      error: `County search query must be between ${COUNTY_SEARCH_QUERY_MIN_CHARS} and ${COUNTY_SEARCH_QUERY_MAX_CHARS} characters`,
    };
  }
  return { ok: true, value: normalized };
}
