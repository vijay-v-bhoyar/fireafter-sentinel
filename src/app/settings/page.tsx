import { renderIncidentDashboard, type IncidentPageProps } from "@/components/incident-dashboard-page";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: IncidentPageProps) {
  return renderIncidentDashboard(searchParams, "settings");
}
