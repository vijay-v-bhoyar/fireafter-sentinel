"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CurrentUser } from "@/lib/auth";
import { fetchHistoryPage, fetchHistoryRecord } from "@/lib/history-client";
import { HISTORY_UNAVAILABLE, HistoryError, HistoryQuerySchema, type HistoryRecord, type HistoryPage, type HistoryQuery } from "@/lib/history-contract";

export function HistoryExplorer(props: { incidentId: string; user: CurrentUser }) {
  return <HistorySession key={JSON.stringify([props.incidentId, props.user.id, props.user.organizationId, props.user.role])} {...props} />;
}
function HistorySession({ incidentId, user }: { incidentId: string; user: CurrentUser }) {
  const [lane, setLane] = useState<HistoryQuery["lane"]>("actions");
  const [limit, setLimit] = useState("25");
  const [draft, setDraft] = useState("");
  const [commandId, setCommandId] = useState<string | undefined>();
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; page?: HistoryPage; error?: string }>();
  const cursor = cursors.at(-1);
  const key = JSON.stringify([incidentId, lane, limit, cursor, commandId, attempt]);
  const current = result?.key === key ? result : undefined;
  const loading = !current;
  const page = current?.page;
  useEffect(() => {
    const controller = new AbortController();
    const query = HistoryQuerySchema.safeParse({ incidentId, lane, limit, cursor, commandId });
    const load = async () => {
      try {
        if (!query.success) throw new HistoryError(400, "Enter a valid command UUID, or clear the filter.");
        const next = await fetchHistoryPage(query.data, { actorId: user.id, organizationId: user.organizationId ?? "" }, controller.signal);
        if (!controller.signal.aborted) setResult({ key, page: next });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof HistoryError ? error.message : HISTORY_UNAVAILABLE });
      }
    };
    void load();
    return () => controller.abort();
  }, [key, incidentId, lane, limit, cursor, commandId, user.id, user.organizationId]);
  const latest = () => { setCursors([undefined]); setAttempt(value => value + 1); };
  return (
    <main className="min-h-screen bg-[#07131f] p-4 text-slate-100 md:p-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <nav className="flex flex-wrap gap-5 text-sm text-sky-200" aria-label="History navigation">
          <Link href={`/?incidentId=${encodeURIComponent(incidentId)}`}>Action Queue</Link>
          <Link href={`/map?incidentId=${encodeURIComponent(incidentId)}`}>Map View</Link>
          <Link href={`/assets?incidentId=${encodeURIComponent(incidentId)}`}>Assets</Link>
          <Link href={`/settings?incidentId=${encodeURIComponent(incidentId)}`}>Settings</Link>
        </nav>
        <header><p className="text-sm text-sky-200">FireAfter / retained records</p><h1 className="mt-2 text-2xl font-bold">History &amp; Audit</h1>
          <p className="mt-2 break-words text-sm text-slate-300">Incident: {page?.canonicalIncidentId ?? incidentId}</p>
          <p className="mt-2 text-sm text-slate-300">Historical evidence, not a current hazard assessment. Retired recommendations remain accessible. New records appear when you select Latest records.</p>
        </header>
        <form className="flex flex-wrap items-end gap-4 rounded-md border border-slate-700 bg-[#0b1d2d] p-4" onSubmit={event => { event.preventDefault(); setCommandId(draft.trim() || undefined); latest(); }}>
          <label className="text-sm">Records<select aria-label="Records" value={lane} onChange={event => { setLane(event.target.value as HistoryQuery["lane"]); latest(); }} className="mt-1 block rounded border border-slate-600 bg-slate-950 p-2"><option value="actions">Responder actions</option><option value="audit">Audit trail</option></select></label>
          <label className="text-sm">Page size<select aria-label="Page size" value={limit} onChange={event => { setLimit(event.target.value); latest(); }} className="mt-1 block rounded border border-slate-600 bg-slate-950 p-2">{[1, 10, 25, 50].map(size => <option key={size}>{size}</option>)}</select></label>
          <label className="min-w-0 flex-1 text-sm">Command ID (optional)<input value={draft} onChange={event => setDraft(event.target.value)} maxLength={36} className="mt-1 block w-full min-w-0 rounded border border-slate-600 bg-slate-950 p-2" /></label>
          <button className="rounded border border-sky-400 px-3 py-2 text-sm" type="submit">Find command</button>
          <button className="rounded border border-slate-500 px-3 py-2 text-sm" type="button" onClick={() => { setDraft(""); setCommandId(undefined); latest(); }}>Clear filter</button>
        </form>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setCursors(values => values.slice(0, -1))} disabled={cursors.length === 1 || loading} className="rounded border border-slate-500 px-3 py-2 disabled:opacity-40">Previous page</button>
          <button type="button" onClick={() => { if (page?.nextCursor) setCursors(values => [...values, page.nextCursor!]); }} disabled={!page?.nextCursor || loading} className="rounded border border-sky-400 px-3 py-2 disabled:opacity-40">Older records</button>
          <button type="button" onClick={latest} className="rounded border border-slate-500 px-3 py-2">Latest records</button>
          <span className="text-sm text-slate-400">Page {cursors.length}</span>
        </div>
        {loading && <p role="status">Loading history...</p>}
        {current?.error && <div role="alert" className="rounded border border-amber-400 p-4 text-amber-100"><p>{current.error}</p><p className="mt-2 text-sm">For large records, try a smaller page size. A failed read does not mean history is empty.</p><button className="mt-3 underline" onClick={() => setAttempt(value => value + 1)}>Retry history</button></div>}
        {page && <section aria-label="History records" className="space-y-4">
          <p role="status" className="text-sm text-slate-300">{page.entries.length} records on this page. {page.nextCursor ? "Older records are available." : "End of the matching history at this read."}</p>
          {page.entries.length === 0 && <p>No retained records on this page{commandId ? " for this command" : ""}. This does not establish rollback of an unconfirmed command.</p>}
          {page.entries.map(entry => <article key={entry.id} className="min-w-0 rounded-md border border-slate-700 bg-[#0b1d2d] p-4 [overflow-wrap:anywhere]">
            <h2 className="font-bold">{entry.type}</h2><p className="mt-2">{entry.summary}</p>
            <p className="mt-2 text-sm text-slate-300">{entry.actorName} / <time dateTime={entry.createdAt}>{entry.createdAt}</time></p>
            <p className="mt-2 text-xs text-slate-400">Recorded actor ID: {entry.actorId ?? "Not retained in this historical record"}</p>
            <p className="mt-2 text-xs text-slate-400">Record ID: {entry.id}</p>
            <HistoryEvidence key={`${key}:${entry.id}`} incidentId={incidentId} lane={lane} recordId={entry.id} user={user} />
          </article>)}
        </section>}
      </div>
    </main>
  );
}

function HistoryEvidence({ incidentId, lane, recordId, user }: { incidentId: string; lane: HistoryQuery["lane"]; recordId: string; user: CurrentUser }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; record?: HistoryRecord["record"]; error?: string }>();
  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    void fetchHistoryRecord({ incidentId, lane, recordId }, { actorId: user.id, organizationId: user.organizationId ?? "" }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setResult({ attempt, record: value.record }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ attempt, error: error instanceof HistoryError ? error.message : HISTORY_UNAVAILABLE }); });
    return () => controller.abort();
  }, [attempt, incidentId, lane, recordId, user.id, user.organizationId]);
  const current = result?.attempt === attempt ? result : undefined;
  return <div className="mt-3">
    <button className="text-sm text-sky-200 underline" onClick={() => setAttempt(value => value + 1)}>Read recorded evidence</button>
    {attempt > 0 && !current && <p role="status">Loading recorded evidence...</p>}
    {current?.error && <p role="alert" className="mt-2 text-amber-200">{current.error}</p>}
    {current?.record && <div>
      {current.record.provenanceFlag && <p className="mt-2 text-amber-200">Provenance review flag: this record matches the non-operational policy. It is retained here for audit, not presented as verified operational evidence.</p>}
      <p className="mt-2 text-sm">{current.record.summary}</p>
      <pre className="mt-3 whitespace-pre-wrap text-xs text-slate-300 [overflow-wrap:anywhere]">{JSON.stringify(current.record.details, null, 2)}</pre>
    </div>}
  </div>;
}
