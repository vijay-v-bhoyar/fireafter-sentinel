import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { compactRefreshSqlFixture } from "../test/compact-refresh-sql-fixture";
import { buildSupabasePayload } from "./fireafter-supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { queuePage } from "../test/queue-page-fixture";
import { inventoryUser } from "../test/asset-page-fixture";
import { COMPACT_REFRESH_SECURITY_VERSION, decodeCompactRefreshPage } from "./compact-refresh-page";
import type { Asset } from "./types";

let sql: Awaited<ReturnType<typeof compactRefreshSqlFixture>>;
beforeAll(async () => { sql = await compactRefreshSqlFixture(); }, 30_000);
afterAll(async () => { await sql?.close(); });
beforeEach(async () => { await sql.db.exec("begin"); });
afterEach(async () => { await sql.db.exec("rollback"); });

function fixture(count = 6) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const recommendations = queuePage(0, count, count).items.flatMap(item => item.status === "available" ? [{ ...item.recommendation,
    incidentId: incident.id, coordinates: [-118.25, 34.05] as [number, number],
    evidence: [{ sourceKey: "nws", sourceName: "NWS", summary: "Shared field ".repeat(100) }],
  }] : []);
  const assets: Asset[] = recommendations.map(rec => ({ id: rec.assetId, incidentId: incident.id, name: rec.assetName, type: "Bridge",
    locationLabel: "County creek", coordinates: rec.coordinates, source: "Official bridge data", sourceKey: "fhwa-nbi-bridges",
    confidence: "Low", localOrUploaded: false, origin: "source" }));
  return buildSupabasePayload({ incident, recommendations, sourceSnapshots: [] }, { assets, auditEvents: [], write: {
    actorId: inventoryUser.id, organizationId: inventoryUser.organizationId, operation: "create", expectedRevision: null,
  } });
}
const argsFor = (payload: ReturnType<typeof fixture>, after: string | null = null, limit = 500) => ({
  p_incident_id: payload.incident.id, p_organization_id: payload.incident.organization_id, p_after: after, p_limit: limit,
});
const read = (args: ReturnType<typeof argsFor>) => sql.rpc("fireafter_read_refresh_recommendations", args);
const version = () => sql.rpc("fireafter_refresh_read_security_version", {});

it("attests exact bodies/settings/owner/effective grants", async () => {
  expect(await version()).toBe(COMPACT_REFRESH_SECURITY_VERSION);
});
it.each([
  "grant execute on function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer) to authenticated",
  "grant execute on function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer) to public",
  "alter function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer) security definer",
  "alter function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer) set statement_timeout='30s'",
  "alter function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer) volatile",
  "alter function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer) strict",
  "alter function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer) owner to service_role",
  "create or replace function public.fireafter_read_refresh_recommendations(p_incident_id uuid,p_organization_id uuid,p_after uuid,p_limit integer) returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='15s' as $$ begin return '{}'; end $$",
])("refuses altered security contract: %s", async statement => {
  await sql.db.exec(statement); expect(await version()).toBeNull();
});

it.each(["anon", "authenticated"])("denies %s execution, including the attestation endpoint", async role => {
  await sql.db.exec(`set local role ${role}`);
  await expect(version()).rejects.toMatchObject({ code: "42501" });
  await sql.db.exec("rollback; begin");
  await sql.db.exec(`set local role ${role}`);
  await expect(read(argsFor(fixture()))).rejects.toMatchObject({ code: "42501" });
});

it("returns every full row without loss through keysets and service-only reads", async () => {
  const payload = fixture();
  payload.recommendations[0].evidence = [{ nested: { non_operational: true }, falseValue: false, nullValue: null, zero: 0 }];
  await sql.load(payload);
  const expected = (await sql.db.query<{ row: Record<string, unknown> }>(`select to_jsonb(r)||jsonb_build_object('asset',jsonb_build_object(
    'id',a.id,'incident_id',a.incident_id,'name',a.name,'asset_type',a.asset_type,'location_label',a.location_label,
    'local_or_uploaded',a.local_or_uploaded,'origin',a.origin,'source_key',a.source_key,'coordinates',a.properties->'coordinates',
    'domainAssetId',a.properties->>'domainAssetId','propertySourceKey',a.properties->>'sourceKey')) as row
    from public.recommendations r join public.assets a on a.id=r.asset_id order by r.id`)).rows.map(item => item.row);
  await sql.db.exec("set local role service_role");
  expect(await version()).toBe(COMPACT_REFRESH_SECURITY_VERSION);
  const all: Record<string, unknown>[] = [];
  while (all.length < expected.length) {
    const envelope = await read(argsFor(payload, all.length ? all.at(-1)!.id as string : null, 2));
    const page = decodeCompactRefreshPage(envelope, payload.incident.id);
    expect(page.count).toBe(expected.length - all.length);
    expect(page.expandedBytes).toBe(Buffer.byteLength(JSON.stringify(page.data)));
    all.push(...page.data);
  }
  expect(all).toEqual(expected);
  expect(decodeCompactRefreshPage(await read(argsFor(payload, all.at(-1)!.id as string)), payload.incident.id).data).toEqual([]);
});

it("reduces shared field transfer while preserving a single-row raw fallback", async () => {
  const payload = fixture(); await sql.load(payload);
  const many = await read(argsFor(payload)) as { page: unknown };
  expect(Array.isArray(many.page)).toBe(false);
  const decoded = decodeCompactRefreshPage(many, payload.incident.id);
  expect(decoded.bytes).toBeLessThan(decoded.expandedBytes);
  const single = await read(argsFor(payload, null, 1)) as { page: unknown };
  expect(Array.isArray(single.page)).toBe(true);
});

it.each(["organization", "missing", "limit-zero", "limit-over", "limit-null"])("refuses invalid %s scope", async defect => {
  const payload = fixture(); await sql.load(payload); const args = argsFor(payload);
  if (defect === "organization") args.p_organization_id = randomUUID();
  else if (defect === "missing") args.p_incident_id = randomUUID();
  else args.p_limit = defect === "limit-zero" ? 0 : defect === "limit-over" ? 501 : null as unknown as number;
  await expect(read(args)).rejects.toMatchObject({ code: defect === "organization" ? "FB401" : defect === "missing" ? "FB404" : "FB400" });
});

it("enforces expanded SQL page capacity before returning compressed data", async () => {
  const payload = fixture(); await sql.load(payload);
  await sql.db.query("update public.recommendations set evidence=jsonb_build_array(repeat('x',1500000))");
  await expect(read(argsFor(payload))).rejects.toMatchObject({ code: "FB413" });
});

it("executes in a read-only transaction without modifying operational rows", async () => {
  const payload = fixture(); await sql.load(payload);
  await sql.db.exec("set transaction read only");
  expect(decodeCompactRefreshPage(await read(argsFor(payload)), payload.incident.id).data).toHaveLength(6);
});
