import { errorMessage } from "@/lib/error-message";
import { getDashboardBundle } from "@/lib/fireafter-data";
import {
  dashboardBundleToGeoJson,
  geoJsonFileName,
} from "../../../../lib/geojson-export";
import { redactSensitiveBundleForPublic } from "@/lib/sensitive-infrastructure";
import { AuthError, createCurrentUserReader } from "@/lib/auth";
import { canWriteOperationalRecords } from "@/lib/role-capabilities";
import { getSupabaseGeoJsonExportSource } from "@/lib/fireafter-supabase";
import { createCompleteGeoJsonResponse } from "@/lib/geojson-export-stream";
import { QueuePageError } from "@/lib/queue-page-contract";
import { QueueSourceReadError } from "@/lib/queue-source-read-model";
import { InventoryCapacityError } from "@/lib/inventory-error";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const incidentId = searchParams.get("incidentId") ?? undefined;

  try {
    if (process.env.FIREAFTER_STREAMING_EXPORT_ENABLED === "true") {
      const readUser = await createCurrentUserReader(), user = await readUser();
      if (user && canWriteOperationalRecords(user)) {
        const revalidate = async () => {
          const after = await readUser();
          if (!after || after.id !== user.id || after.organizationId !== user.organizationId || after.role !== user.role) throw new AuthError("Export authority changed", 403);
        };
        try {
          const source = await getSupabaseGeoJsonExportSource(incidentId ?? process.env.FIREAFTER_DEFAULT_INCIDENT_ID ?? "incident-utah-county-ut", user, revalidate, request.signal);
          return await createCompleteGeoJsonResponse(source, request.signal);
        } catch (error) {
          if (!(error instanceof QueuePageError && error.code === "QP_LEGACY")) {
            const status = error instanceof AuthError || error instanceof QueueSourceReadError ? error.status
              : error instanceof InventoryCapacityError && error.code === "read_generation" ? 409 : 503;
            return Response.json({ code: "COUNTY_DATA_UNAVAILABLE", error: "The complete export could not be verified. Reload the county and review access, source status and export capacity. No complete file was generated." }, { status, headers });
          }
        }
      }
    }
    const bundle = await getDashboardBundle(incidentId);
    if (bundle.dataAvailability === "unavailable") {
      return Response.json({
        code: "COUNTY_DATA_UNAVAILABLE",
        error: "Saved county evidence is unavailable. Reload the county and review Operational Health before exporting. No GeoJSON file was generated.",
      }, { status: 503, headers });
    }
    const exportBundle = bundle.sensitiveInfrastructureAccess
      ? bundle
      : redactSensitiveBundleForPublic(bundle);
    const geojson = dashboardBundleToGeoJson(exportBundle);

    return new Response(JSON.stringify(geojson), {
      headers: {
        ...headers,
        "content-type": "application/geo+json; charset=utf-8",
        "content-disposition": `attachment; filename="${geoJsonFileName(exportBundle.incident)}"`,
      },
    });
  } catch (error) {
    console.error(
      "[fireafter] GeoJSON export unavailable",
      errorMessage(error, "GeoJSON export unavailable"),
    );
    return Response.json(
      {
        error: "GeoJSON export unavailable",
      },
      { status: 500, headers },
    );
  }
}
