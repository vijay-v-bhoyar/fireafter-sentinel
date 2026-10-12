import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("builds the concurrent page index on populated rows, replays and removes/rebuilds it without data loss", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table public.ingestion_staged_rows(
      job_id uuid not null,kind text not null,row_id integer not null,page_position integer,payload jsonb,
      primary key(job_id,kind,row_id));
      insert into public.ingestion_staged_rows
        select '10000000-0000-4000-8000-000000000001',kind,n,
          case when n%7=0 then null else ((n-1)/128)*128 end,
          jsonb_build_object('id',n,'evidence',array[n,0], 'unknown',null)
        from generate_series(1,513) n,unnest(array['asset','recommendation']) kind;`);
    const readRows = async () => (await db.query("select * from public.ingestion_staged_rows order by kind,row_id")).rows;
    const before = await readRows();
    const migration = await readFile(new URL("../../supabase/migrations/20261008140000_staged_page_lookup.sql", import.meta.url), "utf8");
    await db.exec("begin");
    await expect(db.exec(migration)).rejects.toThrow(/cannot run inside a transaction block/);
    await db.exec("rollback");
    await db.exec("set lock_timeout='2s'");
    await db.exec("set statement_timeout='60s'");
    const index = async () => (await db.query(`select i.indisvalid,i.indisready,i.indislive,
      pg_get_indexdef(i.indexrelid) as definition from pg_index i
      where i.indexrelid=to_regclass('public.ingestion_staged_rows_page_idx')`)).rows;
    await db.exec(migration);
    const created = await index();
    expect(created).toEqual([{ indisvalid: true, indisready: true, indislive: true,
      definition: "CREATE INDEX ingestion_staged_rows_page_idx ON public.ingestion_staged_rows USING btree (job_id, kind, page_position)" }]);
    expect(await readRows()).toEqual(before);
    await db.exec(migration);
    expect(await index()).toEqual(created);
    expect(await readRows()).toEqual(before);
    await db.exec("drop index concurrently public.ingestion_staged_rows_page_idx");
    expect(await index()).toEqual([]);
    expect(await readRows()).toEqual(before);
    await db.exec(migration);
    expect(await index()).toEqual(created);
    expect(await readRows()).toEqual(before);
  } finally { await db.close(); }
}, 30000);
