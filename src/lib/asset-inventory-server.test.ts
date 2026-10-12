import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = { id: id(1), organizationId: id(2), role: "analyst" as const, email: "test@example.test" };
const revision = id(3), incidentId = id(4);
const query = { incidentId: "county", start: "0", limit: "25" as const };
function asset(n: number) {
  return { id: id(n + 100), incident_id: incidentId, name: `Bridge ${n}`, asset_type: "Bridge", location_label: "Creek",
    source: "National Bridge Inventory", confidence: "Medium", local_or_uploaded: false, source_feature_ids: [String(n)],
    properties: { domainAssetId: `bridge-${n}`, coordinates: [-119.2, 34.4], evidence: [], metrics: {} } };
}
function parent(count: number) {
  return { id: incidentId, organization_id: user.organizationId, title: "County inventory", county: "Ventura County", state: "CA",
    status: "Stale Data", storm_window: "Next 48-72 hrs", last_refresh: "2026-10-08T00:00:00Z",
    selected_fire: { domainIncidentId: "county", inventoryManifest: { version: "2026-09-13-inventory-v1", revision,
      assetIds: Array.from({ length: count }, (_, n) => id(n + 100)), recommendationIds: [], sourceSnapshotIds: [] } },
    location_context: { id: "ventura-ca", county: "Ventura County", state: "CA", label: "Ventura County, CA",
      centroid: [-119.2, 34.4], bbox: [-119.6, 34, -118.6, 34.7], fips: "06111", fireWeatherZone: "auto", population: 1, wildfireContext: "County context" } };
}
type Options = { count?: number; cap?: number; mutateRow?: (row: ReturnType<typeof asset>) => unknown;
  mutateParent?: (row: ReturnType<typeof parent>, read: number) => unknown;
  mutateResult?: (rows: unknown[], count: number) => { rows: unknown[]; count: number }; delay?: number };
async function fixture(options: Options = {}) {
  const count = options.count ?? 26, requests: URL[] = [], timers: ReturnType<typeof setTimeout>[] = [];
  let parentReads = 0, bytes = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost"); requests.push(url);
    expect(request.method).toBe("GET");
    let rows: unknown[], total: number;
    if (url.pathname === "/rest/v1/incidents") {
      rows = [options.mutateParent?.(parent(count), ++parentReads) ?? parent(count)]; total = 1;
    } else {
      expect(url.pathname).toBe("/rest/v1/assets");
      expect(url.searchParams.get("incident_id")).toBe(`eq.${incidentId}`);
      expect(url.searchParams.get("order")).toBe("id.asc");
      expect(request.headers.prefer).toContain("count=exact");
      const ids = url.searchParams.get("id")!.slice(4, -1).split(",");
      expect(ids.length).toBeLessThanOrEqual(50);
      expect(url.searchParams.get("limit")).toBe(String(ids.length));
      total = ids.length;
      rows = ids.slice(0, options.cap ?? 50).map(value => { const row = asset(Number(value.slice(-12)) - 100); return options.mutateRow?.(row) ?? row; });
      const changed = options.mutateResult?.(rows, total); if (changed) { rows = changed.rows; total = changed.count; }
    }
    const json = JSON.stringify(rows); bytes += Buffer.byteLength(json);
    const send = () => { if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json", "content-range": `0-${Math.max(0, rows.length - 1)}/${total}` }); response.end(json); } };
    if (options.delay && url.pathname.endsWith("/assets")) timers.push(setTimeout(send, options.delay)); else send();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_TARGET_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("SENTINEL_PROTECTED_SUPABASE_URLS", "https://protected-fireafter.supabase.co");
  vi.stubEnv("SENTINEL_ALLOW_LOCAL_DB", "true");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-fixture-only");
  vi.stubEnv("FIREAFTER_SUPABASE_TIMEOUT_MS", "60000");
  return { requests, bytes: () => bytes, close: async () => { timers.forEach(clearTimeout); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
beforeEach(() => { vi.resetModules(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("browses every manifest position exactly once across capped provider pages", async () => {
  const server = await fixture({ cap: 7 });
  try {
    const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    const first = await read(query, user), last = await read({ ...query, start: String(first.nextStart), revision: first.revision }, user);
    expect(first.items).toHaveLength(25); expect(last.items).toHaveLength(1); expect(last.nextStart).toBeNull();
    expect([...first.items, ...last.items].map(item => item.position)).toEqual(Array.from({ length: 26 }, (_, n) => n + 1));
    expect(first.items[0]).toMatchObject({ status: "available", asset: { id: "bridge-0", coordinates: [-119.2, 34.4] } });
    expect(server.requests.filter(url => url.pathname.endsWith("/assets"))).toHaveLength(5);
    expect(JSON.stringify(first)).not.toContain("metrics");
  } finally { await server.close(); }
});
it("reads the last page of a 100000-ID manifest without reading other asset rows", async () => {
  const server = await fixture({ count: 100000 });
  try {
    const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    const page = await read({ ...query, start: "99999", revision }, user);
    expect(page.totalStoredAssets).toBe(100000); expect(page.items[0]).toMatchObject({ position: 100000, asset: { id: "bridge-99999" } });
    expect(server.requests.filter(url => url.pathname.endsWith("/assets"))).toHaveLength(1);
    expect(server.requests).toHaveLength(3);
  } finally { await server.close(); }
});
it("supports a verified empty manifest without an asset read", async () => {
  const server = await fixture({ count: 0 });
  try { const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    expect(await read(query, user)).toMatchObject({ items: [], totalStoredAssets: 0, nextStart: null }); expect(server.requests).toHaveLength(2);
  } finally { await server.close(); }
});
it.each(["outside-county", "unverified-geometry", "non-operational"])("retains the slot while withholding %s records", async reason => {
  const server = await fixture({ count: 1, mutateRow: row => ({ ...row, properties: { ...row.properties,
    ...(reason === "outside-county" ? { coordinates: [-80, 40] } : reason === "unverified-geometry" ? { coordinates: null } : { nonOperational: true }) } }) });
  try { const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    expect((await read(query, user)).items).toEqual([{ position: 1, status: "withheld", reason }]);
  } finally { await server.close(); }
});
it.each(["foreign", "duplicate", "count", "empty"])("rejects %s page corruption, not a partial page", async defect => {
  const server = await fixture({ mutateResult: (rows, count) => ({ count: defect === "count" ? count - 1 : count,
    rows: defect === "empty" ? [] : defect === "duplicate" ? [rows[0], rows[0]] : defect === "foreign" ? [{ ...asset(0), incident_id: id(9) }] : rows }) });
  try { const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    await expect(read(query, user)).rejects.toMatchObject({ code: "read_invalid" });
  } finally { await server.close(); }
});
it.each(["organization", "revision", "alias"])("rejects a concurrent %s change", async field => {
  const server = await fixture({ mutateParent: (row, n) => n === 1 ? row : { ...row,
    ...(field === "organization" ? { organization_id: id(9) } : field === "alias" ? { id: id(9) } : { selected_fire: { ...row.selected_fire,
      inventoryManifest: { ...row.selected_fire.inventoryManifest, revision: id(9) } } }) } });
  try { const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    await expect(read(query, user)).rejects.toMatchObject({ status: field === "revision" ? 409 : 403 });
  } finally { await server.close(); }
});
it.each(["membership", "role", "stale", "offset", "manifest"])("denies %s before querying assets", async defect => {
  const server = await fixture({ mutateParent: row => defect === "manifest" ? { ...row, selected_fire: { domainIncidentId: "county" } } : row });
  try { const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    await expect(read({ ...query, ...(defect === "stale" ? { revision: id(9) } : defect === "offset" ? { start: "99999", revision } : {}) },
      { ...user, ...(defect === "membership" ? { organizationId: id(9) } : defect === "role" ? { role: "viewer" as const } : {}) })).rejects.toBeTruthy();
    expect(server.requests.some(url => url.pathname.endsWith("/assets"))).toBe(false);
  } finally { await server.close(); }
});
it("rejects an oversized page instead of trimming its records", async () => {
  const server = await fixture({ count: 1, mutateRow: row => ({ ...row, name: "x".repeat(4 * 1024 * 1024) }) });
  try { const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    await expect(read(query, user)).rejects.toMatchObject({ status: 503 });
  } finally { await server.close(); }
});
it("uses exact county holes, not just the county envelope", async () => {
  const server = await fixture({ count: 1, mutateParent: row => ({ ...row, location_context: { ...row.location_context,
    providerKey: "tigerweb", boundary: { type: "Polygon", coordinates: [
      [[-119.6, 34], [-118.6, 34], [-118.6, 34.7], [-119.6, 34.7], [-119.6, 34]],
      [[-119.3, 34.3], [-119.3, 34.5], [-119.1, 34.5], [-119.1, 34.3], [-119.3, 34.3]],
    ] } } }) });
  try { const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    expect((await read(query, user)).items).toEqual([{ position: 1, status: "withheld", reason: "outside-county" }]);
  } finally { await server.close(); }
});
it("withholds invalid uploaded geometry rather than trusting its saved point", async () => {
  const server = await fixture({ count: 1, mutateRow: row => ({ ...row, local_or_uploaded: true,
    geometry_geojson: { type: "Polygon", coordinates: [] } }) });
  try { const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    expect((await read(query, user)).items).toEqual([{ position: 1, status: "withheld", reason: "unverified-geometry" }]);
  } finally { await server.close(); }
});
it("aborts a stalled provider within the whole-page deadline with no retry", async () => {
  const server = await fixture({ delay: 30000 });
  try { const { getSupabaseAssetInventoryPage: read } = await import("./fireafter-supabase");
    const started = performance.now(); await expect(read(query, user)).rejects.toBeTruthy();
    expect(performance.now() - started).toBeLessThan(19000); expect(server.requests).toHaveLength(2);
  } finally { await server.close(); }
}, 22000);
