import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "./supabase";
import { bundleWriteFailure } from "./bundle-write";
import { decodeCheckpoint, encodeCheckpoint, type CheckpointManifest } from "./ingestion-checkpoint";
import type { Incident, LocationCandidate } from "./types";
import type { IngestionStatus } from "./ingestion-contract";

export type IngestionJob = {
  id: string; actor_id: string; organization_id: string; incident_key: string;
  kind: "create" | "refresh"; seed: {
    location?: Pick<LocationCandidate, "id" | "county" | "state" | "fips">;
    incident?: Incident; targetId?: string;
  };
  stage: string; status: IngestionStatus["status"]; lease_id: string | null;
  created_at: string; updated_at: string; attempts: number; error_code: string | null;
  progress: { published?: boolean; terrainCompleted?: number; terrainTotal?: number; inventory?: IngestionStatus["inventory"]; crossings?: IngestionStatus["crossings"] };
};
function client() {
  const db = getSupabaseAdminClient();
  if (!db) throw new Error("ingestion_storage_unavailable");
  return db as unknown as SupabaseClient;
}
export async function ingestionRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client().rpc(name, args);
  if (error) throw bundleWriteFailure(error);
  return data as T;
}
export async function readIngestionJob(id: string): Promise<IngestionJob | null> {
  const { data, error } = await client().from("ingestion_jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error("ingestion_read_unavailable");
  return data as IngestionJob | null;
}
export function publicIngestionStatus(job: IngestionJob): IngestionStatus {
  const location = job.seed.location ?? job.seed.incident;
  return { id: job.id, incidentId: job.incident_key, county: location ? `${location.county}, ${location.state}` : job.incident_key,
    status: job.status, stage: job.stage, updatedAt: job.updated_at, published: job.progress.published === true,
    terrainCompleted: job.progress.terrainCompleted ?? 0, terrainTotal: job.progress.terrainTotal ?? 0,
    ...(job.progress.inventory ? { inventory: job.progress.inventory } : {}),
    ...(job.progress.crossings ? { crossings: job.progress.crossings } : {}),
    errorCode: job.error_code };
}
export async function putCheckpoint(job: IngestionJob, key: string, value: unknown, compress = true) {
  const { manifest, parts } = encodeCheckpoint(value, compress);
  // Each write is bounded; the manifest is published only after every part is acknowledged.
  for (let start = 0; start < parts.length; start += 4) {
    await Promise.all(parts.slice(start, start + 4).map((value, index) => ingestionRpc("fireafter_checkpoint_ingestion", {
      p_id: job.id, p_lease: job.lease_id, p_key: key, p_part: start + index, p_value: value,
    })));
  }
  await ingestionRpc("fireafter_checkpoint_ingestion", { p_id: job.id, p_lease: job.lease_id, p_key: key, p_part: -1, p_value: manifest });
}
export async function putAtomicCheckpoint(job: IngestionJob, key: string, value: unknown) {
  const { manifest, parts } = encodeCheckpoint(value);
  // Mutable cursors and reservations must replace data and checksum together.
  // One compressed part fits the existing SQL row limit; never fall back to a torn write.
  if (parts.length !== 1) throw new Error("checkpoint_capacity");
  await ingestionRpc("fireafter_checkpoint_ingestion", { p_id: job.id, p_lease: job.lease_id, p_key: key, p_part: -1,
    p_value: { ...manifest, inlinePart: parts[0] } });
}
export async function readCheckpoint<T>(id: string, key: string): Promise<T | null> {
  const { data: header, error } = await client().from("ingestion_checkpoints").select("value")
    .eq("job_id", id).eq("key", key).eq("part", -1).maybeSingle();
  if (error) throw new Error("checkpoint_read_unavailable");
  if (!header) return null;
  const manifest = header.value as CheckpointManifest & { inlinePart?: { data: string } };
  if (Object.prototype.hasOwnProperty.call(manifest, "inlinePart")) {
    return decodeCheckpoint<T>(manifest, [{ part: 0, value: manifest.inlinePart! }]);
  }
  if (!Number.isSafeInteger(manifest.parts) || manifest.parts < 1 || manifest.parts > 1024) throw new Error("checkpoint_invalid");
  const parts: { part: number; value: { data: string } }[] = [];
  for (let start = 0; start < manifest.parts; start += 8) {
    const { data, error } = await client().from("ingestion_checkpoints").select("part,value")
      .eq("job_id", id).eq("key", key).gte("part", start).lt("part", Math.min(start + 8, manifest.parts)).order("part");
    if (error || !data) throw new Error("checkpoint_read_unavailable");
    parts.push(...data as typeof parts);
  }
  return decodeCheckpoint<T>(manifest, parts);
}
export async function readCommitReceipt(id: string, phase: string): Promise<{ incident_id: string; revision: string } | null> {
  const { data, error } = await client().from("ingestion_commit_receipts").select("incident_id,revision")
    .eq("job_id", id).eq("phase", phase).maybeSingle();
  if (error) throw new Error("receipt_read_unavailable");
  return data as { incident_id: string; revision: string } | null;
}
export async function previousIngestionJobs(job: IngestionJob) {
  const { data, error } = await client().from("ingestion_jobs").select("id")
    .eq("organization_id", job.organization_id).eq("incident_key", job.incident_key).eq("status", "completed")
    .order("created_at", { ascending: false }).limit(2);
  if (error) throw new Error("cache_read_unavailable");
  return (data ?? []) as { id: string }[];
}

export async function pendingIngestionDispatches() {
  const { data, error } = await client().from("ingestion_jobs").select("*")
    .in("status", ["queued", "running"]).lt("dispatch_after", new Date().toISOString())
    .lt("updated_at", new Date(Date.now() - 5 * 60_000).toISOString()).order("updated_at").limit(5);
  if (error) throw new Error("ingestion_outbox_unavailable");
  return (data ?? []) as IngestionJob[];
}
