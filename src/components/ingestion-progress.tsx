"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { ingestionLabel, type IngestionStatus } from "@/lib/ingestion-contract";
import type { Bundle } from "./fireafter-dashboard";

const PendingSchema = z.object({ id: z.uuid(), kind: z.enum(["create", "refresh"]), target: z.string().min(1).max(256) }).strict();
type Pending = z.infer<typeof PendingSchema>;
export type IngestionReply = { ingestion: IngestionStatus; dispatchPending?: boolean; workspace?: Bundle };

export function useIngestionProgress(userId?: string) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [job, setJob] = useState<IngestionStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const storageKey = userId ? `fireafter:ingestion:v1:${userId}` : null;

  useEffect(() => {
    let canceled = false;
    void Promise.resolve().then(() => {
      if (canceled) return;
      setPending(null); setJob(null);
      if (!storageKey) return;
      try {
        const raw = localStorage.getItem(storageKey);
        const stored = raw ? PendingSchema.safeParse(JSON.parse(raw)) : null;
        if (stored?.success) setPending(stored.data);
      } catch { setProblem("Browser recovery storage is unavailable. Keep the operation reference shown below."); }
    });
    return () => { canceled = true; };
  }, [storageKey]);

  useEffect(() => {
    if (!pending || !userId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/ingestion/${pending.id}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 404
          ? "This operation is not confirmed yet. Retry the original request below; do not create a new operation."
          : "Cannot check progress right now. Saved work is not discarded. Check again or resume the original operation.");
        const body = await response.json() as IngestionReply;
        if (controller.signal.aborted) return;
        setJob(body.ingestion);
        setProblem(null);
        failures = 0;
        if (["completed", "failed"].includes(body.ingestion.status)) return;
      } catch (error) {
        if (controller.signal.aborted) return;
        failures++;
        setProblem(error instanceof Error ? error.message : "Progress is temporarily unavailable.");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, Math.min(30_000, 3000 * 2 ** Math.min(failures, 3)));
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending, userId]);

  function begin(input: Omit<Pending, "id">) {
    if (!storageKey) throw new Error("Sign in before starting ingestion.");
    if (pending && !["completed", "failed"].includes(job?.status ?? "")) {
      if (pending.kind === input.kind && pending.target === input.target) return pending.id;
      throw new Error("Reconcile the saved county operation before starting another one.");
    }
    const next = { ...input, id: crypto.randomUUID() };
    localStorage.setItem(storageKey, JSON.stringify(next));
    setPending(next); setJob(null); setProblem(null);
    return next.id;
  }
  function accept(reply: IngestionReply) {
    setJob(reply.ingestion);
    if (storageKey) {
      const saved = PendingSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? "null"));
      if (saved.success && saved.data.id !== reply.ingestion.id) {
        const next = { ...saved.data, id: reply.ingestion.id };
        localStorage.setItem(storageKey, JSON.stringify(next)); setPending(next);
      }
    }
    setProblem(reply.dispatchPending ? "The operation is saved, but worker dispatch is unconfirmed. Resume this operation if progress does not start within three minutes." : null);
  }
  function clear() {
    if (storageKey) localStorage.removeItem(storageKey);
    setPending(null); setJob(null); setProblem(null);
  }
  async function resume() {
    if (!pending || checking) return;
    setChecking(true);
    try {
      const endpoint = job ? `/api/ingestion/${pending.id}`
        : pending.kind === "create" ? "/api/incident" : `/api/refresh/${encodeURIComponent(pending.target)}`;
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Ingestion-Operation-ID": pending.id },
        ...(!job && pending.kind === "create" ? { body: JSON.stringify({ locationId: pending.target }) } : {}) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Recovery request unconfirmed. Keep this operation reference.");
      if (!body.ingestion) throw new Error("This deployment does not support background recovery. Reload to inspect the current incident before retrying.");
      accept(body);
      setPending({ ...pending, id: body.ingestion.id });
    } catch (error) { setProblem(error instanceof Error ? error.message : "Recovery request failed."); }
    finally { setChecking(false); }
  }
  return { pending, job, problem, checking, begin, accept, clear, resume };
}

export function IngestionProgress({ state }: { state: ReturnType<typeof useIngestionProgress> }) {
  if (!state.pending) return null;
  const { job, pending } = state;
  const terminal = job && ["failed", "completed"].includes(job.status);
  return <section aria-label="County processing progress" aria-live="polite" className="mb-4 rounded-lg border border-amber-700/50 bg-[var(--ops-panel)] p-4 text-slate-100">
    <h2 className="font-semibold">{job?.county ?? pending.target}: {job ? ingestionLabel(job.stage) : "Confirming saved operation"}</h2>
    <p className="mt-1 text-sm text-slate-300">{!job
      ? "The operation reference is saved in this browser. Server acceptance is not yet confirmed."
      : job.status === "failed"
      ? `Processing stopped (${job.errorCode}). ${job.published ? "Previously published evidence remains available; review its dates and limitations." : "No evidence has been published for this operation."}`
      : job.status === "completed" ? "Processing has finished. Open the saved incident and review source coverage; completion does not mean every source was available."
      : "Work is saved between stages. You can leave this page and return without restarting the county download."}</p>
    {!!job?.terrainTotal && <p className="mt-1 text-sm">Terrain batches saved: {job.terrainCompleted} / {job.terrainTotal}. Unavailable samples remain Unknown.</p>}
    {job?.inventory && <p className="mt-1 text-sm">{job.inventory.source} features saved: {job.inventory.saved} / {job.inventory.total}. Full inventory verification is still required.</p>}
    {job?.crossings && <p className="mt-1 text-sm">Roads processed: {job.crossings.roadsCompleted}. Screening candidates checkpointed: {job.crossings.candidatesSaved}. The complete set must be verified before publication.</p>}
    {job?.errorCode === "inference_candidates" && <p className="mt-1 text-sm">This county exceeds the current candidate capacity. Repeating Refresh will not resolve the limit; operator review is required. No partial crossing inventory was published.</p>}
    {job?.errorCode && job.status !== "failed" && <p className="mt-1 text-sm">{job.errorCode === "inventory_refresh_unavailable"
      ? "The inventory provider did not return a complete replacement. The last saved county remains available with its original dates. The worker will retry this stage; no assets were removed by this attempt."
      : `This stage was interrupted (${job.errorCode}). The worker will retry from the saved checkpoint after its lease expires.`}</p>}
    {state.problem && <p role="alert" className="mt-2 text-sm text-amber-200">{state.problem}</p>}
    <p className="mt-2 break-all text-xs text-slate-400">Operation: {pending.id}</p>
    <div className="mt-3 flex flex-wrap gap-4 text-sm">
      {job?.published && <a className="underline" href={`/?incidentId=${encodeURIComponent(job.incidentId)}`}>Open available evidence</a>}
      {(!terminal || job?.errorCode === "step_attempts_exhausted") && <button type="button" disabled={state.checking} className="underline disabled:opacity-50" onClick={() => void state.resume()}>Resume original operation</button>}
      {terminal && <button type="button" className="underline" onClick={state.clear}>Dismiss operation status</button>}
    </div>
  </section>;
}
