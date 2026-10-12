import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), bundle: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/fireafter-data", () => ({ getClientDashboardBundle: mocks.bundle }));
vi.mock("@/components/asset-inventory-browser", () => ({ AssetInventoryBrowser: () => null }));
import Page from "./page";
import { AssetInventoryBrowser } from "@/components/asset-inventory-browser";
import { inventoryUser } from "@/test/asset-page-fixture";
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue(inventoryUser); });
afterEach(() => vi.unstubAllEnvs());
it("renders explicit county access without loading the full dashboard", async () => {
  const view = await Page({ searchParams: Promise.resolve({ incidentId: "county" }) });
  expect(view.type).toBe(AssetInventoryBrowser); expect(view.props.incidentId).toBe("county"); expect(mocks.bundle).not.toHaveBeenCalled();
});
it("uses only the configured default when no county is requested", async () => {
  vi.stubEnv("FIREAFTER_DEFAULT_INCIDENT_ID", "pinned-county");
  expect((await Page({ searchParams: Promise.resolve({}) })).props.incidentId).toBe("pinned-county");
  expect(mocks.bundle).not.toHaveBeenCalled();
});
it.each([null, { ...inventoryUser, role: "viewer" }])("does not mount the protected browser for unauthorized users", async user => {
  mocks.user.mockResolvedValue(user); expect((await Page({ searchParams: Promise.resolve({ incidentId: "county" }) })).type).toBe("main");
  expect(mocks.bundle).not.toHaveBeenCalled();
});
it.each(["", " ", ["a", "b"], "x".repeat(257)])("rejects malformed incident references before authentication", async incidentId => {
  expect((await Page({ searchParams: Promise.resolve({ incidentId }) })).type).toBe("main"); expect(mocks.user).not.toHaveBeenCalled();
});
