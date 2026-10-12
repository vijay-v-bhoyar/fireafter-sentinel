import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DocumentVersion } from "../lib/sentinel/contracts";

/** Disposable embedded PostgreSQL; spatial types alone are substituted, not Sentinel SQL. */
export async function sentinelEvidenceSqlFixture() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;`);
  const inherited = (await readFile(new URL("../../supabase/migrations/0001_fireafter_schema.sql", import.meta.url), "utf8"))
    .replace("create extension if not exists postgis with schema extensions;", "")
    .replace("geom extensions.geography(point, 4326)", "geom jsonb")
    .replace("create index if not exists assets_geom_idx on public.assets using gist (geom);", "");
  await db.exec(inherited);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011190000_sentinel_evidence_records.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011200000_sentinel_run_admission.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011210000_sentinel_evidence_publication.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011220000_sentinel_source_registry.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011230000_sentinel_claim_publication.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011231000_sentinel_claim_reviews.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011232000_sentinel_change_drafts.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011233000_sentinel_marker_reviews.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261011234000_sentinel_constraints.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261012001000_sentinel_plan_drafts.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261012002000_sentinel_policy_admission.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261012003000_sentinel_decisions.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261012004000_sentinel_feedback.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261012005000_sentinel_history_briefings.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261012010000_sentinel_provider_funding.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261012011000_sentinel_native_provenance.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261012012000_sentinel_worker_execution.sql", import.meta.url), "utf8"));
  async function seed(version: DocumentVersion, actorId: string, role: "incident_commander" | "analyst" | "viewer" = "viewer") {
    const s = version.scope;
    await db.query("insert into public.organizations(id,name) values($1,'Synthetic isolated fixture') on conflict do nothing", [s.organizationId]);
    await db.query("insert into auth.users(id) values($1) on conflict do nothing", [actorId]);
    await db.query("insert into public.organization_members(organization_id,user_id,role) values($1,$2,$3) on conflict do nothing", [s.organizationId, actorId, role]);
    await db.query(`insert into public.incidents(id,organization_id,county,state,title,status,storm_window)
      values($1,$2,'Fixture county','CA','Synthetic Sentinel','fixture','fixture') on conflict do nothing`, [s.incidentId, s.organizationId]);
    await db.query("insert into public.sentinel_incident_state(organization_id,incident_id,mode) values($1,$2,$3) on conflict do nothing", [s.organizationId, s.incidentId, s.mode]);
    await db.query(`insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by)
      values($1,$2,$3,$4,'{}',$5,$6) on conflict do nothing`, [version.sourceConfigRevision, s.organizationId, s.incidentId, s.mode, "a".repeat(64), actorId]);
    await db.query(`insert into public.sentinel_documents(id,organization_id,incident_id,mode,document_key)
      values($1,$2,$3,$4,$5) on conflict do nothing`, [version.documentId, s.organizationId, s.incidentId, s.mode, version.documentId]);
    const fields: Record<string, unknown> = {
      id: version.id, organization_id: s.organizationId, incident_id: s.incidentId, mode: s.mode,
      document_id: version.documentId, source_config_revision: version.sourceConfigRevision, schema_version: version.schemaVersion,
      normalization_version: version.normalizationVersion, identity_hash: version.identityHash, raw_hash: version.rawHash,
      normalized_hash: version.normalizedHash, normalized_bytes: version.normalizedBytes, normalized_text: version.normalizedText,
      issuer: version.issuer, jurisdiction: version.jurisdiction, canonical_url: version.canonicalUrl,
      published_at: version.publishedAt, effective_from: version.effectiveFrom, effective_until: version.effectiveUntil,
      retrieved_at: version.retrievedAt, availability: version.availability, content_permission: version.contentPermission,
    };
    await db.query("insert into public.sentinel_document_versions select * from jsonb_populate_record(null::public.sentinel_document_versions,$1)", [JSON.stringify(fields)]);
  }
  async function read(actorId: string, organizationId: string, incidentId: string, mode: string, versionId: string) {
    await db.exec("savepoint sentinel_read_fixture");
    await db.exec("set role service_role");
    try {
      const result = (await db.query<{ result: unknown }>("select public.sentinel_read_document_version($1,$2,$3,$4,$5) as result",
        [actorId, organizationId, incidentId, mode, versionId])).rows[0].result;
      await db.exec("reset role; release savepoint sentinel_read_fixture");
      return result;
    } catch (error) {
      await db.exec("rollback to savepoint sentinel_read_fixture; reset role; release savepoint sentinel_read_fixture");
      throw error;
    }
  }
  async function rpc<T = unknown>(name: string, parameters: unknown[]): Promise<T> {
    if (!/^sentinel_[a-z_]+$/.test(name)) throw new Error("Invalid fixture RPC name");
    await db.exec("savepoint sentinel_rpc_fixture; set role service_role");
    try {
      const result = (await db.query<{ result: T }>(`select public.${name}(${parameters.map((_, i) => `$${i + 1}`).join(",")}) as result`, parameters)).rows[0].result;
      await db.exec("reset role; release savepoint sentinel_rpc_fixture");
      return result;
    } catch (error) {
      await db.exec("rollback to savepoint sentinel_rpc_fixture; reset role; release savepoint sentinel_rpc_fixture");
      throw error;
    }
  }
  return { db, seed, read, rpc, close: () => db.close() };
}
