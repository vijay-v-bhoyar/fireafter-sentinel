import { getDashboardBundle } from "@/lib/fireafter-data";
import { errorMessage } from "@/lib/error-message";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const incidentId = searchParams.get("incidentId") ?? undefined;
  try {
    const bundle = await getDashboardBundle(incidentId);
    return Response.json({ recommendations: bundle.recommendations });
  } catch (error) {
    console.error(
      "[fireafter] recommendations unavailable",
      errorMessage(error, "Recommendations unavailable"),
    );
    return Response.json(
      {
        error: "Recommendations unavailable",
        recommendations: [],
      },
      { status: 500 },
    );
  }
}
