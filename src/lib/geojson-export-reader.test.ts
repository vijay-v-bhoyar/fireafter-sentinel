import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { compactRefreshSqlFixture } from "../test/compact-refresh-sql-fixture";
import { buildSupabasePayload, mapSupabaseRowsToBundle } from "./fireafter-supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { queueSourceProjection, QUEUE_SOURCE_SELECT } from "./queue-source-read-model";
import { dashboardBundleToGeoJson } from "./geojson-export";
import { inventoryUser as user } from "../test/asset-page-fixture";
import { queuePage } from "../test/queue-page-fixture";
import type { Asset, SourceSnapshot, Incident } from "./types";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), fallback: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("./auth", async importOriginal => ({ ...await importOriginal<typeof import("./auth")>(), createCurrentUserReader: async () => mocks.auth }));
vi.mock("./fireafter-data", () => ({ getDashboardBundle: mocks.fallback }));

let sql: Awaited<ReturnType<typeof compactRefreshSqlFixture>>, server: Server;
let requests: string[], cap: number, beforeRequest: ((table: string) => Promise<void>) | undefined;
let stalled = false, disconnected = false;
const migration = () => readFile(new URL("../../supabase/migrations/20261008210000_export_read_fence.sql", import.meta.url), "utf8");
const version = async () => (await sql.db.query<{ value: string | null }>("select public.fireafter_export_read_security_version() value")).rows[0].value;
const fence = async (args: Record<string, unknown>) => (await sql.db.query<{ value: Record<string, unknown> }>(
  "select public.fireafter_export_read_fence($1,$2,$3,$4,$5,$6) value",
  [args.p_incident_id, args.p_actor_id, args.p_organization_id, args.p_role, args.p_expected, args.p_include_row])).rows[0].value;
beforeAll(async () => {
  sql = await compactRefreshSqlFixture();
  await sql.db.exec(`begin; ${await migration()}; commit;`);
}, 30000);
afterAll(async () => { await sql?.close(); });
beforeEach(async () => {
  vi.resetModules(); requests = []; cap = 128; beforeRequest = undefined; stalled = false; disconnected = false;
  mocks.auth.mockReset().mockResolvedValue(user); mocks.fallback.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await sql.db.exec("begin");
  // Real SDK and native HTTP with an explicit SQL translator, not hosted PostgREST/Auth.
  server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost"), table = url.pathname.split("/").at(-1)!;
    requests.push(table);
    try {
      if (beforeRequest) await beforeRequest(table);
      if (stalled && table === "recommendations") { response.on("close", () => { disconnected = true; }); return; }
      let data: unknown, count: number | undefined;
      await sql.db.exec("set local role service_role");
      try {
        if (table === "fireafter_export_read_security_version") data = await version();
        else if (table === "fireafter_export_read_fence") {
          expect(request.method).toBe("POST"); const parts: Buffer[] = [];
          for await (const part of request) parts.push(Buffer.from(part));
          data = await fence(JSON.parse(Buffer.concat(parts).toString()));
        } else {
          expect(request.method).toBe("GET"); expect(["assets", "recommendations", "source_snapshots"]).toContain(table);
          const ids = url.searchParams.get("id")!.slice(4, -1).split(","); expect(ids.length).toBeLessThanOrEqual(128);
          const incidentId = url.searchParams.get("incident_id")!.slice(3);
          const all = (await sql.db.query<{ value: Record<string, unknown> }>(`select to_jsonb(t) value from public.${table} t where incident_id=$1 and id=any($2::uuid[]) order by id`, [incidentId, ids])).rows.map(row => row.value);
          count = all.length; data = all.slice(0, Math.min(cap, Number(url.searchParams.get("limit"))));
          if (table === "source_snapshots") {
            expect(url.searchParams.get("select")).toBe(QUEUE_SOURCE_SELECT);
            data = (data as Parameters<typeof queueSourceProjection>[0][]).map(queueSourceProjection);
          } else expect(url.searchParams.get("select")).toBe("*");
        }
      } finally {
        // A failed SQL statement aborts this test transaction; keep its original error.
        await sql.db.exec("reset role").catch(() => {});
      }
      response.writeHead(200, { "content-type": "application/json", ...(count !== undefined ? { "content-range": `0-0/${count}` } : {}) });
      response.end(JSON.stringify(data));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: (error as { code?: string }).code ?? "TEST_FAILURE", message: "PRIVATE_TEST_DATABASE_DETAIL" }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-fixture-only"); vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "60000");
  vi.stubEnv("FIREAFTER_STREAMING_EXPORT_ENABLED", "true");
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await sql.db.exec("rollback"); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture(total = 260, expired = false) {
  const incident = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const recommendations = queuePage(0, total, total).items.flatMap(item => item.status === "available" ? [{ ...item.recommendation,
    incidentId: incident.id, coordinates: [-118.25, 34.05] as [number, number], assetName: `Bridge ${String(total - item.position).padStart(6, "0")}`,
    score100: item.position % 3 ? 60 : 80, riskLevel: item.position % 2 ? "High" as const : "Unknown" as const,
  }] : []);
  const assets: Asset[] = recommendations.map(rec => ({ id: rec.assetId, incidentId: incident.id, name: rec.assetName, type: "Bridge", locationLabel: "Creek",
    coordinates: rec.coordinates, source: "National Bridge Inventory", sourceKey: "nbi", confidence: "Medium", localOrUploaded: false }));
  const at = new Date(Date.now() - (expired ? 3600000 : 0)).toISOString();
  const sources: SourceSnapshot[] = [{ id: "source-nbi", incidentId: incident.id, sourceKey: "nbi", sourceName: "Bridge Inventory", fetchedAt: at, sourceUpdatedAt: at,
    sourceTimeBasis: "provider", status: "online", stale: false, coverageStatus: "available", freshnessLabel: "Checked", detail: "Published records", rawPayload: { records: total } }];
  const payload = buildSupabasePayload({ incident, recommendations, sourceSnapshots: sources }, { assets, auditEvents: [],
    write: { actorId: user.id, organizationId: user.organizationId, operation: "create", expectedRevision: null } });
  return loadPayload(incident, payload);
}
async function loadPayload(incident: Incident, payload: ReturnType<typeof buildSupabasePayload>) {
  await sql.load(payload);
  await sql.db.query("insert into auth.users(id) values ($1)", [user.id]);
  await sql.db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,$3)", [user.organizationId, user.id, user.role]);
  await sql.db.query("insert into public.source_snapshots select * from jsonb_populate_recordset(null::public.source_snapshots,$1)", [JSON.stringify(payload.sourceSnapshots)]);
  return { incident, payload };
}
async function route(id: string, signal?: AbortSignal) {
  const { GET } = await import("../app/api/export/geojson/route");
  return GET(new Request(`http://localhost/api/export/geojson?incidentId=${id}`, { signal }));
}
const args = (id: string) => ({ p_incident_id: id, p_actor_id: user.id, p_organization_id: user.organizationId, p_role: user.role, p_expected: null, p_include_row: true });

it.each([false, true])("exports every stored row through SQL, actual SDK and route with full-mapper parity, expired=%s", async expired => {
  const { incident, payload } = await fixture(260, expired); cap = 23;
  const response = await route(incident.id); expect(response.status).toBe(200);
  const body = await response.json();
  const expected = dashboardBundleToGeoJson({ ...mapSupabaseRowsToBundle({ ...payload, responderActions: [], auditEvents: [] }), generatedAt: body.generatedAt });
  expect(body.features).toEqual(expected.features); expect(body.fireafter).toEqual(expected.fireafter);
  expect(body.fireafterExport).toMatchObject({ complete: true, scanned: 260, exported: 260, totalStored: 260 });
  expect(requests).not.toContain("incidents"); expect(mocks.fallback).not.toHaveBeenCalled();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it.each(["title", "role", "source", "schema", "missing-row", "auth"])("aborts a started export after %s changes", async defect => {
  const { incident } = await fixture(); const response = await route(incident.id); expect(response.status).toBe(200);
  if (defect === "title") await sql.db.exec("update public.incidents set title='changed'");
  if (defect === "role") await sql.db.exec("update public.organization_members set role='viewer'");
  if (defect === "source") await sql.db.exec("update public.source_snapshots set source_name='changed'");
  if (defect === "schema") await sql.db.exec("alter function public.fireafter_export_read_fence(text,uuid,uuid,text,text,boolean) security definer");
  if (defect === "missing-row") await sql.db.exec("delete from public.recommendations");
  if (defect === "auth") mocks.auth.mockResolvedValue(null);
  await expect(response.text()).rejects.toThrow("complete GeoJSON export could not be verified");
  expect(mocks.fallback).not.toHaveBeenCalled();
});
it("does not issue attachment headers or use aggregate fallback on initial access failure", async () => {
  const { incident } = await fixture(2); await sql.db.exec("delete from public.organization_members");
  const response = await route(incident.id); expect(response.status).toBe(403);
  expect(response.headers.get("content-disposition")).toBeNull(); expect(await response.text()).not.toContain("PRIVATE_TEST_DATABASE_DETAIL");
  expect(mocks.fallback).not.toHaveBeenCalled();
});
it.each(["anon", "authenticated"])("does not expose the fence or attestation to %s", async role => {
  await sql.db.exec(`set local role ${role}`); await expect(version()).rejects.toMatchObject({ code: "42501" });
  await sql.db.exec(`rollback; begin; set local role ${role}`);
  await expect(fence(args("county"))).rejects.toMatchObject({ code: "42501" });
});
it("keeps a stable fingerprint across timezone settings and detects unchanged-revision parent edits", async () => {
  const { incident } = await fixture(2); const first = await fence(args(incident.id));
  await sql.db.exec("set local timezone='America/New_York'");
  const compact = await fence({ ...args(incident.id), p_expected: first.fingerprint, p_include_row: false });
  expect(compact.fingerprint).toBe(first.fingerprint); expect(compact.row).toBeNull();
  await sql.db.exec("update public.incidents set title='changed'");
  await expect(fence({ ...args(incident.id), p_expected: first.fingerprint })).rejects.toMatchObject({ code: "FB409" });
});
it("executes without writes inside a read-only transaction", async () => {
  const { incident } = await fixture(2); await sql.db.exec("set transaction read only");
  expect((await (await route(incident.id)).json()).fireafterExport.exported).toBe(2);
});
it("cancels an active database request when the download is abandoned", async () => {
  const { incident } = await fixture(); const caller = new AbortController();
  const response = await route(incident.id, caller.signal); stalled = true;
  const pending = expect(response.text()).rejects.toThrow();
  await vi.waitFor(() => expect(requests.filter(name => name === "recommendations")).toHaveLength(2));
  caller.abort(); await pending; await vi.waitFor(() => expect(disconnected).toBe(true));
});
it("withdraws a current export if evidence expires while the consumer pauses", async () => {
  const { incident } = await fixture(); const response = await route(incident.id);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 3600000);
  await expect(response.text()).rejects.toThrow("complete GeoJSON export could not be verified");
});
it("bounds county validation per fetched page without counting database waits as geometry work", async () => {
  const { incident } = await fixture();
  await sql.db.exec(`update public.incidents set selected_fire=jsonb_set(selected_fire,'{locationContext,boundary}',
    '{"type":"Polygon","coordinates":[[[-119,33],[-117,33],[-117,35],[-119,35],[-119,33]]]}'::jsonb)`);
  const now = performance.now.bind(performance); let offset = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now() + offset);
  beforeRequest = async table => { if (table === "recommendations") offset += 6_000; };
  const body = await (await route(incident.id)).json();
  expect(body.fireafterExport).toMatchObject({ complete: true, scanned: 260, exported: 260 });
  expect(requests.filter(name => name === "recommendations")).toHaveLength(3);
});
it("keeps exact withheld counts for non-operational and invalid/outside geometry", async () => {
  const { incident, payload } = await fixture(4);
  await sql.db.query("update public.recommendations set score_breakdown=score_breakdown||'{\"nonOperational\":true}'::jsonb where id=$1", [payload.recommendations[0].id]);
  await sql.db.query("update public.assets set properties=properties-'coordinates' where id=$1", [payload.assets[1].id]);
  await sql.db.query("update public.assets set properties=properties||'{\"coordinates\":[0,0]}'::jsonb where id=$1", [payload.assets[2].id]);
  const body = await (await route(incident.id)).json();
  expect(body.fireafterExport).toMatchObject({ scanned: 4, exported: 1, withheld: { "non-operational": 1, "unverified-geometry": 1, "outside-county": 1 } });
});
it("verifies and exports an empty saved inventory", async () => {
  const { incident } = await fixture(0); const body = await (await route(incident.id)).json();
  expect(body.features).toEqual([]); expect(body.fireafterExport).toMatchObject({ complete: true, scanned: 0, exported: 0 });
});
it("retains explicit legacy fallback but never falls back for corrupt current metadata", async () => {
  const { incident, payload } = await fixture(2);
  mocks.fallback.mockResolvedValue({ ...mapSupabaseRowsToBundle({ ...payload, responderActions: [], auditEvents: [] }), sensitiveInfrastructureAccess: true });
  await sql.db.exec("update public.incidents set selected_fire=selected_fire #- '{inventoryManifest,queueIndex}'");
  expect((await route(incident.id)).status).toBe(200); expect(mocks.fallback).toHaveBeenCalledOnce();
  mocks.fallback.mockClear();
  await sql.db.exec("update public.incidents set selected_fire=jsonb_set(selected_fire,'{inventoryManifest,queueIndex}','{}')");
  expect((await route(incident.id)).status).toBe(503); expect(mocks.fallback).not.toHaveBeenCalled();
});
it.each([
  "grant execute on function public.fireafter_export_read_fence(text,uuid,uuid,text,text,boolean) to public",
  "alter function public.fireafter_export_read_fence(text,uuid,uuid,text,text,boolean) strict",
  "alter function public.fireafter_export_read_fence(text,uuid,uuid,text,text,boolean) set timezone='America/New_York'",
  "alter function public.fireafter_export_read_fence(text,uuid,uuid,text,text,boolean) set statement_timeout='30s'",
  "alter function public.fireafter_export_read_fence(text,uuid,uuid,text,text,boolean) owner to service_role",
])("rejects changed effective SQL security: %s", async change => {
  expect(await version()).toBe("20261008210000"); await sql.db.exec(change); expect(await version()).toBeNull();
});
it("preserves public/viewer and disabled-path behavior instead of exposing private rows", async () => {
  const { incident, payload } = await fixture(2);
  mocks.auth.mockResolvedValue({ ...user, role: "viewer" });
  mocks.fallback.mockResolvedValue({ ...mapSupabaseRowsToBundle({ ...payload, responderActions: [], auditEvents: [] }), sensitiveInfrastructureAccess: false });
  expect((await route(incident.id)).status).toBe(200); expect(requests).toEqual([]);
  vi.stubEnv("FIREAFTER_STREAMING_EXPORT_ENABLED", "false"); mocks.auth.mockClear();
  expect((await route(incident.id)).status).toBe(200); expect(mocks.auth).not.toHaveBeenCalled();
});
async function verifyFullExport({ incident, payload }: Awaited<ReturnType<typeof fixture>>) {
  {
    const readerModule = await import("./fireafter-supabase"), original = readerModule.getSupabaseGeoJsonExportSource;
    vi.spyOn(readerModule, "getSupabaseGeoJsonExportSource").mockImplementation(async (...args) => {
      const result = await original(...args), pages = result.pages;
      result.pages = async function* (signal) {
        try { yield* pages(signal); } catch (error) {
          const detail = error as { name?: string; code?: string; issues?: Array<{ code: string; path: unknown[] }> };
          console.info("Export reader diagnostic", { name: detail.name, code: detail.code, requests: requests.length, issues: detail.issues?.map(issue => ({ code: issue.code, path: issue.path })) });
          throw error;
        }
      };
      return result;
    });
  }
  const expectedHash = createHash("sha256"), actualHash = createHash("sha256");
  const requestedAt = Date.now(); let metadataSeen = false;
  const response = await route(incident.id); expect(response.status).toBe(200);
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let tail = "", count = 0, bytes = 0;
  for (;;) {
    const result = await reader.read(); if (result.done) break;
    bytes += result.value.byteLength; tail += decoder.decode(result.value, { stream: true });
    let newline: number;
    while ((newline = tail.indexOf("\n")) >= 0) {
      const line = tail.slice(0, newline); tail = tail.slice(newline + 1);
      if (line.startsWith('{"type":"FeatureCollection"')) {
        expect(metadataSeen).toBe(false); metadataSeen = true;
        const metadata = JSON.parse(line.slice(0, -',"features":['.length) + '}');
        expect(Date.parse(metadata.generatedAt)).toBeGreaterThanOrEqual(requestedAt);
        expect(Date.parse(metadata.generatedAt)).toBeLessThanOrEqual(Date.now());
        // Full and streamed projections must use the same declared instant. Real deadline clocks stay active.
        const expected = dashboardBundleToGeoJson({ ...mapSupabaseRowsToBundle({ ...payload, responderActions: [], auditEvents: [] }), generatedAt: metadata.generatedAt }).features;
        for (const feature of expected) expectedHash.update(JSON.stringify(feature));
        continue;
      }
      const value = JSON.parse(line.replace(/^,/, "")); actualHash.update(JSON.stringify(value)); count++;
    }
  }
  tail += decoder.decode(); const receipt = JSON.parse(tail.slice('],"fireafterExport":'.length, -1));
  expect(receipt).toMatchObject({ complete: true, exported: 91511, scanned: 91511 });
  expect(metadataSeen).toBe(true);
  expect(count).toBe(91511); expect(actualHash.digest("hex")).toBe(expectedHash.digest("hex"));
  expect(requests.filter(name => name === "recommendations")).toHaveLength(715);
  expect(mocks.fallback).not.toHaveBeenCalled();
  console.info("SQL-backed export receipt", { records: count, bytes, requests: requests.length });
}
it("streams all 91511 stored synthetic rows through the database reader and route", async () => {
  await verifyFullExport(await fixture(91511, true));
}, 300000);

it.runIf(process.env.FIREAFTER_SAVED_EXPORT_FIXTURE === "true")("exports all saved Monterey public-geometry candidates with explicitly unavailable hazard signals", async () => {
  const { prepareCountyScope } = await import("./county-scope");
  const { prepareLiveRecommendationContext, createLiveRecommendationScorer, sourceFailureResult } = await import("./live-sources");
  const { location } = JSON.parse(gunzipSync(await readFile("output/verification/monterey-public-lines-exact-county.json.gz")).toString());
  const incident = createIncidentFromLocation(location), scope = prepareCountyScope(incident);
  const assets = (JSON.parse(gunzipSync(await readFile("output/verification/monterey-public-crossings-complete.json.gz")).toString()) as Asset[])
    .filter(asset => scope.contains(asset.coordinates));
  expect(assets).toHaveLength(91511);
  const now = new Date(), source = sourceFailureResult("nws", now);
  const scorer = createLiveRecommendationScorer(prepareLiveRecommendationContext(incident, {}, [source], [], now));
  const recommendations = [];
  for (let start = 0; start < assets.length; start += 128) recommendations.push(...scorer.scorePage(assets.slice(start, start + 128)));
  const payload = buildSupabasePayload({ incident, recommendations, sourceSnapshots: [] }, { assets, auditEvents: [], write: {
    actorId: user.id, organizationId: user.organizationId, operation: "create", expectedRevision: null,
  } });
  await verifyFullExport(await loadPayload(incident, payload));
}, 300000);
