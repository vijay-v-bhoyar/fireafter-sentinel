import type { Metadata } from "next";
import Link from "next/link";
import { FeatureGraph } from "@/components/feature-graph";

export const metadata: Metadata = {
  title: "Product Feature Graph | FireAfter",
  description: "Explore FireAfter's documented features, evidence flow, interfaces, tests, and limits.",
};

export default async function FeaturesPage({ searchParams }: {
  searchParams?: Promise<{ incidentId?: string | string[] }>;
}) {
  const { incidentId } = await searchParams ?? {};
  if (incidentId !== undefined && (typeof incidentId !== "string" ||
      !incidentId.trim() || incidentId.length > 256)) {
    return <main className="min-h-screen bg-[#06111c] p-8 text-slate-100">
      <h1>Incident unavailable</h1>
      <p role="alert">Invalid incident reference. Open one county from the Action Queue.</p>
      <Link href="/">Action Queue</Link>
    </main>;
  }
  return (
    <main>
      <FeatureGraph incidentId={incidentId} />
    </main>
  );
}
