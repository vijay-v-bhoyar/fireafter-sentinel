import { searchLocationsLive } from "@/lib/live-sources";
import {
  COUNTY_SEARCH_UNAVAILABLE_CODE,
  COUNTY_SEARCH_UNAVAILABLE_MESSAGE,
  validateCountySearchQuery,
} from "@/lib/search-query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = validateCountySearchQuery(searchParams.get("query"));
  if (!query.ok) {
    return Response.json(
      { error: query.error, results: [] },
      { status: 400 },
    );
  }

  try {
    return Response.json({ results: await searchLocationsLive(query.value) });
  } catch {
    return Response.json(
      {
        error: COUNTY_SEARCH_UNAVAILABLE_MESSAGE,
        code: COUNTY_SEARCH_UNAVAILABLE_CODE,
        retryable: true,
        results: [],
      },
      { status: 502 },
    );
  }
}
