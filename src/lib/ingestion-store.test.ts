import { randomBytes } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { encodeCheckpoint } from "./ingestion-checkpoint";
import { putAtomicCheckpoint, readCheckpoint, type IngestionJob } from "./ingestion-store";

const storage = vi.hoisted(() => ({ rows: new Map<string, unknown>(), rpc: vi.fn(), partReads: vi.fn() }));
vi.mock("./supabase", () => ({ getSupabaseAdminClient: () => ({
  rpc: (...args: unknown[]) => storage.rpc(...args),
  from: () => {
    let key = "", part = -1, start = 0, end = 0;
    const query = {
      select: () => query,
      eq: (field: string, value: string | number) => { if (field === "key") key = String(value); if (field === "part") part = Number(value); return query; },
      maybeSingle: async () => ({ data: storage.rows.has(`${key}:${part}`) ? { value: structuredClone(storage.rows.get(`${key}:${part}`)) } : null, error: null }),
      gte: (_field: string, value: number) => { start = value; return query; },
      lt: (_field: string, value: number) => { end = value; return query; },
      order: async () => {
        storage.partReads();
        return { data: Array.from({ length: end - start }, (_, index) => ({ part: start + index, value: storage.rows.get(`${key}:${start + index}`) })), error: null };
      },
    };
    return query;
  },
}) }));
const job = { id: "test-job", lease_id: "test-lease" } as IngestionJob;
const key = "arcgis:test:state";
beforeEach(() => {
  storage.rows.clear(); storage.partReads.mockReset(); storage.rpc.mockReset();
  storage.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    storage.rows.set(`${args.p_key}:${args.p_part}`, structuredClone(args.p_value));
    return { data: null, error: null };
  });
});

it("atomically replaces mutable cursor, budget and checksum with one fenced RPC", async () => {
  const old = { cursor: 0, bytes: 50, ids: [1, 2] };
  const updated = { ...old, cursor: 2, bytes: 950 };
  await putAtomicCheckpoint(job, key, old);
  await putAtomicCheckpoint(job, key, updated);
  expect(storage.rpc).toHaveBeenCalledTimes(2);
  expect(storage.rpc).toHaveBeenLastCalledWith("fireafter_checkpoint_ingestion", expect.objectContaining({ p_id: job.id, p_lease: job.lease_id, p_key: key, p_part: -1 }));
  expect(await readCheckpoint(job.id, key)).toEqual(updated);
  expect(storage.partReads).not.toHaveBeenCalled();
});

it("reconciles an acknowledged-by-database update after its response was lost", async () => {
  await putAtomicCheckpoint(job, key, { cursor: 0, bytes: 10 });
  const write = storage.rpc.getMockImplementation()!;
  storage.rpc.mockImplementationOnce(async (...args: unknown[]) => { await write(...args); return { error: { code: "FB503" } }; });
  const updated = { cursor: 200, bytes: 1000 };
  await expect(putAtomicCheckpoint(job, key, updated)).rejects.toMatchObject({ code: "FB503" });
  expect(await readCheckpoint(job.id, key)).toEqual(updated);
});

it("retains the complete old state when a fenced update does not commit", async () => {
  const old = { cursor: 0, bytes: 10 };
  await putAtomicCheckpoint(job, key, old);
  storage.rpc.mockResolvedValueOnce({ error: { code: "FB409" } });
  await expect(putAtomicCheckpoint(job, key, { cursor: 200, bytes: 1000 })).rejects.toMatchObject({ code: "FB409" });
  expect(await readCheckpoint(job.id, key)).toEqual(old);
});

it("keeps legacy multipart checkpoints readable and rejects an altered inline payload", async () => {
  const value = { cursor: 200, bytes: 1000 };
  const { manifest, parts } = encodeCheckpoint(value);
  storage.rows.set(`${key}:-1`, manifest);
  parts.forEach((part, index) => storage.rows.set(`${key}:${index}`, part));
  expect(await readCheckpoint(job.id, key)).toEqual(value);
  await putAtomicCheckpoint(job, key, value);
  const header = storage.rows.get(`${key}:-1`) as { hash: string };
  header.hash = "0".repeat(64);
  await expect(readCheckpoint(job.id, key)).rejects.toThrow("checkpoint_invalid");
});

it("fails before writing when compact state exceeds one bounded part", async () => {
  const value = { ids: randomBytes(600_000).toString("hex") };
  await expect(putAtomicCheckpoint(job, key, value)).rejects.toThrow("checkpoint_capacity");
  expect(storage.rpc).not.toHaveBeenCalled();
});
