import { timingSafeEqual } from "node:crypto";
import { refreshIncidentBundle } from "@/lib/fireafter-data";
import {
  claimSupabaseScheduledRefreshes,
  settleSupabaseScheduledRefresh,
  type ScheduledRefreshClaim,
} from "@/lib/fireafter-supabase";
import { errorMessage } from "@/lib/error-message";
import { RefreshOperationError, withRefreshOperation } from "@/lib/refresh-operation";

export const dynamic = "force-dynamic";

const DEFAULT_INCIDENT_LIMIT = 20;
const MAX_INCIDENT_LIMIT = 20;
const DEFAULT_LEASE_SECONDS = 600;
const MAX_LEASE_SECONDS = 900;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return Response.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 },
    );
  }

  if (!hasValidBearerSecret(authHeader, cronSecret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try { return await withRefreshOperation("cron", runScheduledRefresh, request.signal); }
  catch (error) {
    if (error instanceof RefreshOperationError) return Response.json({ ok: false, error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    throw error;
  }
}

async function runScheduledRefresh() {
  const parsedLimit = Number(
    process.env.FIREAFTER_CRON_INCIDENT_LIMIT ?? DEFAULT_INCIDENT_LIMIT,
  );
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), MAX_INCIDENT_LIMIT)
      : DEFAULT_INCIDENT_LIMIT;
  const parsedLeaseSeconds = Number(
    process.env.FIREAFTER_CRON_LEASE_SECONDS ?? DEFAULT_LEASE_SECONDS,
  );
  const leaseSeconds =
    Number.isSafeInteger(parsedLeaseSeconds) && parsedLeaseSeconds >= 60
      ? Math.min(parsedLeaseSeconds, MAX_LEASE_SECONDS)
      : DEFAULT_LEASE_SECONDS;
  let claims: ScheduledRefreshClaim[];
  try {
    claims = await claimSupabaseScheduledRefreshes(limit, undefined, leaseSeconds);
  } catch (error) {
    if (error instanceof RefreshOperationError) throw error;
    console.error(
      "[fireafter] cron incident claim failed",
      errorMessage(error, "Incident claim failed"),
    );
    return Response.json(
      { ok: false, error: "Incident claim failed" },
      { status: 500 },
    );
  }
  console.info("[fireafter] cron refresh claims", {
    claimCount: claims.length,
    leaseSeconds,
  });
  const results = [];

  for (const claim of claims) {
    let refreshed: Awaited<ReturnType<typeof refreshIncidentBundle>>;
    try {
      // The lease owns a database row, not a mutable or potentially shared alias.
      refreshed = await refreshIncidentBundle(claim.databaseIncidentId, { kind: "cron" }, true);
      if (refreshed.incident.recoveryScopeId !== claim.databaseIncidentId) {
        throw new Error("Scheduled refresh returned an unconfirmed incident identity");
      }
    } catch (error) {
      if (error instanceof RefreshOperationError) throw error;
      console.error(
        `[fireafter] cron refresh failed for ${claim.incidentId}`,
        errorMessage(error, "Incident refresh failed"),
      );
      try {
        await settleSupabaseScheduledRefresh(claim, false);
      } catch (settlementError) {
        console.error(
          `[fireafter] cron refresh lease settlement failed for ${claim.incidentId}`,
          errorMessage(settlementError, "Refresh lease settlement failed"),
        );
      }
      results.push({
        ok: false,
        incidentId: claim.incidentId,
        error: "Incident refresh failed",
      });
      continue;
    }

    try {
      await settleSupabaseScheduledRefresh(claim, true);
      results.push({
        ok: true,
        incidentId: refreshed.incident.id,
        recommendationCount: refreshed.recommendations.length,
      });
    } catch (error) {
      console.error(
        `[fireafter] cron refresh lease settlement failed for ${claim.incidentId}`,
        errorMessage(error, "Refresh lease settlement failed"),
      );
      results.push({
        ok: false,
        incidentId: claim.incidentId,
        error: "Refresh lease settlement failed",
      });
    }
  }

  const failedCount = results.filter((result) => !result.ok).length;

  return Response.json({
    ok: failedCount === 0,
    refreshedAt: new Date().toISOString(),
    refreshedCount: results.length - failedCount,
    failedCount,
    results,
  }, { status: failedCount > 0 ? 500 : 200 });
}

function hasValidBearerSecret(authHeader: string | null, cronSecret: string) {
  if (!authHeader) return false;
  const supplied = Buffer.from(authHeader);
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
