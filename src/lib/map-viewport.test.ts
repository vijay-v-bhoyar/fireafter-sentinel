import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { compactRefreshSqlFixture } from "../test/compact-refresh-sql-fixture";
import { buildSupabasePayload } from "./fireafter-supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { inventoryUser as user } from "../test/asset-page-fixture";
import { responderAuthorityHeaders } from "./responder-command";
import { MAP_VIEW_BYTES, MAP_VIEW_VERSION, MapViewportQuerySchema, validateMapViewportResponse } from "./map-viewport-contract";
import { fetchMapViewport } from "./map-viewport-client";
import type { Asset } from "./types";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("./auth", async original => ({ ...await original<typeof import("./auth")>(), createCurrentUserReader: async () => mocks.auth }));
let sql: Awaited<ReturnType<typeof compactRefreshSqlFixture>>, server: Server, requests: string[];
const migration = () => readFile(new URL("../../supabase/migrations/20261008230000_asset_viewport.sql", import.meta.url), "utf8");
const args = (incidentId: string, revision: string, bbox = [-119, 33, -117, 35], zoom = 0) => ({ p_incident_id: incidentId, p_actor_id: user.id,
  p_organization_id: user.organizationId, p_role: user.role, p_revision: revision, p_bbox: bbox, p_zoom: zoom });
const rpc = async (input: ReturnType<typeof args>) => (await sql.db.query<{ value: unknown }>(
  "select public.fireafter_read_asset_viewport($1,$2,$3,$4,$5,$6,$7) value", Object.values(input))).rows[0].value;
beforeAll(async () => {
  sql = await compactRefreshSqlFixture(); await sql.db.exec(`begin; ${await migration()}; commit;`);
}, 30000);
afterAll(async () => { await sql?.close(); });
beforeEach(async () => {
  vi.resetModules(); mocks.auth.mockReset().mockResolvedValue(user); requests = [];
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "true");
  await sql.db.exec("begin");
  server = createServer(async (req, res) => {
    const name = new URL(req.url!, "http://localhost").pathname.split("/").at(-1)!; requests.push(name);
    try {
      expect(req.method).toBe("POST"); expect(name).toBe("fireafter_read_asset_viewport");
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      await sql.db.exec("set local role service_role");
      const body = await rpc(JSON.parse(Buffer.concat(chunks).toString()));
      await sql.db.exec("reset role"); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body));
    } catch (error) {
      await sql.db.exec("reset role").catch(() => {}); res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: (error as { code?: string }).code ?? "TEST_FAILURE", message: "PRIVATE_DATABASE_DETAIL" }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-test-only");
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await sql.db.exec("rollback"); vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function fixture(total = 260, change?: (assets: Asset[]) => void) {
  const base = createIncidentFromLocation(searchLocations("los-angeles-ca")[0]);
  const incident = { ...base, locationContext: { ...base.locationContext!, bbox: [-119, 33, -117, 35] as [number, number, number, number],
    boundary: { type: "Polygon" as const, coordinates: [[[-119, 33], [-117, 33], [-117, 35], [-119, 35], [-119, 33]]] as [number, number][][] } } };
  const assets: Asset[] = Array.from({ length: total }, (_, index) => ({ id: `asset-map-${index}`, incidentId: incident.id,
    name: `Bridge ${index}`, type: "Bridge", locationLabel: "Creek", coordinates: [-118.9 + (index % 90) / 50, 33.1 + (Math.floor(index / 90) % 90) / 50],
    source: "National Bridge Inventory", sourceKey: "nbi", confidence: "Medium", localOrUploaded: false }));
  change?.(assets);
  const payload = buildSupabasePayload({ incident, recommendations: [], sourceSnapshots: [] }, { assets, auditEvents: [],
    write: { actorId: user.id, organizationId: user.organizationId, operation: "create", expectedRevision: null } });
  await sql.load(payload);
  await sql.db.query("insert into auth.users(id) values ($1)", [user.id]);
  await sql.db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,$3)", [user.organizationId, user.id, user.role]);
  const revision = (payload.incident.selected_fire.inventoryManifest as { revision: string }).revision;
  return { incident, payload, revision };
}
async function route(incidentId: string, revision: string, bbox = "-119,33,-117,35", zoom = "0", signal?: AbortSignal) {
  const { GET } = await import("../app/api/map/viewport/route");
  return GET(new Request(`http://localhost/api/map/viewport?${new URLSearchParams({ incidentId, revision, bbox, zoom })}`, {
    signal, headers: responderAuthorityHeaders({ actorId: user.id, organizationId: user.organizationId }),
  }));
}
it("runs real SQL indexing, SDK and route; clusters conserve all membership and zoom returns only matching points", async () => {
  const { incident, revision } = await fixture();
  const response = await route(incident.id, revision), body = await response.json();
  expect(response.status).toBe(200); expect(body).toMatchObject({ version: MAP_VIEW_VERSION, totalStored: 260, totalLocated: 260, withheld: 0, inView: 260, mode: "clusters" });
  expect(body.items.length).toBeLessThanOrEqual(16); expect(body.items.reduce((sum: number, x: { count?: number }) => sum + (x.count ?? 1), 0)).toBe(260);
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(MAP_VIEW_BYTES);
  const zoomed = await (await route(incident.id, revision, "-118.901,33.099,-118.879,33.121", "7")).json();
  expect(zoomed).toMatchObject({ mode: "points", inView: 4, totalStored: 260 });
  expect(zoomed.items).toHaveLength(4); expect(zoomed.items.every((x: { kind: string }) => x.kind === "point")).toBe(true);
  expect(requests).toEqual(["fireafter_read_asset_viewport", "fireafter_read_asset_viewport"]);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(JSON.stringify(body)).not.toMatch(/score100|riskLevel|sourceUrl|geometry_geojson/);
});
it("returns valid empty views without pretending the entire county is empty", async () => {
  const { incident, revision } = await fixture();
  expect(await (await route(incident.id, revision, "-117.1,34.9,-117,35", "5")).json()).toMatchObject({ inView: 0, items: [], totalStored: 260 });
});
it("keeps a dense pair grouped even below the old 200-point threshold", async () => {
  const { incident, revision } = await fixture(2);
  const body = await (await route(incident.id, revision)).json();
  expect(body).toMatchObject({ mode: "clusters", inView: 2, items: [{ kind: "cluster", id: "c0-0", count: 2, coordinates: [-118.75, 33.25] }] });
});
it("uses strict numeric bounds even near the spatial operator tolerance", async () => {
  const { incident, revision } = await fixture(2, assets => { assets[0].coordinates = [-118.5000005, 34]; assets[1].coordinates = [-118.5, 34]; });
  const body = await (await route(incident.id, revision, "-118.5,33.9,-118.4,34.1", "5")).json();
  expect(body).toMatchObject({ mode: "points", inView: 1, items: [{ coordinates: [-118.5, 34] }] });
});
it("rolls back an asset edit and its index invalidation together", async () => {
  const { incident, revision } = await fixture(2);
  await sql.db.exec("savepoint before_edit; update public.assets set name='Unpublished edit'; rollback to before_edit");
  expect(await (await route(incident.id, revision)).json()).toMatchObject({ totalStored: 2, totalLocated: 2, inView: 2 });
});
it("withholds outside, invalid and old inferred geometries before indexing", async () => {
  const { incident, revision } = await fixture(5, assets => {
    assets[0].coordinates = [-120, 32]; assets[1].coordinates = [NaN, 34];
    assets[2].type = "Inferred Crossing"; assets[2].origin = "inferred"; assets[2].sourceKey = "inferred-crossings";
    assets[3].name = "x".repeat(513);
  });
  expect(await (await route(incident.id, revision)).json()).toMatchObject({ totalStored: 5, totalLocated: 1, withheld: 4, inView: 1 });
});
it.each(["missing-index", "old-writer", "context", "revision", "duplicate-membership"])("fails closed on %s with no full inventory fallback", async fault => {
  const { incident, revision } = await fixture();
  if (fault === "missing-index") await sql.db.exec("delete from public.asset_map_points where asset_id=(select asset_id from public.asset_map_points limit 1)");
  if (fault === "old-writer") await sql.db.exec("update public.assets set name='Updated without map projection'");
  if (fault === "context") await sql.db.exec("update public.incidents set location_context='{}'");
  if (fault === "duplicate-membership") await sql.db.exec("update public.incidents set selected_fire=jsonb_set(selected_fire,'{inventoryManifest,assetIds}',jsonb_build_array(selected_fire->'inventoryManifest'->'assetIds'->0,selected_fire->'inventoryManifest'->'assetIds'->0))");
  const response = await route(incident.id, fault === "revision" ? "55555555-5555-4555-8555-555555555555" : revision);
  expect(response.status).toBe(409); expect(await response.text()).not.toContain("PRIVATE_DATABASE_DETAIL"); expect(requests).toHaveLength(1);
});
it.each(["membership", "organization", "role", "session"])("denies %s drift", async fault => {
  const { incident, revision } = await fixture();
  if (fault === "membership") await sql.db.exec("delete from public.organization_members");
  if (fault === "role") await sql.db.exec("update public.organization_members set role='viewer'");
  if (fault === "organization") mocks.auth.mockResolvedValue({ ...user, organizationId: "55555555-5555-4555-8555-555555555555" });
  if (fault === "session") mocks.auth.mockResolvedValueOnce(user).mockResolvedValue(null);
  const response = await route(incident.id, revision); expect(response.status).toBe(403); expect(await response.text()).not.toContain("Bridge");
});
it.each(["anon", "authenticated"])("denies direct viewport RPC and table access to %s", async role => {
  const grants = (await sql.db.query<{ rpc: boolean; table: boolean }>(`select has_function_privilege($1,'public.fireafter_read_asset_viewport(text,uuid,uuid,text,uuid,double precision[],integer)','execute') rpc, has_table_privilege($1,'public.asset_map_points','select') as table`, [role])).rows[0];
  expect(grants).toEqual({ rpc: false, table: false });
  await sql.db.exec(`set local role ${role}`); await expect(rpc(args("missing", "55555555-5555-4555-8555-555555555555"))).rejects.toMatchObject({ code: "42501" });
});
it.each(["-119,33,-117,NaN", "-119,,1,2", "5,3,4,5", "-181,33,-117,35"])("rejects malformed bounds %s before authentication or database access", async bbox => {
  const response = await route("county", "55555555-5555-4555-8555-555555555555", bbox);
  expect(response.status).toBe(400); expect(mocks.auth).not.toHaveBeenCalled(); expect(requests).toHaveLength(0);
});
it("stays disabled unless explicitly enabled", async () => {
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "false");
  expect((await route("county", "55555555-5555-4555-8555-555555555555")).status).toBe(503); expect(requests).toHaveLength(0);
});
it("serves 91511 indexed positions as bounded exact clusters, not a truncated list", async () => {
  const { incident, revision } = await fixture(91511);
  const start = performance.now();
  const response = await route(incident.id, revision), body = await response.json();
  expect(response.status).toBe(200); expect(body.inView).toBe(91511); expect(body.items).toHaveLength(16);
  expect(body.items.reduce((sum: number, item: { count: number }) => sum + item.count, 0)).toBe(91511);
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(15000);
  expect((await sql.db.query<{ count: number }>("select count(*)::integer count from public.asset_map_points")).rows[0].count).toBe(91511);
  console.info("viewport capacity evidence", { positions: body.inView, bytes: Buffer.byteLength(JSON.stringify(body)), elapsedMs: Math.round(performance.now() - start) });
  await mkdir("output/verification", { recursive: true });
  await writeFile("output/verification/map-viewport-sql-receipt.json", JSON.stringify({ scope: "Synthetic 91511 saved assets; actual embedded SQL, point GiST, SDK and route; controlled Auth, not hosted PostgREST", positions: body.inView,
    bytes: Buffer.byteLength(JSON.stringify(body)), elapsedMs: Math.round(performance.now() - start), clusters: body.items.length, verified: true }, null, 2));
}, 120000);
it("validates response totals and binds the client to its view, authority and revision", async () => {
  const { incident, revision } = await fixture(3), raw = { incidentId: incident.id, revision, bbox: "-119,33,-117,35", zoom: "0" };
  const body = await (await route(incident.id, revision)).json();
  const fetchImpl = vi.fn().mockResolvedValue(Response.json(body));
  expect(await fetchMapViewport(raw, { actorId: user.id, organizationId: user.organizationId }, new AbortController().signal, fetchImpl)).toEqual(body);
  expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/api/map/viewport?"), expect.objectContaining({ cache: "no-store", credentials: "same-origin", headers: responderAuthorityHeaders({ actorId: user.id, organizationId: user.organizationId }) }));
  const parsed = MapViewportQuerySchema.parse(raw);
  for (const changed of [{ ...body, totalStored: 4 }, { ...body, items: body.items.slice(1) }, { ...body, bbox: [-120, 33, -117, 35] }, { ...body, zoom: 1 }, { ...body, items: [body.items[0], body.items[0], body.items[0]] }]) expect(() => validateMapViewportResponse(changed, parsed)).toThrow();
});
