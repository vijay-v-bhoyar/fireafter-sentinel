import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { prepareIngestionPayload } from "./ingestion-payload";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { encodeCheckpoint } from "./ingestion-checkpoint";
import type { Asset, Recommendation } from "./types";

it("commits the real staged payload through the existing production SQL authorization fence", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create table public.organizations(id uuid primary key,name text);
      create table public.organization_members(user_id uuid,organization_id uuid,role text);
      create table public.incidents(id uuid primary key,organization_id uuid,selected_fire jsonb);
      create table public.assets(id uuid primary key,incident_id uuid);
      create table public.recommendations(id uuid primary key,incident_id uuid);
      create table public.source_snapshots(id uuid primary key,incident_id uuid);
      create table public.audit_events(id uuid primary key,incident_id uuid,recommendation_id uuid,actor_id uuid,
        actor_name text,event_type text,summary text,payload jsonb,created_at timestamptz);
      create function public.fireafter_prevent_append_only_mutation() returns trigger language plpgsql as $$ begin raise exception 'append only'; end $$;
      create function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
      returns void language plpgsql as $$ begin
        insert into public.incidents values(($2->>'id')::uuid,($2->>'organization_id')::uuid,$2->'selected_fire');
        insert into public.assets select id,incident_id from jsonb_to_recordset($4) as r(id uuid,incident_id uuid);
        insert into public.recommendations select id,incident_id from jsonb_to_recordset($5) as r(id uuid,incident_id uuid);
        insert into public.audit_events select * from jsonb_to_recordset($7) as r(id uuid,incident_id uuid,recommendation_id uuid,actor_id uuid,
          actor_name text,event_type text,summary text,payload jsonb,created_at timestamptz);
      end $$;`);
    const fence = await readFile(new URL("../../supabase/migrations/20260914034000_bundle_write_fencing.sql", import.meta.url), "utf8");
    const start = fence.indexOf("create function public.fireafter_commit_bundle(");
    // Execute the exact production fence, not a substitute authorization implementation.
    await db.exec(fence.slice(start, fence.indexOf("alter function public.fireafter_commit_bundle", start)));
    await db.exec(await readFile(new URL("../../supabase/migrations/20261007120000_durable_ingestion.sql", import.meta.url), "utf8"));
    const actor = "10000000-0000-4000-a000-000000000001", org = "20000000-0000-4000-a000-000000000001";
    const job = "50000000-0000-4000-a000-000000000001", lease = "60000000-0000-4000-a000-000000000001";
    await db.query("insert into auth.users values($1)", [actor]);
    await db.query("insert into public.organizations values($1,'Test only')", [org]);
    await db.query("insert into public.organization_members values($1,$2,'analyst')", [actor, org]);
    const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
    const assets: Asset[] = Array.from({ length: 5665 }, (_, index) => ({ id: `test-${index}`, incidentId: incident.id,
      name: `Test bridge ${index}`, type: "Bridge", locationLabel: "Synthetic load test", coordinates: [-118.2, 34.2],
      source: "Test fixture", confidence: "Low", localOrUploaded: false, origin: "source" } as Asset));
    const recommendations: Recommendation[] = assets.map(asset => ({ id: `review-${asset.id}`, incidentId: incident.id,
      assetId: asset.id, assetName: asset.name, assetType: asset.type, locationLabel: asset.locationLabel, coordinates: asset.coordinates,
      recommendedAction: "Review missing evidence", riskLevel: "Unknown", finalScore: 0, score100: 0, confidenceLevel: "Low",
      reasonCodes: [], limitations: ["Synthetic test fixture"], changedSinceLastRefresh: "New", sourcesUpdatedLabel: "Unknown", dataFreshnessHours: 0,
      scoreBreakdown: { rainfallThreat: 0, burnSeverity: 0, slopeTerrain: 0, downstreamExposure: 0, dataFreshness: 0, confidenceMultiplier: 0, baseScore: 0, finalScore: 0 },
      createdAt: new Date().toISOString() }));
    const payload = prepareIngestionPayload(job, "initial", { incident, assets, recommendations, sourceSnapshots: [] },
      { actorId: actor, organizationId: org, expectedRevision: null, operation: "create" });
    expect(payload.auditEvents[0]).toMatchObject({ actor_id: actor, payload: { actorId: actor, expectedRevision: null, operation: "create" } });
    await db.query("select public.fireafter_enqueue_ingestion($1,$2,$3,$4,'create',$5)", [job, actor, org, incident.id, JSON.stringify({ incident })]);
    await db.query("select public.fireafter_claim_ingestion($1,$2)", [job, lease]);
    await db.query("update public.ingestion_jobs set stage='commit:initial' where id=$1", [job]);
    const { manifest, parts } = encodeCheckpoint(payload, false);
    for (let index = 0; index < parts.length; index++) await db.query("select public.fireafter_checkpoint_ingestion($1,$2,'commit:initial',$3,$4)", [job, lease, index, JSON.stringify(parts[index])]);
    await db.query("select public.fireafter_checkpoint_ingestion($1,$2,'commit:initial',-1,$3)", [job, lease, JSON.stringify(manifest)]);
    await db.query("select public.fireafter_commit_ingestion($1,$2,'initial')", [job, lease]);
    await db.query("select public.fireafter_commit_ingestion($1,$2,'initial')", [job, lease]);
    expect((await db.query("select count(*)::int as count from public.assets")).rows).toEqual([{ count: 5665 }]);
    expect((await db.query("select count(*)::int as count from public.recommendations")).rows).toEqual([{ count: 5665 }]);
    expect((await db.query("select count(*)::int as count from public.audit_events")).rows).toEqual([{ count: 2 }]);
  } finally { await db.close(); }
}, 90_000);
