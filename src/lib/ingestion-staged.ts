import "server-only";
import { createHash } from "node:crypto";
import { BundleWriteError } from "./bundle-write";
import { ingestionRpc, putCheckpoint, readCheckpoint, type IngestionJob } from "./ingestion-store";
import type { prepareIngestionPayload } from "./ingestion-payload";
import { encodeStagedRows, type RowEncoding } from "./ingestion-row-page";

type Payload = ReturnType<typeof prepareIngestionPayload>;
type Kind = "source" | "asset" | "recommendation";
type Counts = Record<Kind, number>;
export type StagedHeader = Pick<Payload, "organization" | "incident" | "auditEvents" | "write"> & { version: "staged-ingestion-v1"; rowsDigest: string };
export const STAGED_HEADER_KEY = "commit:staged:header";
export const STAGED_COMMIT_SECURITY_VERSION = "20261008140100";
const MAX_PAGE_BYTES = 24 * 1024 * 1024;

function counts(value: unknown, payload: Payload): Counts {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BundleWriteError("FB503");
  const record = value as Counts;
  for (const [kind, rows] of entries(payload)) {
    if (!Number.isSafeInteger(record[kind]) || record[kind] < 0 || record[kind] > rows.length) throw new BundleWriteError("FB503");
  }
  return record;
}
function entries(payload: Payload) {
  return [["source", payload.sourceSnapshots], ["asset", payload.assets], ["recommendation", payload.recommendations]] as const;
}
export function buildStagedHeader(payload: Payload): StagedHeader {
  const { actorId, organizationId, expectedRevision, databaseIncidentId, operation } = payload.write;
  const digest = createHash("sha256");
  for (const [kind, rows] of entries(payload)) {
    digest.update(kind).update("\n");
    for (const row of rows) digest.update(JSON.stringify(row)).update("\n");
  }
  return { version: "staged-ingestion-v1", rowsDigest: digest.digest("hex"), organization: payload.organization,
    incident: payload.incident, auditEvents: payload.auditEvents,
    write: { actorId, organizationId, expectedRevision, databaseIncidentId, operation } };
}
export async function stageIngestionPayload(job: IngestionJob, payload: Payload): Promise<boolean> {
  await verifyStagedCommitSecurity();
  let header = await readCheckpoint<StagedHeader>(job.id, STAGED_HEADER_KEY);
  if (header && !(header.incident.selected_fire.inventoryManifest as { sourceQueueVersion?: string }).sourceQueueVersion) {
    // Resume already-written source rows in their original format.
    payload = { ...payload, sourceSnapshots: payload.sourceSnapshots.map(row => {
      const raw = { ...row.raw_payload } as Record<string, unknown>;
      delete raw.queueReadModel;
      return { ...row, raw_payload: raw } as typeof row;
    }) };
  }
  const candidate = buildStagedHeader(payload);
  if (!header) {
    header = candidate;
    await putCheckpoint(job, STAGED_HEADER_KEY, header);
  }
  // Keep the first manifest revision and audit timestamp after a lost response.
  // SQL rejects input changes and binds all staged children to these exact IDs.
  const original = header.incident.selected_fire.inventoryManifest as { revision: string; recommendationIds: string[]; queueIndex?: unknown; sourceQueueVersion?: string };
  const nextInventory = { ...(candidate.incident.selected_fire.inventoryManifest as object), revision: original.revision } as Record<string, unknown>;
  if (original.sourceQueueVersion === undefined) delete nextInventory.sourceQueueVersion;
  // A retry must keep a pre-index header byte-for-byte, not retrofit its format.
  if (original.queueIndex === undefined) {
    const ids = nextInventory.recommendationIds;
    const originalIds = new Set(original.recommendationIds);
    if (!Array.isArray(original.recommendationIds) || !Array.isArray(ids) ||
      originalIds.size !== original.recommendationIds.length || ids.length !== originalIds.size ||
      new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !originalIds.has(id))) {
      throw new BundleWriteError("FB409");
    }
    nextInventory.recommendationIds = original.recommendationIds;
    delete nextInventory.queueIndex;
  }
  candidate.incident = { ...candidate.incident, selected_fire: { ...candidate.incident.selected_fire,
    inventoryManifest: nextInventory } };
  if (JSON.stringify(candidate) !== JSON.stringify(header)) throw new BundleWriteError("FB409");
  let saved = counts(await ingestionRpc("fireafter_begin_staged_ingestion", { p_id: job.id, p_lease: job.lease_id, p_header: header }), payload);
  let pages = 0, stagedBytes = 0;
  for (const [kind, rows] of entries(payload)) {
    while (saved[kind] < rows.length && pages < 16) {
      const position = saved[kind];
      const page: unknown[] = [];
      let bytes = 2;
      for (let index = position; index < rows.length && page.length < 256; index++) {
        const size = Buffer.byteLength(JSON.stringify(rows[index])) + 1;
        if (size > MAX_PAGE_BYTES) throw new BundleWriteError("FB400");
        if (bytes + size > MAX_PAGE_BYTES) break;
        page.push(rows[index]); bytes += size;
      }
      if (!page.length) throw new BundleWriteError("FB400");
      if (pages && stagedBytes + bytes > MAX_PAGE_BYTES) return false;
      const after = counts(await ingestionRpc("fireafter_stage_ingestion_rows", {
        p_id: job.id, p_lease: job.lease_id, p_kind: kind, p_position: position, p_rows: page,
      }), payload);
      if (after[kind] !== position + page.length || (Object.keys(saved) as Kind[]).some(key => key !== kind && after[key] !== saved[key])) {
        throw new BundleWriteError("FB503");
      }
      saved = after; pages++; stagedBytes += bytes;
    }
  }
  return entries(payload).every(([kind, rows]) => saved[kind] === rows.length);
}

export async function verifyStagedCommitSecurity() {
  if (await ingestionRpc("fireafter_staged_ingestion_security_version", {}) !== STAGED_COMMIT_SECURITY_VERSION) {
    throw new BundleWriteError("FB503");
  }
}

/** Read only the next immutable prepared page after reconciling SQL acknowledgments. */
export async function stagePreparedIngestion(job: IngestionJob, header: StagedHeader, totals: Counts,
  readPage: (kind: Kind, position: number) => Promise<unknown[]>, encoding?: RowEncoding): Promise<boolean> {
  await verifyStagedCommitSecurity();
  const prior = await readCheckpoint<StagedHeader>(job.id, STAGED_HEADER_KEY);
  if (prior && JSON.stringify(prior) !== JSON.stringify(header)) throw new BundleWriteError("FB409");
  if (!prior) await putCheckpoint(job, STAGED_HEADER_KEY, header);
  const kinds: Kind[] = ["source", "asset", "recommendation"];
  const parse = (value: unknown): Counts => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BundleWriteError("FB503");
    const result = value as Counts;
    if (kinds.some(kind => !Number.isSafeInteger(result[kind]) || result[kind] < 0 || result[kind] > totals[kind])) throw new BundleWriteError("FB503");
    return result;
  };
  let saved = parse(await ingestionRpc("fireafter_begin_staged_ingestion", { p_id: job.id, p_lease: job.lease_id, p_header: header }));
  let pages = 0, sentBytes = 0;
  for (const kind of kinds) {
    while (saved[kind] < totals[kind] && pages < 16) {
      const position = saved[kind], rows = await readPage(kind, position);
      const page = encodeStagedRows(rows, encoding);
      const size = Buffer.byteLength(JSON.stringify(page));
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 256 || position + rows.length > totals[kind] || size > MAX_PAGE_BYTES) {
        throw new BundleWriteError("FB400");
      }
      if (pages && sentBytes + size > MAX_PAGE_BYTES) return false;
      const after = parse(await ingestionRpc("fireafter_stage_ingestion_rows", {
        p_id: job.id, p_lease: job.lease_id, p_kind: kind, p_position: position, p_rows: page,
      }));
      if (after[kind] !== position + rows.length || kinds.some(other => other !== kind && after[other] !== saved[other])) throw new BundleWriteError("FB503");
      saved = after; pages++; sentBytes += size;
    }
  }
  return kinds.every(kind => saved[kind] === totals[kind]);
}
