import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CurrentUser } from "./auth";
import type { IngestionJob } from "./ingestion-store";
import type { LocationCandidate } from "./types";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), start: vi.fn(), search: vi.fn(), authorization: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/ingestion", () => ({ ingestCounty: vi.fn() }));
vi.mock("./fireafter-data", () => ({ createEmptyDashboardBundle: () => ({ assets: [], recommendations: [], sourceSnapshots: [] }) }));
vi.mock("./fireafter-supabase", () => ({ getIncidentAuthorizationContext: mocks.authorization }));
vi.mock("./live-sources", () => ({ searchLocationsLive: mocks.search }));
vi.mock("./ingestion-store", async importOriginal => ({
  ...await importOriginal<typeof import("./ingestion-store")>(), ingestionRpc: mocks.rpc,
}));
import { enqueueIngestion } from "./ingestion-dispatch";

const operation = "50000000-0000-4000-a000-000000000001";
const user: CurrentUser = { id: "10000000-0000-4000-a000-000000000001", email: "test@example.invalid",
  organizationId: "20000000-0000-4000-a000-000000000001", role: "analyst" };
const location: LocationCandidate = { id: "el-dorado-county-ca", county: "El Dorado County", state: "CA", fips: "06017",
  label: "El Dorado County, CA", centroid: [-120.5, 38.8], fireWeatherZone: "", population: 0, wildfireContext: "Live Census",
  boundary: { type: "Polygon", coordinates: [Array.from({ length: 20_000 }, () => [-120.5, 38.8] as [number, number])] } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockReset();
  mocks.search.mockResolvedValue([location]);
  mocks.rpc.mockImplementation(async (name, args) => name === "fireafter_dispatch_ingestion" ? true : {
    id: args.p_id, actor_id: args.p_actor, organization_id: args.p_org, incident_key: args.p_incident, seed: args.p_seed,
    kind: args.p_kind, stage: "initialize", status: "queued", progress: {}, updated_at: "2026-10-08T00:00:00Z", error_code: null,
  } as IngestionJob);
});
afterEach(() => vi.restoreAllMocks());

it("enqueues a large real-shape county using a compact seed and retains full pending-workspace geometry", async () => {
  expect(Buffer.byteLength(JSON.stringify(location))).toBeGreaterThan(65_536);
  const response = await enqueueIngestion(user, "create", location.id, operation);
  const body = await response.json();
  const seed = mocks.rpc.mock.calls[0][1].p_seed;
  expect(Buffer.byteLength(JSON.stringify(seed))).toBeLessThan(1024);
  expect(seed).toEqual({ location: { id: location.id, county: location.county, state: location.state, fips: location.fips } });
  expect(response.status).toBe(202);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(body.ingestion).toMatchObject({ id: operation, county: location.label, status: "queued", published: false });
  expect(body.workspace.incident.locationContext).toEqual(location);
  expect(body.workspace.assets).toEqual([]);
  expect(mocks.start.mock.calls[0][1]).toEqual([operation]);
});
it("keeps the original operation reference on repeated enqueue requests", async () => {
  await enqueueIngestion(user, "create", location.id, operation);
  await enqueueIngestion(user, "create", location.id, operation);
  const requests = mocks.rpc.mock.calls.filter(([name]) => name === "fireafter_enqueue_ingestion");
  expect(requests).toHaveLength(2);
  expect(requests[0][1]).toEqual(requests[1][1]);
});
it("returns accepted with dispatch pending after an unconfirmed Workflow dispatch", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.start.mockRejectedValueOnce(new Error("dispatch response lost"));
  const response = await enqueueIngestion(user, "create", location.id, operation);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ dispatchPending: true, ingestion: { id: operation } });
});
it("rejects missing write authority, invalid operation identity, and inexact counties before enqueue", async () => {
  await expect(enqueueIngestion({ ...user, role: "viewer" }, "create", location.id, operation)).rejects.toMatchObject({ status: 403 });
  await expect(enqueueIngestion(user, "create", location.id, "invalid")).rejects.toMatchObject({ status: 400 });
  await expect(enqueueIngestion(user, "create", "wrong-county-ca", operation)).rejects.toMatchObject({ status: 400 });
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("retains canonical database identity and organization authorization for refresh", async () => {
  mocks.authorization.mockResolvedValue({ databaseIncidentId: "30000000-0000-4000-a000-000000000001",
    domainIncidentId: "incident-el-dorado-county-ca", organizationId: user.organizationId });
  const response = await enqueueIngestion(user, "refresh", "incident-el-dorado-county-ca", operation);
  expect(mocks.rpc.mock.calls[0][1].p_seed).toEqual({ targetId: "30000000-0000-4000-a000-000000000001" });
  expect((await response.json()).workspace).toBeUndefined();
  mocks.rpc.mockClear();
  mocks.authorization.mockResolvedValue({ organizationId: "other" });
  await expect(enqueueIngestion(user, "refresh", "incident-el-dorado-county-ca", operation)).rejects.toMatchObject({ status: 404 });
  expect(mocks.rpc).not.toHaveBeenCalled();
});
