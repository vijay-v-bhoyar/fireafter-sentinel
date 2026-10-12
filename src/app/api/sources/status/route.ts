import { compactSourceRawPayload, getDashboardBundle } from "@/lib/fireafter-data";
import { errorMessage } from "@/lib/error-message";
import { buildSourceCoverageMatrix } from "@/lib/source-coverage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const incidentId = searchParams.get("incidentId") ?? undefined;
  try {
    const bundle = await getDashboardBundle(incidentId);

    return Response.json({
      incidentId: bundle.incident.id,
      county: bundle.incident.county,
      dataFreshness: bundle.incident.dataFreshness,
      coverageMatrix: buildSourceCoverageMatrix({
        incident: bundle.incident,
        assets: bundle.assets,
        sourceSnapshots: bundle.sourceSnapshots,
        recommendations: bundle.recommendations,
        actions: bundle.actions,
        auditEvents: bundle.auditEvents,
      }),
      sources: bundle.sourceSnapshots.map((source) => ({
        sourceName: source.sourceName,
        sourceKey: source.sourceKey,
        sourceUrl: source.sourceUrl,
        status: source.status,
        stale: source.stale,
        coverageStatus: source.coverageStatus,
        fetchedAt: source.fetchedAt,
        sourceUpdatedAt: source.sourceUpdatedAt,
        sourceTimeBasis: source.sourceTimeBasis,
        validUntil: source.validUntil,
        freshness: source.freshness,
        freshnessLabel: source.freshnessLabel,
        detail: source.detail,
        warnings: source.warnings ?? [],
        rawPayload: compactSourceRawPayload(source.rawPayload),
        derivedSignals: source.derivedSignals ?? {},
      })),
    });
  } catch (error) {
    console.error(
      "[fireafter] source status unavailable",
      errorMessage(error, "Source status unavailable"),
    );
    return Response.json(
      { error: "Source status unavailable" },
      { status: 500 },
    );
  }
}
