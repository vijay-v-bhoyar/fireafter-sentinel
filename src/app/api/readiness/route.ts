import { createEmptyDashboardBundle, getDashboardBundle } from "@/lib/fireafter-data";
import { checkSupabaseRealitySchema } from "@/lib/fireafter-supabase";
import { buildOperationalHealth } from "@/lib/readiness";
import {
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
  OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
  SCHEDULED_REFRESH_SECURITY_VERSION,
  SERVER_OWNED_WRITE_SECURITY_VERSION,
  SERVER_OWNED_READ_SECURITY_VERSION,
} from "@/lib/operational-write-security";
import { hasSupabaseAdminEnv, hasSupabaseEnv } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const incidentId = searchParams.get("incidentId") ?? undefined;
  const [bundleResult, schemaResult] = await Promise.allSettled([
    getDashboardBundle(incidentId),
    checkSupabaseRealitySchema(),
  ]);
  const bundle = bundleResult.status === "fulfilled"
    ? bundleResult.value
    : createEmptyDashboardBundle(incidentId);
  const schema = schemaResult.status === "fulfilled"
    ? schemaResult.value
    : {
        ready: false,
        serverOwnedReadsVersion: null,
        serverOwnedReadsProbeError: "Server-owned operational-read security probe is unavailable.",
        serverOwnedWritesVersion: null,
        serverOwnedWritesProbeError:
          "Server-owned operational-write security probe is unavailable.",
        atomicResponderActionVersion: null,
        atomicResponderActionProbeError:
          "Atomic responder-action persistence security probe is unavailable.",
        atomicBundlePersistenceVersion: null,
        atomicBundlePersistenceProbeError:
          "Atomic bundle persistence security probe is unavailable.",
        operatorAccountIssuanceAuditVersion: null,
        operatorAccountIssuanceAuditProbeError:
          "Operator account issuance audit security probe is unavailable.",
        scheduledRefreshVersion: null,
        scheduledRefreshProbeError:
          "Durable scheduled-refresh lease security probe is unavailable.",
        errors: ["Supabase schema probe did not complete."],
      };

  if (bundleResult.status === "rejected") {
    console.warn("[fireafter] readiness dashboard persistence probe failed", {
      incidentId: incidentId ?? null,
      errorName: bundleResult.reason instanceof Error
        ? bundleResult.reason.name
        : "UnknownError",
    });
  }
  if (schemaResult.status === "rejected") {
    console.warn("[fireafter] readiness schema probe failed", {
      incidentId: incidentId ?? null,
      errorName: schemaResult.reason instanceof Error
        ? schemaResult.reason.name
        : "UnknownError",
    });
  }

  return Response.json(
    buildOperationalHealth(bundle, {
      supabaseConfigured: hasSupabaseEnv() && hasSupabaseAdminEnv(),
      supabaseSchemaReady: schema.ready,
      serverOwnedReadsVerified: schema.serverOwnedReadsVersion === SERVER_OWNED_READ_SECURITY_VERSION,
      serverOwnedWritesVerified:
        schema.serverOwnedWritesVersion === SERVER_OWNED_WRITE_SECURITY_VERSION,
      atomicResponderActionWriteVerified:
        schema.atomicResponderActionVersion ===
        ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
      atomicBundlePersistenceWriteVerified:
        schema.atomicBundlePersistenceVersion ===
        ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
      operatorAccountIssuanceAuditVerified:
        schema.operatorAccountIssuanceAuditVersion ===
        OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
      scheduledRefreshVerified:
        schema.scheduledRefreshVersion === SCHEDULED_REFRESH_SECURITY_VERSION,
      dashboardPersistenceAvailable: bundleResult.status === "fulfilled",
      nasaFirmsConfigured: Boolean(process.env.NASA_FIRMS_MAP_KEY),
      nwsUserAgentConfigured: Boolean(process.env.FIREAFTER_NWS_USER_AGENT),
      cronSecretConfigured: Boolean(process.env.CRON_SECRET),
      errors: [
        ...schema.errors,
        ...(schema.serverOwnedReadsProbeError ? [schema.serverOwnedReadsProbeError] : []),
        ...(schema.serverOwnedWritesProbeError
          ? [schema.serverOwnedWritesProbeError]
          : []),
        ...(schema.atomicResponderActionProbeError
          ? [schema.atomicResponderActionProbeError]
          : []),
        ...(schema.atomicBundlePersistenceProbeError
          ? [schema.atomicBundlePersistenceProbeError]
          : []),
        ...(schema.operatorAccountIssuanceAuditProbeError
          ? [schema.operatorAccountIssuanceAuditProbeError]
          : []),
        ...(schema.scheduledRefreshProbeError
          ? [schema.scheduledRefreshProbeError]
          : []),
      ],
    }),
    { headers: { "Cache-Control": "no-store" } },
  );
}
