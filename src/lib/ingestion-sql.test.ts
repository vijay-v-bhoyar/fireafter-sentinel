import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, expect, it } from "vitest";
import { decodeCheckpoint, encodeCheckpoint, type CheckpointManifest } from "./ingestion-checkpoint";
import { CrossingCheckpointError, CrossingInferencePending } from "./crossing-checkpoint";
import { inferCrossingAssets, inferCrossingAssetsResumable } from "./live-sources";
import type { Incident } from "./types";
import type { Asset } from "./types";
import { DERIVED_ASSET_STATE, readDerivedAssetManifest, readDerivedAssetPage, stageDerivedAssets } from "./ingestion-assets";

let db: PGlite;
const actor = "10000000-0000-4000-a000-000000000001";
const org = "20000000-0000-4000-a000-000000000001";
const target = "30000000-0000-4000-a000-000000000001";
const revision = "40000000-0000-4000-a000-000000000001";
const job = "50000000-0000-4000-a000-000000000001";
const lease = "60000000-0000-4000-a000-000000000001";
const q = (sql: string, args: unknown[] = []) => db.query(sql, args);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create table public.organizations(id uuid primary key);
    create table public.organization_members(user_id uuid, organization_id uuid, role text);
    create table public.incidents(id uuid primary key);
    create table public.test_commits(id serial primary key, assets jsonb);
    create function public.fireafter_prevent_append_only_mutation() returns trigger language plpgsql as $$ begin raise exception 'append only'; end $$;
    create function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
    returns void language plpgsql as $$ begin
      insert into public.incidents(id) values (($5->>'id')::uuid) on conflict do nothing;
      insert into public.test_commits(assets) values($7);
      if $8->0->>'fail'='true' then raise exception 'simulated bundle rollback'; end if;
    end $$;`);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261007120000_durable_ingestion.sql", import.meta.url), "utf8"));
  await q("insert into auth.users values ($1)", [actor]);
  await q("insert into public.organizations values ($1)", [org]);
  await q("insert into public.organization_members values ($1,$2,'analyst')", [actor, org]);
}, 60_000);
afterAll(async () => { await db?.close(); });

it("stores derived pages through real fenced SQL and recovers a lost cursor response under a new lease", async () => {
  const id = "50000000-0000-4000-a000-000000000090";
  const oldLease = "60000000-0000-4000-a000-000000000090";
  let currentLease = oldLease;
  await q("select public.fireafter_enqueue_ingestion($1,$2,$3,'asset-pages-sql-test','create','{}')", [id, actor, org]);
  await q("select public.fireafter_claim_ingestion($1,$2)", [id, currentLease]);
  let lost = false;
  const store = {
    read: async (key: string) => {
      const header = await db.query<{ value: CheckpointManifest & { inlinePart?: { data: string } } }>(
        "select value from public.ingestion_checkpoints where job_id=$1 and key=$2 and part=-1", [id, key]);
      if (!header.rows.length) return null;
      const manifest = header.rows[0].value;
      const parts = manifest.inlinePart ? [{ part: 0, value: manifest.inlinePart }] :
        (await db.query<{ part: number; value: { data: string } }>(
          "select part,value from public.ingestion_checkpoints where job_id=$1 and key=$2 and part>=0 order by part", [id, key])).rows;
      return decodeCheckpoint(manifest, parts);
    },
    write: async (key: string, value: unknown) => {
      const { manifest, parts } = encodeCheckpoint(value);
      if (key === DERIVED_ASSET_STATE) {
        expect(parts).toHaveLength(1);
        await q("select public.fireafter_checkpoint_ingestion($1,$2,$3,-1,$4)", [id, currentLease, key,
          JSON.stringify({ ...manifest, inlinePart: parts[0] })]);
        if (!lost && (value as { next: number }).next === 1) {
          lost = true;
          throw new Error("lost cursor response");
        }
      } else {
        for (let part = 0; part < parts.length; part++) await q("select public.fireafter_checkpoint_ingestion($1,$2,$3,$4,$5)",
          [id, currentLease, key, part, JSON.stringify(parts[part])]);
        await q("select public.fireafter_checkpoint_ingestion($1,$2,$3,-1,$4)", [id, currentLease, key, JSON.stringify(manifest)]);
      }
    },
  };
  const input = Array.from({ length: 300 }, (_, index) => ({ id: `sql-asset-${index}`, coordinates: [-120, 34] }) as Asset);
  await expect(stageDerivedAssets(store, input)).rejects.toThrow("lost cursor response");
  expect(await readDerivedAssetManifest(store)).toMatchObject({ next: 1, total: 300 });
  await q("update public.ingestion_jobs set lease_until=now()-interval '1 second' where id=$1", [id]);
  currentLease = "60000000-0000-4000-a000-000000000091";
  await q("select public.fireafter_claim_ingestion($1,$2)", [id, currentLease]);
  await expect(q("select public.fireafter_checkpoint_ingestion($1,$2,$3,-1,'{}')", [id, oldLease, DERIVED_ASSET_STATE])).rejects.toThrow(/Lease lost/);
  const manifest = await stageDerivedAssets(store, input);
  expect(manifest.next).toBe(3);
  const restored: Asset[] = [];
  for (let index = 0; index < manifest.pages.length; index++) restored.push(...await readDerivedAssetPage(store, manifest, index));
  expect(restored).toEqual(input);
  expect((await q("select count(*)::int as n from public.ingestion_commit_receipts where job_id=$1", [id])).rows).toEqual([{ n: 0 }]);
}, 30_000);

it("denies direct access and worker RPCs to public/authenticated roles", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await expect(q("select * from public.ingestion_jobs")).rejects.toThrow(/permission denied/);
      await expect(q("select public.fireafter_claim_ingestion($1,$2)", [job, lease])).rejects.toThrow(/permission denied/);
    } finally { await db.exec("reset role"); }
  }
});
it("deduplicates county requests and binds request references to actor and scope", async () => {
  const args = [job, actor, org, "incident-test", "create", JSON.stringify({ incident: { county: "Test" } })];
  const a = await q("select public.fireafter_enqueue_ingestion($1,$2,$3,$4,$5,$6) as job", args);
  const b = await q("select public.fireafter_enqueue_ingestion($1,$2,$3,$4,$5,$6) as job", ["50000000-0000-4000-a000-000000000002", ...args.slice(1)]);
  expect(a.rows).toEqual(b.rows);
  await expect(q("select public.fireafter_enqueue_ingestion($1,$2,$3,$4,$5,$6)", [job, actor, org, "other", "create", "{}"])).rejects.toThrow(/scope mismatch/);
});
it("holds one lease and rejects stale-worker writes after recovery", async () => {
  const first = await q("select public.fireafter_claim_ingestion($1,$2) as job", [job, lease]);
  expect(first.rows[0]).toMatchObject({ job: { lease_id: lease } });
  expect((await q("select public.fireafter_claim_ingestion($1,$2) as job", [job, revision])).rows[0]).toEqual({ job: null });
  await q("update public.ingestion_jobs set lease_until=now()-interval '1 second' where id=$1", [job]);
  await q("select public.fireafter_claim_ingestion($1,$2)", [job, revision]);
  await expect(q("select public.fireafter_checkpoint_ingestion($1,$2,'base',0,'{}')", [job, lease])).rejects.toThrow(/Lease lost/);
  await q("update public.ingestion_jobs set lease_id=$1,stage='commit:initial' where id=$2", [lease, job]);
});

async function stagePayload(recommendations: object[] = []) {
  const payload = { write: { actorId: actor, expectedRevision: null, operation: "create" },
    organization: { id: org }, incident: { id: target, selected_fire: { domainIncidentId: "incident-test", inventoryManifest: { revision } } },
    assets: Array.from({ length: 5665 }, (_, id) => ({ id, evidence: "real inventory sized test fixture".repeat(20) })),
    sourceSnapshots: [], recommendations, auditEvents: [] };
  const { manifest, parts } = encodeCheckpoint(payload, false);
  for (let part = 0; part < parts.length; part++) {
    await q("select public.fireafter_checkpoint_ingestion($1,$2,'commit:initial',$3,$4)", [job, lease, part, JSON.stringify(parts[part])]);
  }
  await q("select public.fireafter_checkpoint_ingestion($1,$2,'commit:initial',-1,$3)", [job, lease, JSON.stringify(manifest)]);
}
it("rolls back the receipt and bundle together if the underlying commit fails", async () => {
  await stagePayload([{ fail: true }]);
  await expect(q("select public.fireafter_commit_ingestion($1,$2,'initial')", [job, lease])).rejects.toThrow(/simulated bundle rollback/);
  expect((await q("select count(*)::int as n from public.ingestion_commit_receipts")).rows).toEqual([{ n: 0 }]);
  expect((await q("select count(*)::int as n from public.test_commits")).rows).toEqual([{ n: 0 }]);
});
it("reconciles a lost response without duplicating a 5,665-asset commit", async () => {
  await stagePayload();
  await q("select public.fireafter_commit_ingestion($1,$2,'initial')", [job, lease]);
  // Caller did not receive the first response. Replay uses the persisted receipt.
  const replay = await q("select public.fireafter_commit_ingestion($1,$2,'initial') as id", [job, lease]);
  expect(replay.rows).toEqual([{ id: target }]);
  expect((await q("select jsonb_array_length(assets) as n from public.test_commits")).rows).toEqual([{ n: 5665 }]);
  expect((await q("select revision::text from public.ingestion_commit_receipts")).rows).toEqual([{ revision }]);
});
it("cannot declare completion without a final receipt", async () => {
  await expect(q("select public.fireafter_advance_ingestion($1,$2,'done','{}',null)", [job, lease])).rejects.toThrow(/Final receipt required/);
});
it("retains checkpoints across exhausted leases and resumes the same operation", async () => {
  const before = (await q("select count(*)::int as n from public.ingestion_checkpoints where job_id=$1", [job])).rows;
  await q("update public.ingestion_jobs set attempts=4,lease_until=now()-interval '1 second' where id=$1", [job]);
  expect((await q("select public.fireafter_claim_ingestion($1,$2) as job", [job, lease])).rows).toEqual([{ job: null }]);
  expect((await q("select status,error_code from public.ingestion_jobs where id=$1", [job])).rows).toEqual([{ status: "failed", error_code: "step_attempts_exhausted" }]);
  await q("select public.fireafter_resume_ingestion($1,$2,$3)", [job, actor, org]);
  expect((await q("select status,attempts from public.ingestion_jobs where id=$1", [job])).rows).toEqual([{ status: "queued", attempts: 0 }]);
  expect((await q("select count(*)::int as n from public.ingestion_checkpoints where job_id=$1", [job])).rows).toEqual(before);
  await q("select public.fireafter_claim_ingestion($1,$2)", [job, lease]);
});
it("throttles duplicate dispatch without changing job identity", async () => {
  expect((await q("select public.fireafter_dispatch_ingestion($1) as dispatched", [job])).rows).toEqual([{ dispatched: true }]);
  expect((await q("select public.fireafter_dispatch_ingestion($1) as dispatched", [job])).rows).toEqual([{ dispatched: false }]);
});
it("rechecks current membership even when replaying a committed receipt", async () => {
  await q("delete from public.organization_members where user_id=$1", [actor]);
  await expect(q("select public.fireafter_commit_ingestion($1,$2,'initial')", [job, lease])).rejects.toThrow(/Membership revoked/);
  await expect(q("update public.ingestion_commit_receipts set phase='final'")).rejects.toThrow(/append only/);
});

it.each([20_000, 100_000])("resumes crossing traversal with a %s ceiling through fenced SQL after response loss and lease replacement", async maxCandidates => {
  const actor = randomUUID(), org = randomUUID();
  const job = randomUUID(), oldLease = randomUUID();
  let currentLease = oldLease;
  await q("insert into auth.users values($1)", [actor]);
  await q("insert into public.organizations values($1)", [org]);
  await q("insert into public.organization_members values($1,$2,'analyst')", [actor, org]);
  await q("select public.fireafter_enqueue_ingestion($1,$2,$3,'crossing-sql-test','create','{}')", [job, actor, org]);
  await q("select public.fireafter_claim_ingestion($1,$2)", [job, currentLease]);
  let lostResponse = false;
  const store = {
    read: async (key: string) => {
      const header = await db.query<{ value: CheckpointManifest & { inlinePart?: { data: string } } }>(
        "select value from public.ingestion_checkpoints where job_id=$1 and key=$2 and part=-1", [job, key]);
      if (!header.rows.length) return null;
      const manifest = header.rows[0].value;
      const parts = manifest.inlinePart ? [{ part: 0, value: manifest.inlinePart }] :
        (await db.query<{ part: number; value: { data: string } }>(
          "select part,value from public.ingestion_checkpoints where job_id=$1 and key=$2 and part>=0 order by part", [job, key])).rows;
      return decodeCheckpoint(manifest, parts);
    },
    write: async (key: string, value: unknown) => {
      const { manifest, parts } = encodeCheckpoint(value);
      if (key.endsWith(":state")) {
        expect(parts).toHaveLength(1);
        await q("select public.fireafter_checkpoint_ingestion($1,$2,$3,-1,$4)", [job, currentLease, key,
          JSON.stringify({ ...manifest, inlinePart: parts[0] })]);
        if (!lostResponse && (value as { pages: number }).pages === 1) {
          lostResponse = true;
          throw new Error("simulated response loss after SQL commit");
        }
      } else {
        for (let part = 0; part < parts.length; part++) await q("select public.fireafter_checkpoint_ingestion($1,$2,$3,$4,$5)",
          [job, currentLease, key, part, JSON.stringify(parts[part])]);
        await q("select public.fireafter_checkpoint_ingestion($1,$2,$3,-1,$4)", [job, currentLease, key, JSON.stringify(manifest)]);
      }
    },
  };
  const incident = { id: "crossing-sql-test" } as Incident;
  const road = { id: "road", sourceKey: "tiger-roads", sourceName: "Roads",
    paths: [[[-120.001, 34], [-118.999, 34]]] as [number, number][][] };
  const flows = Array.from({ length: 100 }, (_, index) => ({ id: `flow-${index}`, sourceKey: "3dhp-flowlines", sourceName: "Hydro",
    paths: [[[-120 + index * 0.01, 33.999], [-120 + index * 0.01, 34.001]]] as [number, number][][] }));
  const resume = () => inferCrossingAssetsResumable(incident, [road], flows, [], store, { maxWork: 1200, maxCandidates });
  await expect(resume()).rejects.toBeInstanceOf(CrossingCheckpointError);
  await q("update public.ingestion_jobs set lease_until=now()-interval '1 second' where id=$1", [job]);
  currentLease = randomUUID();
  await q("select public.fireafter_claim_ingestion($1,$2)", [job, currentLease]);
  await expect(q("select public.fireafter_checkpoint_ingestion($1,$2,'crossings:stale',-1,'{}')", [job, oldLease])).rejects.toThrow(/Lease lost/);
  let result;
  for (let step = 0; step < 20; step++) {
    try { result = await resume(); break; }
    catch (error) { expect(error).toBeInstanceOf(CrossingInferencePending); }
  }
  expect(result).toEqual(inferCrossingAssets(incident, [road], flows));
  expect(await resume()).toEqual(result);
  expect((await q("select count(*)::int as n from public.ingestion_commit_receipts where job_id=$1", [job])).rows).toEqual([{ n: 0 }]);
}, 30_000);
