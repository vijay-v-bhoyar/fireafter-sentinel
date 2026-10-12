import Link from "next/link";
import { AssetInventoryBrowser } from "@/components/asset-inventory-browser";
import { getCurrentUser } from "@/lib/auth";
import { canWriteOperationalRecords } from "@/lib/role-capabilities";

export const dynamic = "force-dynamic";

export default async function AssetBrowsePage({ searchParams }: { searchParams: Promise<{ incidentId?: string | string[] }> }) {
  const params = await searchParams;
  const incidentId = params.incidentId ?? process.env.FIREAFTER_DEFAULT_INCIDENT_ID ?? "incident-utah-county-ut";
  if (typeof incidentId !== "string" || !incidentId.trim() || incidentId.length > 256) {
    return <main className="fireafter-workspace min-h-screen p-8 text-slate-100"><h1>County Asset Browser</h1><p role="alert">Invalid incident reference. Open one county from the Action Queue.</p><Link href="/">Action Queue</Link></main>;
  }
  const user = await getCurrentUser();
  if (!user || !canWriteOperationalRecords(user)) {
    const returnTo = `/assets/browse?incidentId=${encodeURIComponent(incidentId)}`;
    return <main className="fireafter-workspace min-h-screen p-8 text-slate-100"><h1>County Asset Browser</h1><p className="my-4">Commander or analyst organization membership is required to browse exact stored asset locations.</p><Link className="underline" href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</Link></main>;
  }
  return <AssetInventoryBrowser incidentId={incidentId.trim()} user={user} />;
}
