import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), full: vi.fn(), page: vi.fn() }));
vi.mock("./auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("./fireafter-data", () => ({ getClientDashboardBundle: mocks.full, createEmptyDashboardBundle: (id: string) => ({ incident: { id }, recommendations: [], assets: [], sourceSnapshots: [] }) }));
vi.mock("./fireafter-supabase", () => ({ getSupabaseQueuePage: mocks.page }));
import { getMapDashboardBundle, getQueueDashboardBundle } from "./queue-dashboard-server";
import { QueuePageError } from "./queue-page-contract";
import { QueueSourceReadError } from "./queue-source-read-model";
import { queueBundle, queuePage } from "../test/queue-page-fixture";
import { inventoryUser as user } from "../test/asset-page-fixture";
import type { LocationCandidate } from "./types";
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue(user); const bundle = queueBundle(); mocks.page.mockResolvedValue({ page: bundle.queuePage, incident: bundle.incident, sourceSnapshots: bundle.sourceSnapshots }); mocks.full.mockResolvedValue({ legacy: true }); });
it("uses the bounded page for the main signed-in dashboard, retaining responder authority", async () => {
  const result = await getQueueDashboardBundle("county"); expect(result.queuePage).toMatchObject({ totalStored: 26 }); expect(result.recommendations).toHaveLength(10);
  expect(result.currentUser).toEqual(user); expect(result.sensitiveInfrastructureAccess).toBe(true); expect(result.incident.recoveryScopeId).toBeTruthy();
  expect(mocks.full).not.toHaveBeenCalled(); expect(mocks.user).toHaveBeenCalledTimes(2);
});
it.each([null, { ...user, role: "viewer" }])("preserves the existing public/readonly projection", async actor => {
  mocks.user.mockResolvedValue(actor);
  for (const read of [getQueueDashboardBundle, getMapDashboardBundle]) {
    expect(await read("county")).toEqual({ legacy: true });
  }
  expect(mocks.page).not.toHaveBeenCalled(); expect(mocks.full).toHaveBeenCalledTimes(2); expect(mocks.full).toHaveBeenCalledWith("county");
});
it.each([getQueueDashboardBundle, getMapDashboardBundle])("allows a legacy read only for explicitly unsupported publication metadata on %s", async read => {
  mocks.page.mockRejectedValue(new QueuePageError(409, "Legacy", "QP_LEGACY")); await read("county"); expect(mocks.full).toHaveBeenCalledWith("county");
});
it.each([new Error("PRIVATE"), new QueuePageError(403), new QueuePageError(409)])("never substitutes a full inventory after a bounded read fails", async error => {
  mocks.page.mockRejectedValue(error); const result = await getQueueDashboardBundle("county"); expect(result.dataAvailability).toBe("unavailable"); expect(result.recommendations).toEqual([]); expect(mocks.full).not.toHaveBeenCalled();
});
it.each([getQueueDashboardBundle, getMapDashboardBundle])("distinguishes unavailable incidents and access failures without leaking diagnostics on %s", async read => {
  for (const [error, reason] of [
    [new QueueSourceReadError(404, "PRIVATE missing row"), "not-found"],
    [new QueueSourceReadError(403, "PRIVATE organization"), "access-denied"],
    [new QueuePageError(403, "PRIVATE role"), "access-denied"],
    [new QueuePageError(409, "PRIVATE revision"), undefined],
    [new QueueSourceReadError(503, "PRIVATE upstream"), undefined],
    [Object.assign(new Error("PRIVATE network"), { status: 404 }), undefined],
  ] as const) {
    mocks.page.mockRejectedValue(error);
    const result = await read("incident-utah-county-ut");
    expect(result.dataAvailability).toBe("unavailable");
    expect(result.dataUnavailableReason).toBe(reason);
    expect(result.incident.id).toBe("incident-utah-county-ut");
    expect(result.assets).toEqual([]);
    expect(result.recommendations).toEqual([]);
    expect(result.queuePage).toBeUndefined();
    expect(result.sensitiveInfrastructureAccess).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  }
  expect(mocks.full).not.toHaveBeenCalled();
});
it("withholds exact records after role changes during the read", async () => {
  mocks.user.mockResolvedValueOnce(user).mockResolvedValue({ ...user, role: "viewer" }); const result = await getQueueDashboardBundle("county");
  expect(result.dataAvailability).toBe("unavailable"); expect(result.dataUnavailableReason).toBe("access-denied"); expect(result.queuePage).toBeUndefined(); expect(mocks.full).not.toHaveBeenCalled();
});
it("keeps withheld records in the published total without exposing a replacement", async () => {
  const page = queuePage(); page.items[0] = { position: 1, status: "withheld", reason: "outside-county" };
  mocks.page.mockResolvedValue({ page, incident: queueBundle().incident, sourceSnapshots: queueBundle().sourceSnapshots });
  const result = await getQueueDashboardBundle("county"); expect(result.recommendations).toHaveLength(9); expect(result.queuePage?.totalStored).toBe(26);
});
it("does not send the full county polygon to the paged client or mutate server context", async () => {
  const bundle = queueBundle();
  const boundary: LocationCandidate["boundary"] = { type: "Polygon", coordinates: [[[-119, 34], [-118, 34], [-118, 35], [-119, 34]]] };
  bundle.incident.locationContext = { id: "county", county: "County", state: "CA", label: "County, CA", centroid: [-118.5, 34.5], fips: "06037", fireWeatherZone: "", population: 0, wildfireContext: "Published context", boundary };
  mocks.page.mockResolvedValue({ page: bundle.queuePage, incident: bundle.incident, sourceSnapshots: bundle.sourceSnapshots });
  const result = await getQueueDashboardBundle("county"); expect(result.incident.locationContext?.boundary).toBeUndefined(); expect(result.locations[0].boundary).toBeUndefined();
  expect(bundle.incident.locationContext?.boundary).toEqual(boundary); expect(result.locations[0].centroid).toEqual([-118.5, 34.5]);
});
it("retains the validated polygon only for map SSR without reading the whole inventory", async () => {
  const bundle = queueBundle(), boundary: LocationCandidate["boundary"] = { type: "Polygon", coordinates: [[[-119, 34], [-118, 34], [-118, 35], [-119, 34]]] };
  bundle.incident.locationContext = { id: "county", county: "County", state: "CA", label: "County, CA", centroid: [-118.5, 34.5], fips: "06037", fireWeatherZone: "", population: 0, wildfireContext: "Published context", boundary };
  mocks.page.mockResolvedValue({ page: bundle.queuePage, incident: bundle.incident, sourceSnapshots: bundle.sourceSnapshots });
  const result = await getMapDashboardBundle("county");
  expect(result.incident.locationContext?.boundary).toEqual(boundary); expect(result.queuePage?.totalStored).toBe(26);
  expect(result.recommendations).toHaveLength(10); expect(result.assets).toEqual([]); expect(result.actions).toEqual([]);
  expect(mocks.page).toHaveBeenCalledExactlyOnceWith({ incidentId: "county", start: "0", limit: "10" }, user); expect(mocks.full).not.toHaveBeenCalled();
});
it.each([new Error("PRIVATE"), new QueuePageError(403), new QueuePageError(409)])("does not expand a failed map shell into a full inventory download", async error => {
  mocks.page.mockRejectedValue(error); const result = await getMapDashboardBundle("county");
  expect(result.dataAvailability).toBe("unavailable"); expect(result.recommendations).toEqual([]); expect(mocks.full).not.toHaveBeenCalled();
});
it("withholds the map shell after role revocation during its read", async () => {
  mocks.user.mockResolvedValueOnce(user).mockResolvedValue({ ...user, role: "viewer" });
  const result = await getMapDashboardBundle("county"); expect(result.dataAvailability).toBe("unavailable"); expect(result.queuePage).toBeUndefined(); expect(mocks.full).not.toHaveBeenCalled();
});
