import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { FireAfterSupabasePayload } from "../lib/fireafter-supabase";

export async function compactRefreshSqlFixture() {
  const db = new PGlite();
  const migration = (name: string) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;`);
  // Preserve non-spatial constraints and grants; PGlite cannot execute PostGIS.
  const schema = (await migration("0001_fireafter_schema"))
    .replace("create extension if not exists postgis with schema extensions;", "")
    .replace("geom extensions.geography(point, 4326)", "geom jsonb")
    .replace("create index if not exists assets_geom_idx on public.assets using gist (geom);", "");
  await db.exec(schema);
  await db.exec(await migration("20260627180530_reality_upgrade"));
  await db.exec(`begin; ${await migration("20261008190000_compact_refresh_reads")}; commit;`);
  const load = async (payload: FireAfterSupabasePayload) => {
    await db.query("insert into public.organizations(id,name) values ($1,'Local read fixture') on conflict do nothing", [payload.incident.organization_id]);
    await db.query("insert into public.incidents select * from jsonb_populate_record(null::public.incidents,$1)",
      [JSON.stringify({ created_at: "2026-10-08T12:00:00Z", ...payload.incident })]);
    for (const [table, rows] of [["assets", payload.assets], ["recommendations", payload.recommendations]] as const) {
      // Populate explicit defaults absent from the app's insert payload.
      for (let offset = 0; offset < rows.length; offset += 500) {
        const values = rows.slice(offset, offset + 500).map(row => ({ created_at: "2026-10-08T12:00:00Z", ...row }));
        await db.query(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table},$1)`, [JSON.stringify(values)]);
      }
    }
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (name === "fireafter_refresh_read_security_version") {
      return (await db.query<{ result: string | null }>("select public.fireafter_refresh_read_security_version() as result")).rows[0].result;
    }
    if (name !== "fireafter_read_refresh_recommendations") throw new Error("Unexpected local RPC");
    return (await db.query<{ result: unknown }>("select public.fireafter_read_refresh_recommendations($1,$2,$3,$4) as result",
      [args.p_incident_id, args.p_organization_id, args.p_after, args.p_limit])).rows[0].result;
  };
  return { db, load, rpc, close: () => db.close() };
}
