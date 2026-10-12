import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildSupabasePayload, recordSupabaseAction } from "./fireafter-supabase";
import { readHistoryPage, readHistoryRecord } from "./history-server";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { QUEUE_SOURCE_SELECT, queueSourceProjection } from "./queue-source-read-model";
import { ATOMIC_RESPONDER_ACTION_SECURITY_RPC, ATOMIC_RESPONDER_ACTION_SECURITY_VERSION } from "./operational-write-security";
import { queuePage } from "../test/queue-page-fixture";
import { inventoryUser as user } from "../test/asset-page-fixture";
import type { Asset, SourceSnapshot } from "./types";
import type { InventoryManifest } from "./inventory-manifest";
import type { HistoryLaneSchema } from "./history-contract";
import type { z } from "zod";

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("./supabase", () => ({ getSupabaseAdminClient: mocks.client }));
let db: PGlite;
const requests: URL[] = [];
let beforeCommit: (() => Promise<void>) | undefined;
const migration = (name: string) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const q = (sql: string, args: unknown[] = []) => db.query<{ value: unknown }>(sql, args);
const serviceQuery = (sql: string, args: unknown[]) => db.transaction(async tx => {
  await tx.exec("set local role service_role");
  return tx.query<{ value: unknown }>(sql, args);
});

// Explicit SDK-to-SQL translation against production tables/functions. This is
// not PostgREST, Supabase Auth, PostGIS, hosted RLS or concurrency certification.
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input)); requests.push(url);
  try {
    const table = url.pathname.split("/").at(-1)!, p = url.searchParams;
    if (table === ATOMIC_RESPONDER_ACTION_SECURITY_RPC) {
      expect(init?.method).toBe("POST"); const args = JSON.parse(String(init?.body));
      if (args.p_action && beforeCommit) { const hook = beforeCommit; beforeCommit = undefined; await hook(); }
      const result = await serviceQuery(`select public.fireafter_record_responder_command($1,$2,$3,$4,$5,$6,$7) value`,
        [args.p_command_id, args.p_actor_id, args.p_organization_id, args.p_expected_revision,
          JSON.stringify(args.p_request), args.p_action === null ? null : JSON.stringify(args.p_action), args.p_audit_event === null ? null : JSON.stringify(args.p_audit_event)]);
      return Response.json(result.rows[0].value);
    }
    expect(init?.method ?? "GET").toBe("GET");
    let values: unknown[] = [], from: string, projection: string, suffix = "";
    const eq = (key: string) => { const value = p.get(key); expect(value).toMatch(/^eq\./); return value!.slice(3); };
    if (table === "incidents" || table === "recommendations") {
      expect(p.get("select")).toBe("*");
      const metadata = table === "incidents" ? "selected_fire" : "score_breakdown";
      if (p.has("id")) { values = [eq("id")]; from = `from public.${table} t where t.id=$1::uuid`; }
      else {
        expect(p.get(metadata)).toMatch(/^cs\./); values = [p.get(metadata)!.slice(3)];
        from = `from public.${table} t where t.${metadata} @> $1::jsonb`;
      }
      projection = "to_jsonb(t)";
    } else if (table === "assets") {
      expect(p.get("select")).toBe("*"); values = [eq("incident_id"), eq("id")];
      from = "from public.assets t where t.incident_id=$1::uuid and t.id=$2::uuid"; projection = "to_jsonb(t)";
    } else if (table === "source_snapshots") {
      expect(p.get("select")).toBe(QUEUE_SOURCE_SELECT); expect(p.get("id")).toMatch(/^in\.\(/);
      values = [eq("incident_id"), p.get("id")!.slice(4, -1).split(",")];
      from = "from public.source_snapshots t where t.incident_id=$1::uuid and t.id=any($2::uuid[])";
      projection = "to_jsonb(t)"; suffix = "order by t.id limit 2";
    } else {
      expect(["responder_actions", "audit_events"]).toContain(table);
      const action = table === "responder_actions", detail = p.has("id");
      values = [eq(action ? "recommendations.incident_id" : "incident_id")];
      from = action ? "from public.responder_actions t join public.recommendations r on r.id=t.recommendation_id where r.incident_id=$1::uuid"
        : "from public.audit_events t where t.incident_id=$1::uuid";
      if (detail) { values.push(eq("id")); from += " and t.id=$2::uuid"; }
      if (p.has("recommendation_snapshot->>domainActionId")) {
        const filter = p.get("recommendation_snapshot->>domainActionId")!; expect(filter).toMatch(/^like\.action-command-%-/);
        values.push(filter.slice(5)); from += ` and t.recommendation_snapshot->>'domainActionId' like $${values.length}`;
      }
      if (p.has("payload->>commandId")) { values.push(eq("payload->>commandId")); from += ` and t.payload->>'commandId'=$${values.length}`; }
      if (p.has("or")) {
        const cursor = p.get("or")!.match(/^\(created_at.lt.(.+),and\(created_at.eq.(.+),id.lt.([a-f0-9-]+)\)\)$/)!;
        expect(cursor).toBeTruthy(); expect(cursor[1]).toBe(cursor[2]);
        values.push(cursor[1], cursor[3]); from += ` and (t.created_at<$${values.length - 1}::timestamptz or (t.created_at=$${values.length - 1}::timestamptz and t.id<$${values.length}::uuid))`;
      }
      if (!detail) {
        expect(p.get("order")).toBe("created_at.desc,id.desc");
        expect(p.get("select")).not.toMatch(/(?:^|,)(?:note|summary|payload|recommendation_snapshot)(?:,|$)/);
        projection = `jsonb_build_object('id',t.id,'created_at',t.created_at,'actor_id',t.actor_id,'actor_name',t.actor_name,${action
          ? "'action',t.action,'command_reference',t.recommendation_snapshot->>'domainActionId','recommendations',jsonb_build_object('incident_id',r.incident_id)"
          : "'incident_id',t.incident_id,'event_type',t.event_type,'command_reference',t.payload->>'commandId'"})`;
        suffix = `order by t.created_at desc,t.id desc limit ${Math.min(2, Number(p.get("limit")))}`;
      } else projection = action ? "to_jsonb(t)||jsonb_build_object('recommendations',jsonb_build_object('incident_id',r.incident_id))" : "to_jsonb(t)";
    }
    const count = (await serviceQuery(`select count(*)::int value ${from}`, values)).rows[0].value;
    let rows = (await serviceQuery(`select ${projection} value ${from} ${suffix}`, values)).rows.map(row => row.value);
    if (table === "source_snapshots") rows = rows.map(row => queueSourceProjection(row as Parameters<typeof queueSourceProjection>[0]));
    return Response.json(rows, { headers: { "content-range": `0-${Math.max(0, rows.length - 1)}/${count}` } });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error)) throw error;
    return Response.json({ code: error.code, message: "Local SQL rejected the request" }, { status: 400 });
  }
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;`);
  // Only the unused PostGIS column/index is substituted; command SQL is unchanged.
  const schema = (await migration("0001_fireafter_schema"))
    .replace("create extension if not exists postgis with schema extensions;", "")
    .replace("geom extensions.geography(point, 4326)", "geom jsonb")
    .replace("create index if not exists assets_geom_idx on public.assets using gist (geom);", "");
  await db.exec(schema);
  for (const name of ["20260627180530_reality_upgrade", "20260906120000_atomic_responder_action_audit", "20260914010000_responder_command_contract"]) {
    await db.exec(`begin; ${await migration(name)}; commit;`);
  }
  await q("insert into auth.users values($1)", [user.id]);
  await q("insert into public.organizations(id,name) values($1,'Local SQL test')", [user.organizationId]);
  await q("insert into public.organization_members(organization_id,user_id,role) values($1,$2,'analyst')", [user.organizationId, user.id]);
  mocks.client.mockReturnValue(createClient("https://local-history-sql.invalid", "local-only", { auth: { persistSession: false }, global: { fetch: fetcher } }));
}, 30000);
beforeEach(async () => {
  requests.length = 0; beforeCommit = undefined;
  await db.exec("set timezone='Etc/GMT+5'");
  await q("update public.organization_members set role='analyst' where user_id=$1", [user.id]);
});
afterAll(async () => { mocks.client.mockReset(); await db?.close(); });

async function fixture() {
  const incident = { ...createIncidentFromLocation(searchLocations("los-angeles-ca")[0]), id: `incident-sql-${randomUUID()}` };
  const item = queuePage(0, 1, 1).items[0]; if (item.status !== "available") throw new Error("Missing fixture");
  const recommendation = { ...item.recommendation, id: `rec-${incident.id}`, assetId: `asset-${incident.id}`, incidentId: incident.id, coordinates: [-118.25, 34.05] as [number, number] };
  const asset: Asset = { id: recommendation.assetId, incidentId: incident.id, name: recommendation.assetName, type: "Bridge", locationLabel: "Creek",
    coordinates: recommendation.coordinates, source: "National Bridge Inventory", sourceKey: "nbi", confidence: "Medium", localOrUploaded: false };
  const time = new Date().toISOString();
  const source: SourceSnapshot = { id: `source-${incident.id}`, incidentId: incident.id, sourceKey: "nbi", sourceName: "Bridge Inventory", fetchedAt: time,
    sourceUpdatedAt: time, sourceTimeBasis: "provider", status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Checked", detail: "Local SQL fixture" };
  const payload = buildSupabasePayload({ incident, recommendations: [recommendation], sourceSnapshots: [source] }, { assets: [asset],
    write: { actorId: user.id, organizationId: user.organizationId, operation: "create", expectedRevision: null } });
  for (const [table, rows] of [["incidents", [payload.incident]], ["assets", payload.assets], ["recommendations", payload.recommendations], ["source_snapshots", payload.sourceSnapshots]] as const) {
    const values = rows.map(row => ({ created_at: time, derived_signals: {}, ...row }));
    await q(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table},$1)`, [JSON.stringify(values)]);
  }
  const input = { commandId: randomUUID(), expectedRevision: (payload.incident.selected_fire.inventoryManifest as InventoryManifest).revision,
    recommendationId: payload.recommendations[0].id, action: "annotate" as const, note: "Local SQL decision", actorName: "Local reviewer", actorId: user.id, actorOrganizationId: user.organizationId };
  return { payload, input, incidentId: incident.id };
}
async function counts(incidentId: string) {
  return (await q(`select jsonb_build_object('actions',(select count(*) from public.responder_actions a join public.recommendations r on r.id=a.recommendation_id where r.incident_id=$1),
    'audit',(select count(*) from public.audit_events where incident_id=$1),'receipts',(select count(*) from public.responder_command_receipts where incident_id=$1)) value`, [incidentId])).rows[0].value;
}

it("attests the unchanged command SQL and denies direct receipt mutation", async () => {
  expect((await serviceQuery("select public.fireafter_responder_action_security_version() value", [])).rows[0].value).toBe(ATOMIC_RESPONDER_ACTION_SECURITY_VERSION);
  await expect(serviceQuery("delete from public.responder_command_receipts", [])).rejects.toMatchObject({ code: "42501" });
});
it.each(["accept", "modify", "reject", "annotate"] as const)("commits and reads back original %s action/audit evidence through both readers", async action => {
  const f = await fixture(), command = { ...f.input, action, ...(action === "modify" ? { modifiedPriority: "Medium" as const } : {}) };
  const result = await recordSupabaseAction(command); expect(result).not.toBeNull();
  for (const lane of ["actions", "audit"] as const) {
    const page = await readHistoryPage({ incidentId: f.incidentId, lane, limit: "25", commandId: command.commandId }, user);
    expect(page.entries).toHaveLength(1); expect(page.nextCursor).toBeNull();
    const saved = await readHistoryRecord({ incidentId: f.incidentId, lane, recordId: page.entries[0].id }, user);
    expect(saved.record.actorId).toBe(user.id);
    if (lane === "actions") expect(saved.record.details).toMatchObject({ action, note: command.note, recommendationSnapshot: result!.recommendationSnapshot });
    else {
      // The action row carries domainActionId; the audit preserves the canonical snapshot without that transport field.
      expect(saved.record.details.payload).toEqual(result!.auditEvent.payload);
      expect(saved.record.details.payload).toMatchObject({ action, note: command.note, expectedRevision: command.expectedRevision });
    }
  }
  expect(await counts(f.payload.incident.id)).toEqual({ actions: 1, audit: 1, receipts: 1 });
});
it("replays the exact committed receipt after refresh/retirement without duplicating history", async () => {
  const f = await fixture(), original = await recordSupabaseAction(f.input);
  await q("update public.incidents set selected_fire=jsonb_set(jsonb_set(selected_fire,'{inventoryManifest,revision}',to_jsonb($2::text)),'{inventoryManifest,recommendationIds}','[]') where id=$1", [f.payload.incident.id, randomUUID()]);
  const before = requests.length; expect(await recordSupabaseAction(f.input)).toEqual(original);
  expect(requests.slice(before).some(url => /\/(assets|source_snapshots)$/.test(url.pathname))).toBe(false);
  await expect(recordSupabaseAction({ ...f.input, note: "Changed uncertain command" })).rejects.toMatchObject({ code: "FA408" });
  expect(await counts(f.payload.incident.id)).toEqual({ actions: 1, audit: 1, receipts: 1 });
  expect((await readHistoryPage({ incidentId: f.incidentId, lane: "actions", limit: "25" }, user)).entries).toHaveLength(1);
});
it("rolls back action, audit and receipt together when the second insert fails", async () => {
  const f = await fixture();
  await db.exec("alter table public.audit_events add constraint local_history_failure check (summary <> 'forced late failure')");
  await db.exec(`create function public.local_history_failure() returns trigger language plpgsql as $$ begin new.summary := 'forced late failure'; return new; end $$;
    create trigger local_history_failure before insert on public.audit_events for each row execute function public.local_history_failure();`);
  try {
    await expect(recordSupabaseAction(f.input)).rejects.toMatchObject({ code: "FA422" });
    expect(await counts(f.payload.incident.id)).toEqual({ actions: 0, audit: 0, receipts: 0 });
  } finally { await db.exec("drop trigger local_history_failure on public.audit_events; drop function public.local_history_failure(); alter table public.audit_events drop constraint local_history_failure"); }
  expect(await recordSupabaseAction(f.input)).not.toBeNull();
  expect(await counts(f.payload.incident.id)).toEqual({ actions: 1, audit: 1, receipts: 1 });
});
it.each(["role", "revision"])("SQL rejects a late %s change after application context validation", async kind => {
  const f = await fixture();
  beforeCommit = async () => {
    if (kind === "role") await q("update public.organization_members set role='viewer' where user_id=$1", [user.id]);
    else await q("update public.incidents set selected_fire=jsonb_set(selected_fire,'{inventoryManifest,revision}',to_jsonb($2::text)) where id=$1", [f.payload.incident.id, randomUUID()]);
  };
  await expect(recordSupabaseAction(f.input)).rejects.toMatchObject({ code: kind === "role" ? "FA401" : "FA409" });
  expect(await counts(f.payload.incident.id)).toEqual({ actions: 0, audit: 0, receipts: 0 });
});
it.each(["actions", "audit"] as const)("pages exact SQL %s positions under a two-row cap without cross-incident records", async (lane: z.infer<typeof HistoryLaneSchema>) => {
  const f = await fixture(), other = await fixture();
  for (let i = 0; i < 5; i++) await recordSupabaseAction({ ...f.input, commandId: randomUUID() });
  await recordSupabaseAction(other.input);
  const table = lane === "actions" ? "responder_actions" : "audit_events";
  const from = lane === "actions" ? "from public.responder_actions t join public.recommendations r on r.id=t.recommendation_id where r.incident_id=$1" : "from public.audit_events t where t.incident_id=$1";
  const expected = (await q(`select t.id::text value ${from} order by t.created_at desc,t.id desc`, [f.payload.incident.id])).rows.map(row => row.value);
  const seen: string[] = []; let cursor: string | undefined;
  do { const page = await readHistoryPage({ incidentId: f.incidentId, lane, limit: "25", cursor }, user);
    expect(page.entries.every(row => row.createdAt.endsWith(seen.length === 0 ? "-05:00" : "+05:30"))).toBe(true);
    seen.push(...page.entries.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    await db.exec("set timezone='Asia/Kolkata'");
  } while (cursor && seen.length < 10);
  expect(seen).toEqual(expected); expect(seen).toHaveLength(5);
  expect(requests.filter(url => url.pathname.endsWith(`/${table}`)).every(url => url.searchParams.get("limit") === "25")).toBe(true);
});
