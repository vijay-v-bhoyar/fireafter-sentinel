import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { readRecentIncidentActions } from "./recent-actions";

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("./supabase", () => ({ getSupabaseAdminClient: mocks.client }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("reads the exact recent window from production-table joins without enumerating 91511 recommendation IDs", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$ select null::uuid $$;`);
    const schema = (await readFile(new URL("../../supabase/migrations/0001_fireafter_schema.sql", import.meta.url), "utf8"))
      .replace("create extension if not exists postgis with schema extensions;", "")
      .replace("geom extensions.geography(point, 4326)", "geom jsonb")
      .replace("create index if not exists assets_geom_idx on public.assets using gist (geom);", "");
    await db.exec(schema);
    await db.query("insert into public.organizations(id,name) values($1,'Local SQL fixture')", [id(900001)]);
    for (const incident of [900002, 900003]) {
      await db.query(`insert into public.incidents(id,organization_id,county,state,title,status,storm_window)
        values($1,$2,'Fixture county','CA','Read test','Storm Watch','test')`, [id(incident), id(900001)]);
      await db.query(`insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence)
        values($1,$2,'Fixture crossing','Bridge','Fixture','Fixture','Low')`, [id(incident + 10), id(incident)]);
    }
    await db.query(`insert into public.recommendations(id,incident_id,asset_id,final_score,score_100,risk_level,
      confidence_level,recommended_action,changed_since_last_refresh,score_breakdown)
      select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,$2,0,0,'Unknown','Low','Review','Fixture','{}'
      from generate_series(1,91511) n`, [id(900002), id(900012)]);
    await db.query(`insert into public.recommendations(id,incident_id,asset_id,final_score,score_100,risk_level,
      confidence_level,recommended_action,changed_since_last_refresh,score_breakdown)
      values($1,$2,$3,0,0,'Unknown','Low','Review','Fixture','{}')`, [id(920001), id(900003), id(900013)]);
    await db.exec(`insert into public.responder_actions(id,recommendation_id,action,note,actor_name,recommendation_snapshot,created_at)
      select ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        ('10000000-0000-4000-8000-'||lpad((n*300)::text,12,'0'))::uuid,
        'annotate','Original note '||n,'Reviewer',jsonb_build_object('id','retired-'||n,'evidence',jsonb_build_array(n,null)),
        '2026-10-08T00:00:00Z'::timestamptz + (n/2)*interval '1 microsecond'
      from generate_series(1,251) n;`);
    await db.query(`insert into public.responder_actions(recommendation_id,action,actor_name,recommendation_snapshot,created_at)
      values($1,'annotate','Foreign reviewer','{}','2026-10-09T00:00:00Z')`, [id(920001)]);

    let calls = 0;
    // A bounded local translation of the real SDK query into SQL. Not a PostgREST server or RLS proof.
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input)); calls++;
      expect(url.pathname).toBe("/rest/v1/responder_actions");
      expect(url.searchParams.get("select")).toBe("*,recommendations!inner(incident_id)");
      expect(url.searchParams.get("recommendations.incident_id")).toBe(`eq.${id(900002)}`);
      expect(url.searchParams.get("order")).toBe("created_at.desc,id.asc");
      const params: unknown[] = [id(900002)];
      let condition = "r.incident_id=$1";
      const cursor = url.searchParams.get("or");
      if (cursor) {
        const match = cursor.match(/^\(created_at.lt.(.+),and\(created_at.eq.(.+),id.gt.([a-f0-9-]+)\)\)$/)!;
        expect(match).toBeTruthy(); expect(match[1]).toBe(match[2]);
        params.push(match[1], match[3]);
        condition += " and (a.created_at<$2::timestamptz or (a.created_at=$2::timestamptz and a.id>$3::uuid))";
      }
      const from = `from public.responder_actions a join public.recommendations r on r.id=a.recommendation_id where ${condition}`;
      const count = (await db.query<{ n: number }>(`select count(*)::int n ${from}`, params)).rows[0].n;
      params.push(Math.min(7, Number(url.searchParams.get("limit"))));
      const rows = (await db.query<{ value: unknown }>(`select to_jsonb(a)||jsonb_build_object('recommendations',jsonb_build_object('incident_id',r.incident_id)) value
        ${from} order by a.created_at desc,a.id asc limit $${params.length}`, params)).rows.map(row => row.value);
      return Response.json(rows, { headers: { "content-range": `0-${Math.max(0, rows.length - 1)}/${count}` } });
    };
    mocks.client.mockReturnValue(createClient("https://local-sql-fixture.invalid", "local-only", { auth: { persistSession: false }, global: { fetch: fetcher } }));
    const actual = await readRecentIncidentActions(id(900002));
    const expected = (await db.query<{ value: unknown }>(`select to_jsonb(a) value from public.responder_actions a
      join public.recommendations r on r.id=a.recommendation_id where r.incident_id=$1
      order by a.created_at desc,a.id asc limit 200`, [id(900002)])).rows.map(row => row.value);
    expect(actual).toEqual(expected); expect(actual).toHaveLength(200); expect(calls).toBe(29);
    expect((await db.query<{ n: number }>("select count(*)::int n from public.recommendations")).rows[0].n).toBe(91512);
  } finally { mocks.client.mockReset(); await db.close(); }
}, 30000);
