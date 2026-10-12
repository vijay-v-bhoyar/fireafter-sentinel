"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CurrentUser } from "@/lib/auth";
import { fetchAssetInventoryPage } from "@/lib/asset-inventory-client";
import { ASSET_PAGE_UNAVAILABLE, AssetInventoryError, type AssetInventoryPage, type AssetInventoryQuery } from "@/lib/asset-inventory-contract";

const control = "min-h-11 rounded border border-slate-500 px-3 py-2 text-sm disabled:opacity-40";
const withheld = {
  "non-operational": "Excluded by the non-operational record policy.",
  "unverified-geometry": "Geometry could not be verified under the current validation rules.",
  "outside-county": "The saved location is outside the county boundary.",
};

export function AssetInventoryBrowser(props: { incidentId: string; user: CurrentUser }) {
  return <InventorySession key={JSON.stringify([props.incidentId, props.user.id, props.user.organizationId, props.user.role])} {...props} />;
}

function InventorySession({ incidentId, user }: { incidentId: string; user: CurrentUser }) {
  const [query, setQuery] = useState<AssetInventoryQuery>({ incidentId, start: "0", limit: "25" });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("1");
  const [result, setResult] = useState<{ key: string; page?: AssetInventoryPage; error?: string }>();
  const key = JSON.stringify([query, attempt]);
  const current = result?.key === key ? result : undefined;
  const page = current?.page;
  const loading = !current;
  useEffect(() => {
    const controller = new AbortController();
    void fetchAssetInventoryPage(query, { actorId: user.id, organizationId: user.organizationId ?? "" }, controller.signal)
      .then(page => { if (!controller.signal.aborted) setResult({ key, page }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, error: error instanceof AssetInventoryError ? error.message : ASSET_PAGE_UNAVAILABLE }); });
    return () => controller.abort();
  }, [key, query, user.id, user.organizationId]);
  const latest = () => { setQuery(value => ({ incidentId, limit: value.limit, start: "0" })); setDraft("1"); setAttempt(value => value + 1); };
  const move = (start: number) => { if (page) { setQuery(value => ({ ...value, start: String(start), revision: page.revision })); setDraft(String(start + 1)); } };
  const target = /^\d+$/.test(draft) ? Number(draft) : NaN;
  return <main className="fireafter-workspace min-h-screen p-4 text-slate-100 md:p-8">
    <div className="mx-auto max-w-5xl space-y-5">
      <nav className="flex flex-wrap gap-5 text-sm text-sky-300" aria-label="Asset inventory navigation">
        {[["Action Queue", "/"], ["Map View", "/map"], ["Assets & Upload", "/assets"], ["History & Audit", "/history"]].map(([label, path]) =>
          <Link key={path} prefetch={false} href={`${path}?incidentId=${encodeURIComponent(incidentId)}`}>{label}</Link>)}
      </nav>
      <header className="[overflow-wrap:anywhere]">
        <p className="text-sm text-slate-400">FireAfter / saved inventory</p>
        <h1 className="mt-2 text-2xl font-bold">County Asset Browser</h1>
        <p className="mt-2">{page ? `${page.county}, ${page.state}` : incidentId}</p>
        <p className="mt-2 text-sm text-slate-300">Stored inventory order, not priority rank. This view checks record provenance and county location; it does not establish current hazard, field condition, or complete county coverage.</p>
      </header>
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4">
        <label className="text-sm">Records per page<select aria-label="Records per page" value={query.limit} className={`mt-1 block ${control}`} onChange={event => {
          setQuery(value => ({ ...value, limit: event.target.value as AssetInventoryQuery["limit"], start: "0", revision: page?.revision ?? value.revision })); setDraft("1");
        }}>{[1, 10, 25, 50].map(size => <option key={size}>{size}</option>)}</select></label>
        <button className={control} disabled={loading || !page || page.start === 0} onClick={() => move(Math.max(0, page!.start - page!.limit))}>Previous page</button>
        <button className={control} disabled={loading || page?.nextStart == null} onClick={() => move(page!.nextStart!)}>Next page</button>
        <button className={control} onClick={latest}>Latest inventory</button>
        <form className="flex min-w-0 flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (page && Number.isSafeInteger(target) && target >= 1 && target <= page.totalStoredAssets) move(target - 1); }}>
          <label className="text-sm">Start at record<input className={`mt-1 block w-32 ${control}`} inputMode="numeric" maxLength={6} value={draft} onChange={event => setDraft(event.target.value)} /></label>
          <button className={control} disabled={!page || !Number.isSafeInteger(target) || target < 1 || target > page.totalStoredAssets}>Go to record</button>
        </form>
      </div>
      {loading && <p role="status">Loading saved assets...</p>}
      {current?.error && <div role="alert" className="rounded border border-amber-400 bg-amber-950/40 p-4 text-amber-100">
        <p>{current.error}</p><p className="mt-2 text-sm">A failed read does not mean the county has no assets. Try one record per page for a large record, or Latest inventory after a refresh.</p>
        <button className={`${control} mt-3`} onClick={() => setAttempt(value => value + 1)}>Retry page</button>
      </div>}
      {page && <section aria-label="Stored asset records" className="space-y-4">
        <p role="status">{page.items.length ? `Records ${page.start + 1}-${page.start + page.items.length} of ${page.totalStoredAssets.toLocaleString("en-US")} stored records` : "No stored asset records in this revision."}</p>
        <p className="text-xs text-slate-400 [overflow-wrap:anywhere]">Published: {page.publishedAt ?? "Time unavailable"}. Revision: {page.revision}. Totals count saved manifest entries, including withheld records; they are not a count of verified assets.</p>
        {page.items.map(item => <article key={`${page.revision}:${item.position}`} className="min-w-0 rounded-md border border-slate-700 bg-[var(--ops-panel)] p-4 [overflow-wrap:anywhere]">
          {item.status === "withheld" ? <><h2 className="font-semibold">Record {item.position}: withheld</h2><p className="mt-2">{withheld[item.reason]} This record is not presented as operational evidence.</p></> : <>
            <p className="text-xs text-slate-400">Record {item.position} / {item.asset.type}</p>
            <h2 className="mt-1 text-lg font-semibold">{item.asset.name}</h2>
            <p className="mt-1 text-sm">{item.asset.locationLabel}</p>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="font-semibold">Source</dt><dd>{item.asset.source}</dd></div>
              <div><dt className="font-semibold">Evidence confidence</dt><dd>{item.asset.confidence}{item.asset.localOrUploaded ? " / local upload, unverified" : ""}</dd></div>
              <div><dt className="font-semibold">Saved coordinates (longitude, latitude)</dt><dd>{item.asset.coordinates.join(", ")}</dd></div>
              <div><dt className="font-semibold">Asset ID</dt><dd>{item.asset.id}</dd></div>
            </dl>
            {item.asset.confidenceReason && <p className="mt-3 text-sm">{item.asset.confidenceReason}</p>}
            <details className="mt-3 text-sm"><summary className="cursor-pointer py-2 font-semibold">Saved source evidence</summary>
              <p>These are stored observations, not a current storm assessment.</p>
              <p className="mt-2">Source feature IDs: {[...new Set([item.asset.sourceFeatureId, ...item.asset.sourceFeatureIds].filter(Boolean))].join(", ") || "Not provided"}</p>
              {item.asset.sourceUrl && <p className="mt-2">Source reference: {item.asset.sourceUrl}</p>}
              {item.asset.evidence.map((evidence, index) => <p key={index} className="mt-2">{evidence.sourceName}: {evidence.summary}</p>)}
              {!item.asset.evidence.length && <p className="mt-2">No additional evidence retained.</p>}
            </details>
          </>}
        </article>)}
      </section>}
    </div>
  </main>;
}
