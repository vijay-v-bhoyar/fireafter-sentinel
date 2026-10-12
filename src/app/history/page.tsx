import Link from "next/link";
import { FireAfterDashboard } from "@/components/fireafter-dashboard";
import { getClientDashboardBundle } from "@/lib/fireafter-data";
import { getCurrentUser } from "@/lib/auth";
import { canWriteOperationalRecords } from "@/lib/role-capabilities";
import { HistoryExplorer } from "@/components/history-explorer";

export const dynamic = "force-dynamic";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ incidentId?: string | string[] }> }) {
  const params = await searchParams;
  if (params.incidentId !== undefined && (typeof params.incidentId !== "string" || params.incidentId.length < 1 || params.incidentId.length > 256)) {
    return <main className="min-h-screen bg-[#07131f] p-8 text-slate-100"><h1>History &amp; Audit</h1><p role="alert">Invalid history incident reference. Return to the Action Queue and open history for one incident.</p><Link href="/">Action Queue</Link></main>;
  }
  const user = await getCurrentUser();
  const incidentId = typeof params.incidentId === "string" ? params.incidentId : undefined;
  if (incidentId && user && canWriteOperationalRecords(user)) return <HistoryExplorer incidentId={incidentId} user={user} />;
  const bundle = await getClientDashboardBundle(incidentId);
  if (user && canWriteOperationalRecords(user) && bundle.dataAvailability !== "unavailable") {
    return <HistoryExplorer incidentId={bundle.incident.id} user={user} />;
  }
  return <FireAfterDashboard bundle={bundle} initialView="history" />;
}
