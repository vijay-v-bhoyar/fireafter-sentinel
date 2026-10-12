import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { prepareIngestionPayload } from "./ingestion-payload";
import { buildStagedHeader, STAGED_COMMIT_SECURITY_VERSION } from "./ingestion-staged";
import { prepareIngestionPages, PREPARATION_STATE, preparedCounts, readPreparedTransferRows, type PreparedPlan } from "./ingestion-preparation";
import { prepareLiveRecommendationContext } from "./live-sources";
import { jsonbTextBytes } from "./ingestion-jsonb-size";
import { encodeStagedRows, SHARED_ROW_ENCODING } from "./ingestion-row-page";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import type { Asset, Recommendation, SourceSnapshot } from "./types";
import { SOURCE_LINE_GEOMETRY_VERSION } from "./source-line-geometry";
import { SOURCE_SPATIAL_ENCODING } from "./source-spatial-storage";
import { unpackSourcePayload } from "./source-payload-storage";
import { parseInventoryManifest } from "./inventory-manifest";
import { MAP_VIEW_VERSION } from "./map-viewport-contract";
import { encodeCheckpoint } from "./ingestion-checkpoint";

let db: PGlite;
const actor = randomUUID(), org = randomUUID(), job = randomUUID(), lease = randomUUID();
const q = (sql: string, args: unknown[] = []) => db.query(sql, args);
const migration = async (name: string) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;`);
  // PGlite has no PostGIS. Keep every non-spatial production table constraint;
  // neither staged publication nor the existing helper writes the geom column.
  const schema = (await migration("0001_fireafter_schema"))
    .replace("create extension if not exists postgis with schema extensions;", "")
    .replace("geom extensions.geography(point, 4326)", "geom jsonb")
    .replace("create index if not exists assets_geom_idx on public.assets using gist (geom);", "");
  await db.exec(schema);
  await db.exec(await migration("20260627180530_reality_upgrade"));
  await db.exec(await migration("20260910120000_atomic_bundle_persistence"));
  const fence = await migration("20260914034000_bundle_write_fencing");
  await db.exec(fence.split("create or replace function public.fireafter_bundle_persistence_security_version")[0]);
  await db.exec("alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) set statement_timeout='30s'");
  await db.exec(await migration("20261007120000_durable_ingestion"));
  await db.exec(await migration("20261008111654_staged_ingestion_rows"));
  await db.exec(await migration("20261008133000_shared_staging_fields"));
  // A concurrent index build must be its own command, outside a transaction.
  await db.exec(await migration("20261008140000_staged_page_lookup"));
  await db.exec(await migration("20261008140100_staged_page_lookup_attestation"));
  await db.exec(`begin; ${await migration("20261008230000_asset_viewport")}; commit;`);
  await db.exec(`begin; ${await migration("20261009003000_source_viewport")}; commit;`);
  await q("insert into auth.users values($1)", [actor]);
  await q("insert into public.organizations(id,name) values($1,'Canonical test organization')", [org]);
  await q("insert into public.organization_members(organization_id,user_id,role) values($1,$2,'analyst')", [org, actor]);
}, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "false"); await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); vi.unstubAllEnvs(); });

function fixture(count = 300, options: { jobId?: string; expectedRevision?: string; incidentId?: string; name?: string; spatialSource?: boolean } = {}) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const assets: Asset[] = Array.from({ length: count }, (_, index) => ({ id: `staging-asset-${index}`, incidentId: incident.id,
    name: `${options.name ?? "Synthetic bridge"} ${index}`, type: "Bridge", locationLabel: "Local test only", coordinates: [-118.2, 34.2],
    source: "Test fixture", confidence: "Low", localOrUploaded: false, origin: "source" }));
  const recommendations = assets.map(asset => ({ id: `review-${asset.id}`, incidentId: incident.id,
    assetId: asset.id, assetName: asset.name, assetType: asset.type, locationLabel: asset.locationLabel, coordinates: asset.coordinates,
    recommendedAction: "Review missing evidence", riskLevel: "Unknown", finalScore: 0, score100: 0, confidenceLevel: "Low",
    reasonCodes: [], limitations: ["Test fixture"], changedSinceLastRefresh: "New", sourcesUpdatedLabel: "Unknown", dataFreshnessHours: 0,
    scoreBreakdown: { rainfallThreat: 0, burnSeverity: 0, slopeTerrain: 0, downstreamExposure: 0, dataFreshness: 0, confidenceMultiplier: 0, baseScore: 0, finalScore: 0 },
    createdAt: "2026-10-08T11:00:00Z" }) as Recommendation);
  const sourceSnapshots: SourceSnapshot[] = options.spatialSource ? [{ id: "source-roads", incidentId: incident.id, sourceKey: "tiger-roads",
    sourceName: "Census TIGERweb", sourceUrl: "https://tigerweb.geo.census.gov/", fetchedAt: "2026-10-08T11:00:00Z", sourceUpdatedAt: "2026-10-01T00:00:00Z",
    status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Saved data", detail: "Complete roads",
    rawPayload: { z: "retained metadata", geometryVersion: SOURCE_LINE_GEOMETRY_VERSION, featureCount: 1, inventoryComplete: true,
      features: [{ id: "road-a", name: options.name ?? "Original road", sourceKey: "tiger-roads", sourceName: "Census TIGERweb",
        paths: [[[-118.2, 34.2], [-118.1, 34.3]], [[-118, 34.1], [-117.9, 34.2]]] }], a: "retained metadata" } }] : [];
  const payload = prepareIngestionPayload(options.jobId ?? job, "final", { incident, assets, recommendations, sourceSnapshots },
    { actorId: actor, organizationId: org, expectedRevision: options.expectedRevision ?? null,
      databaseIncidentId: options.incidentId, operation: options.expectedRevision ? "refresh" : "create" });
  const header = buildStagedHeader(payload);
  return { ...payload, header };
}
type Fixture = ReturnType<typeof fixture>;
async function enqueue(f: Pick<Fixture, "incident">) {
  await q("select public.fireafter_enqueue_ingestion($1,$2,$3,$4,'create','{}')", [job, actor, org, f.incident.selected_fire.domainIncidentId]);
  await q("select public.fireafter_claim_ingestion($1,$2)", [job, lease]);
  await q("update public.ingestion_jobs set stage='prepare:final' where id=$1", [job]);
}
const begin = (header: unknown, currentLease = lease) => q("select public.fireafter_begin_staged_ingestion($1,$2,$3) as counts", [job, currentLease, JSON.stringify(header)]);
const stage = (kind: string, position: number, rows: unknown, currentLease = lease) => q("select public.fireafter_stage_ingestion_rows($1,$2,$3,$4,$5) as counts", [job, currentLease, kind, position, JSON.stringify(rows)]);
async function stageAll(f: Fixture) {
  await begin(f.header);
  for (let i = 0; i < f.assets.length; i += 256) await stage("asset", i, f.assets.slice(i, i + 256));
  for (let i = 0; i < f.recommendations.length; i += 256) await stage("recommendation", i, f.recommendations.slice(i, i + 256));
  for (let i = 0; i < f.sourceSnapshots.length; i += 256) await stage("source", i, f.sourceSnapshots.slice(i, i + 256));
  await q("update public.ingestion_jobs set stage='commit:final' where id=$1", [job]);
}
const commit = () => q("select public.fireafter_commit_staged_ingestion($1,$2) as id", [job, lease]);
async function preparePublication(f: Fixture, id: string, token: string, mode: "atomic" | "staged") {
  await q("select public.fireafter_enqueue_ingestion($1,$2,$3,$4,$5,$6)", [id, actor, org,
    f.incident.selected_fire.domainIncidentId, f.write.operation,
    JSON.stringify(f.write.operation === "create" ? {} : { targetId: f.incident.id })]);
  await q("select public.fireafter_claim_ingestion($1,$2)", [id, token]);
  await q("update public.ingestion_jobs set stage='prepare:final' where id=$1", [id]);
  if (mode === "staged") {
    await q("select public.fireafter_begin_staged_ingestion($1,$2,$3)", [id, token, JSON.stringify(f.header)]);
    for (const [kind, rows] of [["asset", f.assets], ["recommendation", f.recommendations], ["source", f.sourceSnapshots]] as const) {
      for (let offset = 0; offset < rows.length; offset += 128) {
        await q("select public.fireafter_stage_ingestion_rows($1,$2,$3,$4,$5)",
          [id, token, kind, offset, JSON.stringify(encodeStagedRows(rows.slice(offset, offset + 128), SHARED_ROW_ENCODING))]);
      }
    }
  } else {
    const encoded = encodeCheckpoint(f, false);
    for (const [part, value] of encoded.parts.entries()) {
      await q("select public.fireafter_checkpoint_ingestion($1,$2,'commit:final',$3,$4)", [id, token, part, JSON.stringify(value)]);
    }
    await q("select public.fireafter_checkpoint_ingestion($1,$2,'commit:final',-1,$3)", [id, token, JSON.stringify(encoded.manifest)]);
  }
  await q("update public.ingestion_jobs set stage='commit:final' where id=$1", [id]);
  return () => q(mode === "staged" ? "select public.fireafter_commit_staged_ingestion($1,$2) as id"
    : "select public.fireafter_commit_ingestion($1,$2,'final') as id", [id, token]);
}
const finishPublication = (id: string, token: string) => q("select public.fireafter_advance_ingestion($1,$2,'done','{}',null)", [id, token]);
const revisionOf = (f: Pick<Fixture, "incident">) => parseInventoryManifest(f.incident.selected_fire.inventoryManifest)!.revision;
async function mapOf(f: Pick<Fixture, "incident">) {
  return (await q("select public.fireafter_read_asset_viewport($1,$2,$3,'analyst',$4,array[-119,33,-117,35]::float8[],0) as value",
    [f.incident.selected_fire.domainIncidentId, actor, org, revisionOf(f)])).rows[0] as { value: unknown };
}
async function operationalSnapshot(includeIndex = true) {
  const result: Record<string, unknown> = {};
  for (const table of ["incidents", "assets", "recommendations", "source_snapshots", "audit_events", "ingestion_commit_receipts",
    ...(includeIndex ? ["asset_map_points", "source_map_layers", "source_map_chunks"] : [])]) {
    result[table] = (await q(`select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)::text`)).rows;
  }
  return result;
}
it.each(["atomic", "staged"] as const)("keeps the old map on late %s publication failure and replaces it exactly once on recovery", async mode => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "true");
  const old = fixture(3, { spatialSource: true }), publishOld = await preparePublication(old, job, lease, mode);
  await publishOld(); await finishPublication(job, lease);
  expect(old.sourceSnapshots[0].raw_payload.rawPayloadEncoding).toBe(SOURCE_SPATIAL_ENCODING);
  const readSource = async () => ((await q("select raw_payload from public.source_snapshots where id=$1", [old.sourceSnapshots[0].id])).rows[0] as { raw_payload: Record<string, unknown> }).raw_payload;
  expect(unpackSourcePayload(await readSource())).toEqual(unpackSourcePayload(old.sourceSnapshots[0].raw_payload));
  expect((await mapOf(old)).value).toMatchObject({ totalStored: 3, totalLocated: 3, inView: 3 });
  const before = await operationalSnapshot(), nextJob = randomUUID(), nextLease = randomUUID();
  const next = fixture(2, { jobId: nextJob, expectedRevision: revisionOf(old), incidentId: old.incident.id, name: "Updated bridge", spatialSource: true });
  const publishNext = await preparePublication(next, nextJob, nextLease, mode);
  expect(await operationalSnapshot()).toEqual(before);
  // Both publication paths write their recovery receipt after all operational rows.
  await db.exec(`create function public.test_map_late_failure() returns trigger language plpgsql as $$ begin
    if (select count(*) from public.asset_map_points p join public.incidents i on i.id=p.incident_id
      where p.revision=(i.selected_fire->'inventoryManifest'->>'revision')::uuid)<>2 then
      raise exception 'TEST_INDEX_NOT_WRITTEN';
    end if;
    if (select count(*) from public.source_map_chunks c join public.source_map_layers l on l.source_id=c.source_id
      join public.incidents i on i.id=l.incident_id where l.revision=(i.selected_fire->'inventoryManifest'->>'revision')::uuid)<>1 then
      raise exception 'TEST_SOURCE_INDEX_NOT_WRITTEN';
    end if;
    raise exception 'TEST_MAP_LATE_FAILURE';
  end $$;
  create trigger test_map_late_failure before insert on public.ingestion_commit_receipts for each row execute function public.test_map_late_failure();`);
  await rejectAndRecover(publishNext, /TEST_MAP_LATE_FAILURE/);
  expect(await operationalSnapshot()).toEqual(before);
  expect((await mapOf(old)).value).toMatchObject({ totalStored: 3, inView: 3 });
  expect(unpackSourcePayload(await readSource())).toEqual(unpackSourcePayload(old.sourceSnapshots[0].raw_payload));
  await db.exec("drop trigger test_map_late_failure on public.ingestion_commit_receipts; drop function public.test_map_late_failure()");
  expect((await publishNext()).rows).toEqual([{ id: next.incident.id }]);
  const after = await operationalSnapshot();
  expect((await publishNext()).rows).toEqual([{ id: next.incident.id }]);
  expect(await operationalSnapshot()).toEqual(after);
  expect(unpackSourcePayload(await readSource())).toEqual(unpackSourcePayload(next.sourceSnapshots[0].raw_payload));
  expect((await mapOf(next)).value).toMatchObject({ totalStored: 2, totalLocated: 2, inView: 2 });
  await rejectAndRecover(() => mapOf(old), /Map publication changed/);
  expect((await q("select count(*)::int as n from public.asset_map_points where revision=$1", [revisionOf(next)])).rows).toEqual([{ n: 2 }]);
  expect((await q("select count(*)::int as n from public.ingestion_commit_receipts where job_id=$1", [nextJob])).rows).toEqual([{ n: 1 }]);
});
it("removes and reapplies only the map sidecar without changing operational records, then rebuilds on a new publication", async () => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "true");
  const old = fixture(3), publish = await preparePublication(old, job, lease, "staged");
  await publish(); await finishPublication(job, lease);
  const before = await operationalSnapshot(false);
  await db.exec(`drop trigger fireafter_asset_point_index on public.assets;
    drop function public.fireafter_index_asset_point();
    drop function public.fireafter_read_asset_viewport(text,uuid,uuid,text,uuid,double precision[],integer);
    drop table public.asset_map_points;`);
  expect(await operationalSnapshot(false)).toEqual(before);
  await db.exec(await migration("20261008230000_asset_viewport"));
  expect(await operationalSnapshot(false)).toEqual(before);
  expect((await q("select count(*)::int as n from public.asset_map_points")).rows).toEqual([{ n: 0 }]);
  await rejectAndRecover(() => mapOf(old), /Incomplete map index/);
  const nextJob = randomUUID(), nextLease = randomUUID();
  const next = fixture(3, { jobId: nextJob, expectedRevision: revisionOf(old), incidentId: old.incident.id });
  await (await preparePublication(next, nextJob, nextLease, "staged"))();
  expect((await mapOf(next)).value).toMatchObject({ totalStored: 3, totalLocated: 3, inView: 3 });
  expect((await q("select count(*)::int as n from public.audit_events")).rows).toEqual([{ n: 3 }]);
});
it("matches PostgreSQL JSONB text accounting for nested, escaped, Unicode and exponent values", async () => {
  const samples = [null, true, 0, -0, 1e-7, -1.234e-12, 1e21, -1.23e25, Number.MIN_VALUE, Number.MAX_VALUE,
    { text: 'Quoted " value: comma, backslash \\ and \n\t control', unicode: "\u00e9\u4e2d\ud83d\ude42", values: [false, null, {}, [], 1e-9, 3e30] },
    fixture(2).assets, fixture(2).recommendations];
  for (const sample of samples) {
    const serialized = JSON.stringify(sample);
    const actual = (await q("select octet_length($1::jsonb::text) as size", [serialized])).rows[0] as { size: number };
    expect(jsonbTextBytes(serialized)).toBe(actual.size);
  }
});
it("attests exact production bodies, settings, owners, private tables and effective grants", async () => {
  expect((await q("select public.fireafter_staged_ingestion_security_version() as version")).rows).toEqual([{ version: STAGED_COMMIT_SECURITY_VERSION }]);
  await db.exec("grant select on public.ingestion_staged_rows to authenticated");
  expect((await q("select public.fireafter_staged_ingestion_security_version() as version")).rows).toEqual([{ version: null }]);
});
it("detects function body, timeout and RLS drift", async () => {
  for (const change of [
    "alter function public.fireafter_stage_ingestion_rows(uuid,uuid,text,integer,jsonb) set statement_timeout='0'",
    "alter table public.ingestion_staged_pages disable row level security",
    "alter table public.ingestion_staged_rows drop constraint ingestion_staged_row_page_fk",
    "alter table public.ingestion_staged_pages alter column common_fields drop not null",
    "alter table public.ingestion_staged_pages drop constraint ingestion_staged_common_fields_check",
    "drop index public.ingestion_staged_rows_page_idx",
    "create or replace function public.fireafter_commit_staged_ingestion(p_id uuid,p_lease uuid) returns uuid language plpgsql security definer set search_path='' as $$ begin return p_id; end $$",
  ]) {
    await db.exec("savepoint catalog_change");
    await db.exec(change);
    expect((await q("select public.fireafter_staged_ingestion_security_version() as version")).rows).toEqual([{ version: null }]);
    await db.exec("rollback to savepoint catalog_change");
  }
});
it.each(["wrong_order", "partial", "invalid", "not_ready"])("refuses the staged gate for a same-name %s index", async defect => {
  if (defect === "invalid" || defect === "not_ready") {
    await db.exec(`update pg_index set ${defect === "invalid" ? "indisvalid" : "indisready"}=false
      where indexrelid='public.ingestion_staged_rows_page_idx'::regclass`);
  } else {
    await db.exec("drop index public.ingestion_staged_rows_page_idx");
    await db.exec(defect === "wrong_order"
      ? "create index ingestion_staged_rows_page_idx on public.ingestion_staged_rows(kind,job_id,page_position)"
      : "create index ingestion_staged_rows_page_idx on public.ingestion_staged_rows(job_id,kind,page_position) where kind='asset'");
  }
  expect((await q("select public.fireafter_staged_ingestion_security_version() as version")).rows).toEqual([{ version: null }]);
});
it("stores shared fields once and reconstructs every original database field exactly at commit", async () => {
  const f = fixture(300);
  await db.exec("savepoint before_publication");
  await enqueue(f); await stageAll(f); await commit();
  const snapshots = new Map<string, unknown>();
  for (const table of ["incidents", "assets", "recommendations", "audit_events"]) {
    snapshots.set(table, (await q(`select to_jsonb(t) as row from public.${table} t order by id`)).rows);
  }
  await db.exec("rollback to savepoint before_publication");
  await enqueue(f); await begin(f.header);
  let encodedBytes = 0, originalBytes = 0;
  for (const [kind, all] of [["asset", f.assets], ["recommendation", f.recommendations]] as const) {
    for (let offset = 0; offset < all.length; offset += 128) {
      const rows = all.slice(offset, offset + 128), encoded = encodeStagedRows(rows, SHARED_ROW_ENCODING);
      expect(Array.isArray(encoded)).toBe(false);
      encodedBytes += jsonbTextBytes(JSON.stringify(encoded)); originalBytes += jsonbTextBytes(JSON.stringify(rows));
      const result = await stage(kind, offset, encoded);
      expect((await stage(kind, offset, encoded)).rows).toEqual(result.rows);
    }
  }
  expect(encodedBytes).toBeLessThan(originalBytes);
  expect((await q("select stored_bytes::int as n from public.ingestion_staged_bundles")).rows).toEqual([{ n: encodedBytes }]);
  expect((await q("select count(*)::int as n from public.ingestion_staged_rows where payload ? 'recommended_action'")).rows).toEqual([{ n: 0 }]);
  await q("update public.ingestion_jobs set stage='commit:final' where id=$1", [job]); await commit();
  for (const [table, expected] of snapshots) expect((await q(`select to_jsonb(t) as row from public.${table} t order by id`)).rows).toEqual(expected);
});
it.each(["identity", "shadow", "format", "extra", "expansion"])("rejects invalid shared %s without changing page counts", async defect => {
  const f = fixture(128); await enqueue(f); await begin(f.header);
  const encoded = encodeStagedRows(f.assets, SHARED_ROW_ENCODING);
  if (Array.isArray(encoded)) throw new Error("expected shared fields");
  if (defect === "identity") encoded.shared.incident_id = f.incident.id;
  if (defect === "shadow") encoded.rows[0].name = "shadow";
  if (defect === "shadow") encoded.shared.name = "shared";
  if (defect === "format") encoded.format = "unknown" as never;
  if (defect === "extra") Object.assign(encoded, { ignored: true });
  if (defect === "expansion") encoded.shared.big = "x".repeat(300_000);
  await rejectAndRecover(() => stage("asset", 0, encoded), /shared|Expanded|Invalid/);
  expect((await begin(f.header)).rows).toEqual([{ counts: { asset: 0, recommendation: 0, source: 0 } }]);
  expect((await q("select count(*)::int as n from public.ingestion_staged_pages")).rows).toEqual([{ n: 0 }]);
});
it("rolls back a late invalid shared field without publishing incident, children, audit or receipt", async () => {
  const f = fixture(2); await enqueue(f); await begin(f.header);
  await stage("asset", 0, encodeStagedRows(f.assets, SHARED_ROW_ENCODING));
  const encoded = encodeStagedRows(f.recommendations, SHARED_ROW_ENCODING);
  if (Array.isArray(encoded)) throw new Error("expected shared fields");
  encoded.shared.recommended_action = null;
  await stage("recommendation", 0, encoded);
  await q("update public.ingestion_jobs set stage='commit:final' where id=$1", [job]);
  await rejectAndRecover(commit, /Invalid staged fields/);
  for (const table of ["incidents", "assets", "recommendations", "audit_events", "ingestion_commit_receipts"]) {
    expect((await q(`select count(*)::int as n from public.${table}`)).rows).toEqual([{ n: 0 }]);
  }
});
it("upgrades an in-flight legacy job, rolls the migration back without row loss, and reapplies before mixed-format publication", async () => {
  expect((await q("select count(*)::int as n from public.ingestion_staged_rows")).rows).toEqual([{ n: 0 }]);
  await db.exec(`alter table public.ingestion_staged_rows drop constraint ingestion_staged_row_page_fk;
    alter table public.ingestion_staged_pages drop constraint ingestion_staged_common_fields_check;
    alter table public.ingestion_staged_rows drop column page_position;
    alter table public.ingestion_staged_pages drop column common_fields;`);
  const old = await migration("20261008111654_staged_ingestion_rows");
  for (const name of ["fireafter_stage_ingestion_rows", "fireafter_commit_staged_ingestion", "fireafter_staged_ingestion_security_version"]) {
    const start = old.indexOf(`create function public.${name}(`), body = old.indexOf("as $$", start), end = old.indexOf("$$;", body + 5);
    await db.exec(old.slice(start, end + 3).replace("create function", "create or replace function"));
  }
  const f = fixture(259); await enqueue(f); await begin(f.header); await stage("asset", 0, f.assets.slice(0, 128));
  const before = (await q("select kind,row_id,payload from public.ingestion_staged_rows order by kind,row_id")).rows;
  await db.exec("savepoint pre_upgrade");
  await db.exec(await migration("20261008133000_shared_staging_fields"));
  expect((await q("select public.fireafter_staged_ingestion_security_version() as version")).rows).toEqual([{ version: "20261008133000" }]);
  expect((await q("select kind,row_id,payload from public.ingestion_staged_rows order by kind,row_id")).rows).toEqual(before);
  await db.exec("rollback to savepoint pre_upgrade");
  expect((await q("select public.fireafter_staged_ingestion_security_version() as version")).rows).toEqual([{ version: "20261008111654" }]);
  expect((await q("select kind,row_id,payload from public.ingestion_staged_rows order by kind,row_id")).rows).toEqual(before);
  await db.exec(await migration("20261008133000_shared_staging_fields"));
  await stage("asset", 128, f.assets.slice(128));
  for (let offset = 0; offset < f.recommendations.length; offset += 128) await stage("recommendation", offset, encodeStagedRows(f.recommendations.slice(offset, offset + 128), SHARED_ROW_ENCODING));
  await q("update public.ingestion_jobs set stage='commit:final' where id=$1", [job]);
  expect((await commit()).rows).toEqual([{ id: f.incident.id }]);
  expect((await q("select count(*)::int as n from public.assets")).rows).toEqual([{ n: 259 }]);
  expect((await q("select count(*)::int as n from public.recommendations")).rows).toEqual([{ n: 259 }]);
});
async function rejectAndRecover(work: () => Promise<unknown>, message: RegExp) {
  await db.exec("savepoint rejected_call");
  await expect(work()).rejects.toThrow(message);
  await db.exec("rollback to savepoint rejected_call");
}
it("uses the real bundle fence and persistence helper, publishes all rows once, and removes successful staging", async () => {
  const f = fixture(); await enqueue(f); await stageAll(f);
  expect((await q("select count(*)::int as n from public.incidents")).rows).toEqual([{ n: 0 }]);
  expect((await commit()).rows).toEqual([{ id: f.incident.id }]);
  expect((await commit()).rows).toEqual([{ id: f.incident.id }]);
  expect((await q("select count(*)::int as n from public.assets")).rows).toEqual([{ n: 300 }]);
  expect((await q("select count(*)::int as n from public.recommendations")).rows).toEqual([{ n: 300 }]);
  expect((await q("select count(*)::int as n from public.audit_events")).rows).toEqual([{ n: 2 }]);
  expect((await q("select selected_fire from public.incidents")).rows).toEqual([{ selected_fire: f.incident.selected_fire }]);
  expect((await q("select count(*)::int as n from public.ingestion_staged_rows")).rows).toEqual([{ n: 0 }]);
  expect((await q("select name from public.organizations")).rows).toEqual([{ name: "Canonical test organization" }]);
});
it.each([false, true])("publishes a resumable plan with viewport enabled=%s through real SQL and retains exact membership on replay", async enabled => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", String(enabled));
  const count = enabled && process.env.FIREAFTER_VIEWPORT_PUBLICATION_CAPACITY === "1" ? 91_511 : 259;
  const started = performance.now();
  const progress = (phase: string) => {
    if (count === 91_511) process.stdout.write(JSON.stringify({ event: "map-publication-capacity", phase, elapsedMs: Math.round(performance.now() - started) }) + "\n");
  };
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const assets: Asset[] = Array.from({ length: count }, (_, index) => ({ id: `prepared-${index}`, incidentId: incident.id,
    name: `Prepared bridge ${index}`, type: "Bridge", locationLabel: "Test stream", coordinates: [-118.2, 34.2],
    source: "Local SQL test fixture", confidence: "Low", localOrUploaded: false, origin: "source" }));
  const checkpoints = new Map<string, unknown>();
  const store = { read: async (key: string) => structuredClone(checkpoints.get(key) ?? null),
    write: async (key: string, value: unknown) => { checkpoints.set(key, structuredClone(value)); } };
  let plan: PreparedPlan | null = null;
  let previousPhase: unknown;
  for (let step = 0; step < 1000 && !plan; step++) {
    plan = await prepareIngestionPages(store, { jobId: job, scope: "sql-test", layout: `${count}-assets`, totalPages: Math.ceil(count / 128),
      readTerrain: async index => ({ assets: assets.slice(index * 128, (index + 1) * 128), batchElevationUnavailable: true }),
      createContext: async (_unavailable, now) => ({ context: prepareLiveRecommendationContext(incident, {}, [], [], now),
        derived: { incident, assets: [], recommendations: [], sourceSnapshots: [] },
        write: { actorId: actor, organizationId: org, expectedRevision: null, operation: "create" } }) });
    const phase = (checkpoints.get(PREPARATION_STATE) as { phase: string }).phase;
    if (phase !== previousPhase) { progress(`prepared:${phase}`); previousPhase = phase; }
  }
  expect(plan).not.toBeNull();
  const ready = plan!;
  await enqueue({ incident: ready.header.incident }); await begin(ready.header);
  for (const kind of ["source", "asset", "recommendation"] as const) {
    let position = 0;
    while (position < preparedCounts(ready)[kind]) {
      const rows = await readPreparedTransferRows(store, ready, kind, position);
      await stage(kind, position, encodeStagedRows(rows, ready.rowEncoding)); position += rows.length;
    }
    progress(`staged:${kind}`);
  }
  expect((await q("select count(*)::int as n from public.incidents")).rows).toEqual([{ n: 0 }]);
  await q("update public.ingestion_jobs set stage='commit:final' where id=$1", [job]);
  const commitStarted = performance.now();
  expect((await commit()).rows).toEqual([{ id: ready.header.incident.id }]);
  const commitMs = Math.round(performance.now() - commitStarted);
  progress("committed");
  expect((await commit()).rows).toEqual([{ id: ready.header.incident.id }]);
  expect((await q("select count(*)::int as n from public.assets")).rows).toEqual([{ n: count }]);
  expect((await q("select count(*)::int as n from public.recommendations where risk_level='Unknown'")).rows).toEqual([{ n: count }]);
  expect((await q("select count(*)::int as n from public.audit_events")).rows).toEqual([{ n: 2 }]);
  expect((await q("select selected_fire from public.incidents")).rows).toEqual([{ selected_fire: JSON.parse(JSON.stringify(ready.header.incident.selected_fire)) }]);
  if (enabled) {
    const revision = parseInventoryManifest(ready.header.incident.selected_fire.inventoryManifest)!.revision;
    expect((await q("select count(*)::int as n from public.asset_map_points where revision=$1", [revision])).rows).toEqual([{ n: count }]);
    const readStarted = performance.now();
    const result = (await q("select public.fireafter_read_asset_viewport($1,$2,$3,'analyst',$4,array[-119,33,-117,35]::float8[],0) as value",
      [incident.id, actor, org, revision])).rows[0] as { value: unknown };
    const readMs = Math.round(performance.now() - readStarted);
    expect(result.value).toMatchObject({ version: MAP_VIEW_VERSION, revision, totalStored: count, totalLocated: count, inView: count });
    if (count === 91_511) {
      await mkdir("output/verification", { recursive: true });
      await writeFile("output/verification/map-publication-capacity-receipt.json", JSON.stringify({
        records: count, preparationPages: ready.pages.asset.length, commitMs, readMs,
        totalMs: Math.round(performance.now() - started), responseBytes: Buffer.byteLength(JSON.stringify(result.value)),
        assertionsCompleted: true, hostedWrites: 0, limitations: "Synthetic, co-located assets; embedded PostgreSQL with unused PostGIS column substituted. The test process must also exit successfully. Not hosted capacity, a restored clone, real sources or concurrent-session proof.",
      }, null, 2));
    }
  } else expect((await q("select count(*)::int as n from public.asset_map_points")).rows).toEqual([{ n: 0 }]);
}, 120_000);
it.each(["anon", "authenticated", "service_role"])("denies direct private staging access to %s", async role => {
  await db.exec(`set local role ${role}`);
  for (const table of ["ingestion_staged_bundles", "ingestion_staged_rows", "ingestion_staged_pages"]) {
    await rejectAndRecover(() => q(`select * from public.${table}`), /permission denied/);
  }
  if (role !== "service_role") await rejectAndRecover(() => begin({}), /permission denied/);
  await rejectAndRecover(() => q("select public.fireafter_staged_job($1,$2)", [job, lease]), /permission denied/);
});
it("accepts service-role RPCs without granting direct table access", async () => {
  const f = fixture(2); await enqueue(f);
  await db.exec("set local role service_role");
  expect((await begin(f.header)).rows).toEqual([{ counts: { asset: 0, recommendation: 0, source: 0 } }]);
  await stage("asset", 0, f.assets);
});
it("reconciles a lost page response and prevents changed or duplicate pages", async () => {
  const f = fixture(); await enqueue(f); await begin(f.header);
  const first = await stage("asset", 0, f.assets.slice(0, 256));
  expect((await stage("asset", 0, f.assets.slice(0, 256))).rows).toEqual(first.rows);
  await rejectAndRecover(() => stage("asset", 0, [{ ...f.assets[0], name: "changed" }]), /page changed/);
  await rejectAndRecover(() => stage("asset", 256, [f.assets[0]]), /already staged/);
  expect((await stage("asset", 256, f.assets.slice(256))).rows).toEqual([{ counts: { asset: 300, recommendation: 0, source: 0 } }]);
});
it("rejects a changed header and cross-scope rows", async () => {
  const f = fixture(2); await enqueue(f); await begin(f.header);
  await rejectAndRecover(() => begin({ ...f.header, auditEvents: [f.auditEvents[0]] }), /input changed/);
  await rejectAndRecover(() => stage("asset", 0, [{ ...f.assets[0], incident_id: randomUUID() }]), /scope/);
  await rejectAndRecover(() => stage("asset", 0, [{ ...f.assets[0], id: randomUUID() }]), /manifest/);
});
it("rejects stale leases and resumes under a newly claimed lease", async () => {
  const f = fixture(2); await enqueue(f); await begin(f.header);
  await q("update public.ingestion_jobs set lease_until=now()-interval '1 second' where id=$1", [job]);
  const replacement = randomUUID();
  await q("select public.fireafter_claim_ingestion($1,$2)", [job, replacement]);
  await rejectAndRecover(() => stage("asset", 0, f.assets), /Lease lost/);
  await stage("asset", 0, f.assets, replacement);
});
it("withholds incomplete inventories", async () => {
  const f = fixture(2); await enqueue(f); await begin(f.header);
  await stage("asset", 0, f.assets);
  await q("update public.ingestion_jobs set stage='commit:final' where id=$1", [job]);
  await rejectAndRecover(commit, /incomplete/);
  expect((await q("select count(*)::int as n from public.incidents")).rows).toEqual([{ n: 0 }]);
});
it("rolls back incident, rows, audits and receipt when a late recommendation constraint fails", async () => {
  const f = fixture(2); await enqueue(f);
  f.recommendations[1].recommended_action = null as never;
  await stageAll(f);
  await rejectAndRecover(commit, /Invalid staged fields/);
  for (const table of ["incidents", "assets", "recommendations", "audit_events", "ingestion_commit_receipts"]) {
    expect((await q(`select count(*)::int as n from public.${table}`)).rows).toEqual([{ n: 0 }]);
  }
  expect((await q("select count(*)::int as n from public.ingestion_staged_rows")).rows).toEqual([{ n: 4 }]);
});
it("checks current membership before staging, commit and receipt replay", async () => {
  const f = fixture(2); await enqueue(f); await stageAll(f);
  await q("delete from public.organization_members where user_id=$1", [actor]);
  await rejectAndRecover(commit, /Membership revoked/);
  await q("insert into public.organization_members(organization_id,user_id,role) values($1,$2,'analyst')", [org, actor]);
  await commit();
  await q("update public.organization_members set role='viewer' where user_id=$1", [actor]);
  await rejectAndRecover(commit, /Membership revoked/);
});
it("cannot reparent another incident asset", async () => {
  const f = fixture(2); await enqueue(f); await stageAll(f);
  const foreign = randomUUID();
  await q("insert into public.incidents(id,organization_id,county,state,title,status,storm_window) values($1,$2,'Test','CA','Foreign','Stale','Unknown')", [foreign, org]);
  await q("insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence) values($1,$2,'Foreign','Bridge','Test','Test','Low')", [f.assets[0].id, foreign]);
  await rejectAndRecover(commit, /another incident child/);
  expect((await q("select incident_id from public.assets")).rows).toEqual([{ incident_id: foreign }]);
});
it("requires the original revision and valid operation-specific audit", async () => {
  const f = fixture(2); await enqueue(f); await stageAll(f); await commit();
  const otherJob = randomUUID(), otherLease = randomUUID();
  await q("update public.ingestion_jobs set status='completed' where id=$1", [job]);
  await q("select public.fireafter_enqueue_ingestion($1,$2,$3,$4,'refresh',$5)", [otherJob, actor, org,
    f.incident.selected_fire.domainIncidentId, JSON.stringify({ targetId: f.incident.id })]);
  await q("select public.fireafter_claim_ingestion($1,$2)", [otherJob, otherLease]);
  await q("update public.ingestion_jobs set stage='prepare:final' where id=$1", [otherJob]);
  const header = structuredClone(f.header);
  header.write.operation = "refresh"; header.write.expectedRevision = randomUUID();
  (header.incident.selected_fire.inventoryManifest as { revision: string }).revision = randomUUID();
  await q("select public.fireafter_begin_staged_ingestion($1,$2,$3)", [otherJob, otherLease, JSON.stringify(header)]);
  await q("select public.fireafter_stage_ingestion_rows($1,$2,'asset',0,$3)", [otherJob, otherLease, JSON.stringify(f.assets)]);
  await q("select public.fireafter_stage_ingestion_rows($1,$2,'recommendation',0,$3)", [otherJob, otherLease, JSON.stringify(f.recommendations)]);
  await q("update public.ingestion_jobs set stage='commit:final' where id=$1", [otherJob]);
  await rejectAndRecover(() => q("select public.fireafter_commit_staged_ingestion($1,$2)", [otherJob, otherLease]), /revision changed/);
});
it.each(["actor", "event", "timestamp"])("retains the existing audit %s validation in staged publication", async field => {
  const f = fixture(2); await enqueue(f);
  if (field === "actor") f.header.auditEvents[0].actor_id = randomUUID();
  if (field === "event") f.header.auditEvents[0].event_type = "RecommendationAccepted";
  if (field === "timestamp") f.header.auditEvents[0].created_at = "not-a-date";
  await stageAll(f);
  await rejectAndRecover(commit, /Audit|audit|Invalid bundle/);
  expect((await q("select count(*)::int as n from public.incidents")).rows).toEqual([{ n: 0 }]);
});
it("rejects a recommendation referring to a non-member asset", async () => {
  const f = fixture(2); await enqueue(f);
  f.recommendations[0].asset_id = randomUUID();
  await stageAll(f);
  await rejectAndRecover(commit, /outside staged assets/);
});
it("persists source evidence and its original timestamps alongside the exact membership", async () => {
  const f = fixture(2);
  const source = { id: randomUUID(), incident_id: f.incident.id, source_name: "Synthetic outage fixture", source_key: "test-source",
    fetched_at: "2026-10-08T10:00:00.000Z", source_updated_at: null, status: "offline", stale: true, freshness_label: "Unavailable",
    raw_payload: { domainSourceId: "test-source", rawPayload: { providerError: "unavailable" } } } as const;
  f.sourceSnapshots.push(source);
  (f.incident.selected_fire.inventoryManifest as { sourceSnapshotIds: string[] }).sourceSnapshotIds.push(source.id);
  f.header = buildStagedHeader(f);
  await enqueue(f); await stageAll(f); await commit();
  expect((await q("select raw_payload,status,stale from public.source_snapshots where id=$1", [source.id])).rows)
    .toEqual([{ raw_payload: source.raw_payload, status: "offline", stale: true }]);
  expect((await q("select fetched_at = '2026-10-08T10:00:00Z'::timestamptz as original from public.source_snapshots")).rows)
    .toEqual([{ original: true }]);
});
it.runIf(process.env.FIREAFTER_STAGED_SQL_CAPACITY === "1")("publishes more than 64 MiB through real SQL without concatenating a bundle JSON payload", async () => {
  const f = fixture(9000);
  let bytes = 0;
  for (const asset of f.assets) {
    asset.properties.capacityFixture = randomBytes(4400).toString("hex");
    bytes += Buffer.byteLength(JSON.stringify(asset));
  }
  expect(bytes).toBeGreaterThan(64 * 1024 * 1024);
  f.header = buildStagedHeader(f);
  await enqueue(f);
  const started = performance.now();
  await stageAll(f);
  const stagedMs = Math.round(performance.now() - started);
  const committing = performance.now();
  await commit();
  const commitMs = Math.round(performance.now() - committing);
  expect((await q("select count(*)::int as n from public.assets")).rows).toEqual([{ n: 9000 }]);
  expect((await q("select count(*)::int as n from public.recommendations")).rows).toEqual([{ n: 9000 }]);
  for (const index of [0, 4500, 8999]) expect((await q("select properties from public.assets where id=$1", [f.assets[index].id])).rows)
    .toEqual([{ properties: f.assets[index].properties }]);
  expect((await commit()).rows).toEqual([{ id: f.incident.id }]);
  process.stdout.write(JSON.stringify({ event: "staged-sql-capacity", assets: 9000, assetJsonBytes: bytes, stagedMs, commitMs,
    hostedWrites: 0, limitation: "Local embedded PostgreSQL synthetic payload; not hosted Nano capacity or full-county acceptance." }) + "\n");
}, 180_000);
