import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { compactRefreshSqlFixture } from "../test/compact-refresh-sql-fixture";
import { buildSupabasePayload } from "./fireafter-supabase";
import { createIncidentFromLocation, searchLocations } from "./fireafter-store";
import { inventoryUser as user } from "../test/asset-page-fixture";
import { responderAuthorityHeaders } from "./responder-command";
import { SOURCE_LINE_GEOMETRY_VERSION, readSourceLineGeometry } from "./source-line-geometry";
import { PWFDF_ANALYSIS_GEOMETRY_VERSION } from "./pwfdf-geometry";
import { SOURCE_VIEW_BYTES, SOURCE_VIEW_VERSION, SourceViewportQuerySchema, type SourceViewportQuery } from "./source-viewport-contract";
import { projectSourceViewport } from "./source-viewport-server";
import { fetchSourceViewport } from "./source-viewport-client";
import type { SourceSnapshot, LocationCandidate } from "./types";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("./auth", async original => ({ ...await original<typeof import("./auth")>(), createCurrentUserReader: async () => mocks.auth }));
let sql: Awaited<ReturnType<typeof compactRefreshSqlFixture>>, server: Server, requests: string[];
let mutate: ((body: Record<string, unknown>) => void) | undefined;
const migration = (name: string) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const rpc = async (input: Record<string, unknown>) => (await sql.db.query<{ value: unknown }>(
  "select public.fireafter_read_source_viewport($1,$2,$3,$4,$5,$6,$7,$8) value",
  [input.p_incident_id, input.p_actor_id, input.p_organization_id, input.p_role, input.p_revision, input.p_bbox, input.p_zoom, input.p_layer])).rows[0].value;
beforeAll(async () => {
  sql = await compactRefreshSqlFixture();
  await sql.db.exec(`begin; ${await migration("20261008230000_asset_viewport")}; ${await migration("20261009003000_source_viewport")}; commit;`);
}, 30000);
afterAll(async () => { await sql?.close(); });
beforeEach(async () => {
  vi.resetModules(); mocks.auth.mockReset().mockResolvedValue(user); requests = []; mutate = undefined;
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "true");
  await sql.db.exec("begin");
  server = createServer(async (req, res) => {
    const name = new URL(req.url!, "http://localhost").pathname.split("/").at(-1)!; requests.push(name);
    await sql.db.exec("savepoint source_read");
    try {
      expect(req.method).toBe("POST"); expect(name).toBe("fireafter_read_source_viewport");
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      await sql.db.exec("set local role service_role");
      const body = await rpc(JSON.parse(Buffer.concat(chunks).toString())) as Record<string, unknown>;
      await sql.db.exec("reset role; release savepoint source_read"); mutate?.(body);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body));
    } catch (error) {
      await sql.db.exec("rollback to savepoint source_read; reset role; release savepoint source_read");
      res.writeHead(400, { "content-type": "application/json" });
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
function source(count = 300): SourceSnapshot {
  return { id: "source-roads", incidentId: "filled-by-fixture", sourceKey: "tiger-roads", sourceName: "Census TIGERweb", sourceUrl: "https://tigerweb.geo.census.gov/",
    fetchedAt: "2026-10-01T00:00:00Z", sourceUpdatedAt: "2026-09-01T00:00:00Z", sourceTimeBasis: "provider", status: "online", stale: false,
    coverageStatus: "available", freshnessLabel: "Original check", detail: "Complete saved roads", warnings: [],
    rawPayload: { geometryVersion: SOURCE_LINE_GEOMETRY_VERSION, inventoryComplete: true, featureCount: count,
      features: Array.from({ length: count }, (_, i) => ({ id: String(i), name: `Road ${i}`, sourceKey: "tiger-roads", sourceName: "Census TIGERweb",
        sourceUrl: "https://tigerweb.geo.census.gov/", paths: [[[-118.9 + i % 80 / 50, 33.1 + Math.floor(i / 80) / 50], [-118.89 + i % 80 / 50, 33.11 + Math.floor(i / 80) / 50]]] })) } };
}
async function fixture(snapshots = [source()], location?: LocationCandidate) {
  const base = createIncidentFromLocation(location ?? searchLocations("los-angeles-ca")[0]);
  const incident = location ? base : { ...base, locationContext: { ...base.locationContext!, bbox: [-119, 33, -117, 35] as [number, number, number, number],
    boundary: { type: "Polygon" as const, coordinates: [[[-119, 33], [-117, 33], [-117, 35], [-119, 35], [-119, 33]]] as [number, number][][] } } };
  const payload = buildSupabasePayload({ incident, recommendations: [], sourceSnapshots: snapshots.map(snapshot => ({ ...snapshot, incidentId: incident.id })) }, {
    assets: [], auditEvents: [], write: { actorId: user.id, organizationId: user.organizationId, operation: "create", expectedRevision: null } });
  await sql.load(payload);
  await sql.db.query("insert into auth.users(id) values ($1)", [user.id]);
  await sql.db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,$3)", [user.organizationId, user.id, user.role]);
  for (const row of payload.sourceSnapshots) await sql.db.query("insert into public.source_snapshots select * from jsonb_populate_record(null::public.source_snapshots,$1)", [JSON.stringify({ created_at: "2026-10-08T12:00:00Z", ...row })]);
  const revision = (payload.incident.selected_fire.inventoryManifest as { revision: string }).revision;
  const raw: SourceViewportQuery = { incidentId: incident.id, revision, bbox: "-119,33,-117,35", zoom: "0", layer: "tiger-roads" };
  return { incident, payload, revision, raw };
}
async function route(raw: SourceViewportQuery, signal?: AbortSignal, extra = "") {
  const { GET } = await import("../app/api/map/source-viewport/route");
  return GET(new Request(`http://localhost/api/map/source-viewport?${new URLSearchParams(raw)}${extra}`, { signal,
    headers: responderAuthorityHeaders({ actorId: user.id, organizationId: user.organizationId }) }));
}
it("runs source indexing, spatial SQL, SDK and the private route without aggregate source reads", async () => {
  const { raw } = await fixture();
  const response = await route(raw), body = await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ version: SOURCE_VIEW_VERSION, mode: "ready", totalRecords: 300, candidateRecords: 300 });
  expect(body.features).toHaveLength(300); expect(body.source.current).toBe(false);
  const zoomed = await (await route({ ...raw, bbox: "-118.901,33.099,-118.879,33.111", zoom: "6" })).json();
  expect(zoomed).toMatchObject({ mode: "ready", totalRecords: 300 });
  expect(zoomed.features.map((x: { position: number }) => x.position)).toEqual([0, 1]);
  expect(zoomed.candidateRecords).toBeLessThan(300);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toContain("Cookie");
  expect(requests).toEqual(["fireafter_read_source_viewport", "fireafter_read_source_viewport"]);
  expect(JSON.stringify(body)).not.toMatch(/gzip|rawPayload|meta_|queue_read|riskLevel|score100/);
});
it("reports dense county views as zoom-required without silently truncating records", async () => {
  const { raw } = await fixture([source(5000)]), body = await (await route(raw)).json();
  expect(body).toMatchObject({ mode: "zoom_required", totalRecords: 5000, candidateRecords: 5000, features: [] });
  const close = await (await route({ ...raw, bbox: "-118.901,33.099,-118.879,33.111", zoom: "8" })).json();
  expect(close).toMatchObject({ mode: "ready", totalRecords: 5000 }); expect(close.features).toHaveLength(2);
});
it("distinguishes an empty view, absent source and invalid persisted geometry", async () => {
  const { raw } = await fixture();
  expect(await (await route({ ...raw, bbox: "-117.1,34.9,-117,35", zoom: "4" })).json()).toMatchObject({ mode: "ready", totalRecords: 300, features: [] });
  expect(await (await route({ ...raw, layer: "usgs-pwfdf" })).json()).toMatchObject({ mode: "unavailable", totalRecords: null, source: null, features: [] });
});
it("retains source warnings when the source has no valid spatial encoding", async () => {
  const invalid = source(); invalid.rawPayload = { geometryVersion: "old", features: [] };
  const { raw } = await fixture([invalid]), body = await (await route(raw)).json();
  expect(body).toMatchObject({ mode: "unavailable", totalRecords: null, features: [], source: { current: false } });
  expect(body.source.warnings.join(" ")).toContain("legacy");
});
it("keeps basin holes and assessment provenance without labelling expired evidence current", async () => {
  const basin = { ...source(), id: "source-basins", sourceKey: "usgs-pwfdf", sourceName: "USGS PWFDF", sourceUrl: "https://earthquake.usgs.gov/",
    rawPayload: { analysisGeometryVersion: PWFDF_ANALYSIS_GEOMETRY_VERSION, assessment: { fireId: "fire-a", fireName: "Fire A", assessmentDate: "2026-09-01" }, basinCount: 1,
      basins: [{ id: "basin-a", fireId: "fire-a", assessmentDate: "2026-09-01", combinedHazard: "High", probabilityClass: "60-80%", volumeClass: "1000-10000",
        geometry: { type: "Polygon", coordinates: [[[-119, 33], [-118, 33], [-118, 34], [-119, 34], [-119, 33]],
          [[-118.8, 33.2], [-118.8, 33.4], [-118.6, 33.4], [-118.6, 33.2], [-118.8, 33.2]]] } }] } };
  const { raw } = await fixture([basin]);
  const body = await (await route({ ...raw, layer: "usgs-pwfdf" })).json();
  expect(body).toMatchObject({ mode: "ready", totalRecords: 1, source: { current: false, timeBasis: "provider" } });
  expect(body.features[0].geometry).toEqual(basin.rawPayload.basins[0].geometry);
});
it.each(["missing-layer", "missing-near-chunk", "missing-distant-chunk", "old-writer", "context", "revision", "duplicate-source"])("fails closed on %s without full-source fallback", async fault => {
  const { raw } = await fixture();
  if (fault === "missing-layer") await sql.db.exec("delete from public.source_map_layers");
  if (fault === "missing-near-chunk") await sql.db.exec("delete from public.source_map_chunks where position=0");
  if (fault === "missing-distant-chunk") await sql.db.exec("delete from public.source_map_chunks where position=(select max(position) from public.source_map_chunks)");
  if (fault === "old-writer") await sql.db.exec("update public.source_snapshots set stale=true");
  if (fault === "context") await sql.db.exec("update public.incidents set location_context='{}'");
  if (fault === "duplicate-source") await sql.db.exec("update public.incidents set selected_fire=jsonb_set(selected_fire,'{inventoryManifest,sourceSnapshotIds}',jsonb_build_array(selected_fire->'inventoryManifest'->'sourceSnapshotIds'->0,selected_fire->'inventoryManifest'->'sourceSnapshotIds'->0))");
  const response = await route({ ...raw, bbox: "-118.901,33.099,-118.879,33.111", revision: fault === "revision" ? "55555555-5555-4555-8555-555555555555" : raw.revision });
  expect(response.status).toBe(409); expect(await response.text()).not.toContain("PRIVATE_DATABASE_DETAIL"); expect(requests).toHaveLength(1);
});
it.each(["gzip", "header", "count", "dropped", "source-metadata", "bbox"])("rejects %s corruption in the SQL response", async fault => {
  const { raw } = await fixture();
  mutate = body => {
    const chunks = body.chunks as Record<string, unknown>[];
    if (fault === "gzip") chunks[0].gzip = "bad!";
    if (fault === "header") chunks[0].hash = "0".repeat(64);
    if (fault === "count") body.candidateRecords = 1;
    if (fault === "dropped") chunks.pop();
    if (fault === "bbox") body.bbox = [-120, 33, -117, 35];
    if (fault === "source-metadata") ((body.model as { projection: Record<string, unknown> }).projection).source_name = "Changed source";
  };
  const response = await route(raw); expect(response.status).toBe(503); expect(await response.text()).not.toContain("Road");
});
it.each(["membership", "organization", "role", "session"])("rejects %s changes", async fault => {
  const { raw } = await fixture();
  if (fault === "membership") await sql.db.exec("delete from public.organization_members");
  if (fault === "role") await sql.db.exec("update public.organization_members set role='viewer'");
  if (fault === "organization") mocks.auth.mockResolvedValue({ ...user, organizationId: "55555555-5555-4555-8555-555555555555" });
  if (fault === "session") mocks.auth.mockResolvedValueOnce(user).mockResolvedValue(null);
  expect((await route(raw)).status).toBe(403);
});
it.each(["anon", "authenticated"])("denies direct source RPC/table access to %s", async role => {
  const result = await sql.db.query(`select has_function_privilege($1,'public.fireafter_read_source_viewport(text,uuid,uuid,text,uuid,double precision[],integer,text)','execute') rpc,
    has_table_privilege($1,'public.source_map_layers','select') layers, has_table_privilege($1,'public.source_map_chunks','select') chunks`, [role]);
  expect(result.rows).toEqual([{ rpc: false, layers: false, chunks: false }]);
});
it("rejects malformed or duplicate queries before auth and stays disabled by default", async () => {
  const raw: SourceViewportQuery = { incidentId: "county", revision: "55555555-5555-4555-8555-555555555555", bbox: "-119,33,-117,35", zoom: "0", layer: "tiger-roads" };
  expect((await route(raw, undefined, "&layer=tiger-roads")).status).toBe(400);
  expect((await route({ ...raw, bbox: "-119,,NaN,35" })).status).toBe(400);
  expect((await route(raw, undefined, "&unexpected=true")).status).toBe(400);
  vi.stubEnv("FIREAFTER_VIEWPORT_MAP_ENABLED", "false"); expect((await route(raw)).status).toBe(503);
  expect(mocks.auth).not.toHaveBeenCalled(); expect(requests).toHaveLength(0);
});
it("binds the client response to the requested source/view and cancels without retry", async () => {
  const { raw } = await fixture(), body = await (await route(raw)).json();
  const fetchImpl = vi.fn().mockResolvedValue(Response.json(body));
  const authority = { actorId: user.id, organizationId: user.organizationId };
  expect(await fetchSourceViewport(raw, authority, new AbortController().signal, fetchImpl)).toEqual(body);
  expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/api/map/source-viewport?"), expect.objectContaining({ cache: "no-store", credentials: "same-origin", headers: responderAuthorityHeaders(authority) }));
  fetchImpl.mockResolvedValue(Response.json({ ...body, revision: "55555555-5555-4555-8555-555555555555" }));
  await expect(fetchSourceViewport(raw, authority, new AbortController().signal, fetchImpl)).rejects.toThrow();
  const controller = new AbortController(); controller.abort(); fetchImpl.mockClear();
  await expect(fetchSourceViewport(raw, authority, controller.signal, fetchImpl)).rejects.toThrow(); expect(fetchImpl).not.toHaveBeenCalled();
});
it.skipIf(process.env.FIREAFTER_SOURCE_VIEWPORT_CAPACITY !== "true")("delivers captured Monterey view through the real source index and API", async () => {
  const captured = JSON.parse(gunzipSync(await readFile("output/verification/monterey-public-lines-exact-county.json.gz")).toString()) as { location: LocationCandidate; roads: Partial<SourceSnapshot>; hydro: Partial<SourceSnapshot> };
  const { raw } = await fixture([{ ...source(), ...captured.roads, id: "roads" }, { ...source(), ...captured.hydro, id: "hydro" }], captured.location);
  const report = [];
  for (const layer of ["tiger-roads", "3dhp-flowlines"] as const) {
    const query = { ...raw, layer, bbox: "-121.58,36.27,-121.51,36.34", zoom: "7" }, started = performance.now();
    const response = await route(query), text = await response.text(), body = JSON.parse(text);
    expect(response.status).toBe(200); expect(body.mode).toBe("ready"); expect(body.features).toHaveLength(layer === "tiger-roads" ? 34 : 186);
    expect(body.totalRecords).toBe(layer === "tiger-roads" ? 17591 : 58682);
    expect(Buffer.byteLength(text)).toBeLessThan(SOURCE_VIEW_BYTES);
    const original = readSourceLineGeometry((layer === "tiger-roads" ? captured.roads : captured.hydro).rawPayload, layer);
    expect(original.warning).toBeUndefined();
    const expected = original.features.flatMap((feature, position) => {
      const points = feature.paths.flat();
      const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
      if (Math.min(...xs) > -121.51 || Math.max(...xs) < -121.58 || Math.min(...ys) > 36.34 || Math.max(...ys) < 36.27) return [];
      return [{ position, sourceFeatureId: feature.id, geometry: { type: "MultiLineString", coordinates: feature.paths } }];
    });
    expect(body.features.map(({ position, sourceFeatureId, geometry }: { position: number; sourceFeatureId: string; geometry: unknown }) => ({ position, sourceFeatureId, geometry }))).toEqual(expected);
    const dbResult = await rpc({ p_incident_id: raw.incidentId, p_actor_id: user.id, p_organization_id: user.organizationId, p_role: user.role,
      p_revision: raw.revision, p_bbox: [-121.58, 36.27, -121.51, 36.34], p_zoom: 7, p_layer: layer });
    expect(projectSourceViewport(dbResult, SourceViewportQuerySchema.parse(query)).features).toEqual(body.features);
    report.push({ layer, responseBytes: Buffer.byteLength(text), elapsedMs: Math.round(performance.now() - started), records: body.features.length, totalRecords: body.totalRecords });
  }
  await writeFile("output/verification/source-viewport-capacity-receipt.json", JSON.stringify({ scope: "Captured public geometry; actual embedded SQL/SDK/API; controlled Auth, not hosted or fresh provider data", report }, null, 2));
  process.stdout.write(JSON.stringify({ event: "source-viewport-capacity", report }) + "\n");
}, 90000);
