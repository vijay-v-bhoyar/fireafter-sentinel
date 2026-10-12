import { getDashboardBundle } from "@/lib/fireafter-data";
import { streamJsonResponse } from "@/lib/stream-json-response";
import { mapStreamResponse } from "@/lib/map-stream-response";
import { MAP_CAPACITY_CODE, MAP_CAPACITY_MESSAGE, MAP_STREAM_TYPE, MapCapacityError } from "@/lib/map-stream-contract";
import { errorMessage } from "@/lib/error-message";
import {
  redactAssetForPublic,
  redactRecommendationForPublic,
} from "@/lib/sensitive-infrastructure";
import { pwfdfBasinsFromSnapshot } from "@/lib/pwfdf";
import { readSourceLineGeometry, SOURCE_LINE_GEOMETRY_VERSION } from "@/lib/source-line-geometry";
import type { Asset, Geometry } from "@/lib/types";
import { PWFDF_ANALYSIS_GEOMETRY_FAILURE, PWFDF_ANALYSIS_GEOMETRY_MESSAGE, type BasinGeometry } from "@/lib/pwfdf-geometry";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Accept" };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const incidentId = searchParams.get("incidentId") ?? undefined;
  try {
    const bundle = await getDashboardBundle(incidentId);
    if (bundle.dataAvailability === "unavailable") {
      return Response.json({
        code: "COUNTY_DATA_UNAVAILABLE",
        error: "Saved county evidence is unavailable. Reload the county and review Operational Health before loading the map.",
      }, { status: 503, headers });
    }
    const canViewSensitive = bundle.sensitiveInfrastructureAccess === true;
    const visibleAssets = canViewSensitive
      ? bundle.assets
      : bundle.assets.map((asset) => redactAssetForPublic(asset, bundle.incident));
    const visibleRecommendations = canViewSensitive
      ? bundle.recommendations
      : bundle.recommendations.map((recommendation) =>
          redactRecommendationForPublic(recommendation, bundle.incident),
        );

    const pwfdf = bundle.sourceSnapshots.find(snapshot => snapshot.sourceKey === "usgs-pwfdf");
    const basins = pwfdfBasinsFromSnapshot(pwfdf);
    const basinWarning = pwfdf?.rawPayload?.failureCode === PWFDF_ANALYSIS_GEOMETRY_FAILURE
      ? PWFDF_ANALYSIS_GEOMETRY_MESSAGE
      : pwfdf?.coverageStatus === "available" && basins.length === 0
      ? "PWFDF basin geometry could not be validated as a complete collection. Ask an authorized GIS reviewer to inspect the source and refresh; no partial geometry is shown."
      : undefined;
    const output = {
      incidentId: bundle.incident.id,
      county: featureCollection(
        bundle.incident.locationContext?.boundary
          ? [
              feature(bundle.incident.locationContext.boundary, {
                name: bundle.incident.county,
                sourceKey: "tigerweb-counties",
              }),
            ]
          : [],
      ),
      roads: sourceLineCollection(bundle.sourceSnapshots, "tiger-roads"),
      hydrography: sourceLineCollection(bundle.sourceSnapshots, "3dhp-flowlines"),
      pwfdfBasins: { ...featureCollection(
        basins.map((basin) =>
          feature(basin.geometry, {
            id: basin.id,
            sourceKey: "usgs-pwfdf",
            fireId: basin.fireId,
            assessmentDate: basin.assessmentDate,
            combinedHazard: basin.combinedHazard,
            probabilityClass: basin.probabilityClass,
            volumeClass: basin.volumeClass,
          }),
        ),
      ), warning: basinWarning },
      assets: featureCollection(
        visibleAssets.flatMap((asset) => assetFeature(asset, canViewSensitive)),
      ),
      recommendations: featureCollection(
        visibleRecommendations.map((recommendation) =>
          feature(
            { type: "Point", coordinates: recommendation.coordinates },
            {
              id: recommendation.id,
              assetId: recommendation.assetId,
              name: recommendation.assetName,
              type: recommendation.assetType,
              riskLevel: recommendation.riskLevel,
              score100: recommendation.score100,
              redacted:
                recommendation.assetType === "Critical Facility" &&
                !canViewSensitive,
            },
          ),
        ),
      ),
    };
    const response = request.headers.get("accept") === MAP_STREAM_TYPE
      ? mapStreamResponse(output, request.signal) : streamJsonResponse(output, request.signal);
    response.headers.set("Vary", "Cookie, Accept");
    return response;
  } catch (error) {
    if (error instanceof MapCapacityError) {
      return Response.json({ code: MAP_CAPACITY_CODE, error: MAP_CAPACITY_MESSAGE }, {
        status: 503, headers: { ...headers, "X-FireAfter-Map-Error": MAP_CAPACITY_CODE },
      });
    }
    console.error(
      "[fireafter] map features unavailable",
      errorMessage(error, "Map features unavailable"),
    );
    return Response.json(
      { error: "Map features unavailable" },
      { status: 500, headers },
    );
  }
}

function assetFeature(asset: Asset, canViewSensitive: boolean) {
  const geometry = asset.geometry ?? {
    type: "Point" as const,
    coordinates: asset.coordinates,
  };
  const redacted = asset.type === "Critical Facility" && !canViewSensitive;
  return [
    feature(geometry, {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      source: asset.source,
      confidence: asset.confidence,
      coverageStatus: asset.coverageStatus,
      sourceFeatureIds: redacted ? undefined : asset.sourceFeatureIds,
      redacted,
    }),
  ];
}

function sourceLineCollection(
  snapshots: Awaited<ReturnType<typeof getDashboardBundle>>["sourceSnapshots"],
  sourceKey: string,
) {
  const source = snapshots.find((snapshot) => snapshot.sourceKey === sourceKey);
  const geometry = readSourceLineGeometry(source?.rawPayload, sourceKey);
  return {
    ...featureCollection(geometry.features.flatMap((record) =>
      record.paths.map((coordinates, partIndex) => feature(
        { type: "LineString", coordinates },
        { id: record.id, sourceFeatureId: record.id, sourceUrl: record.sourceUrl,
          partIndex, name: record.name, class: record.class, sourceKey },
      )),
    )),
    geometryVersion: geometry.warning ? null : SOURCE_LINE_GEOMETRY_VERSION,
    sourceFeatureCount: geometry.features.length,
    warning: geometry.warning,
  };
}

function feature(geometry: Geometry | BasinGeometry, properties: Record<string, unknown>) {
  return {
    type: "Feature",
    geometry,
    properties,
  };
}

function featureCollection(features: Array<ReturnType<typeof feature>>) {
  return {
    type: "FeatureCollection",
    features,
  };
}
