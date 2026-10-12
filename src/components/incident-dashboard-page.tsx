import Link from "next/link";
import { FireAfterDashboard, type Bundle } from "@/components/fireafter-dashboard";
import { getClientDashboardBundle } from "@/lib/fireafter-data";
import { getMapDashboardBundle, getQueueDashboardBundle } from "@/lib/queue-dashboard-server";

export type IncidentPageProps = {
  searchParams?: Promise<{ incidentId?: string | string[] }>;
};

export async function renderIncidentDashboard(
  searchParams: IncidentPageProps["searchParams"],
  initialView: "queue" | "map" | "assets" | "settings",
) {
  const { incidentId } = await searchParams ?? {};
  if (incidentId !== undefined && (typeof incidentId !== "string" ||
      !incidentId.trim() || incidentId.length > 256)) {
    return <main className="min-h-screen bg-[#07131f] p-8 text-slate-100">
      <h1>Incident unavailable</h1>
      <p role="alert">Invalid incident reference. Open one county from the Action Queue.</p>
      <Link href="/">Action Queue</Link>
    </main>;
  }
  const bundle: Bundle = await (initialView === "queue" ? getQueueDashboardBundle(incidentId)
    : initialView === "map" ? getMapDashboardBundle(incidentId) : getClientDashboardBundle(incidentId));
  const key = bundle.queuePage ? `${bundle.incident.id}:${bundle.currentUser?.id}:${bundle.currentUser?.organizationId}:${bundle.currentUser?.role}:${bundle.queuePage.revision}` : bundle.incident.id;
  return <FireAfterDashboard key={key} bundle={bundle} initialView={initialView} />;
}
