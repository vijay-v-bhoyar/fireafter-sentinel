import { beforeEach, expect, it, vi } from "vitest";
import Link from "next/link";
const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), bundle: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/fireafter-data", () => ({ getClientDashboardBundle: mocks.bundle }));
vi.mock("@/components/history-explorer", () => ({ HistoryExplorer: () => null }));
vi.mock("@/components/fireafter-dashboard", () => ({ FireAfterDashboard: () => null }));
import HistoryPage from "./page";
import { HistoryExplorer } from "@/components/history-explorer";
import { FireAfterDashboard } from "@/components/fireafter-dashboard";
beforeEach(() => { vi.clearAllMocks(); mocks.bundle.mockResolvedValue({}); });
it("keeps private retained history reachable without reading corrupt current inventory", async () => {
  const user = { id: "actor", organizationId: "org", role: "analyst" };
  mocks.currentUser.mockResolvedValue(user); mocks.bundle.mockRejectedValue(new Error("uploaded_geometry_invalid"));
  const element = await HistoryPage({ searchParams: Promise.resolve({ incidentId: "county" }) });
  expect(element.type).toBe(HistoryExplorer); expect(element.props).toEqual({ incidentId: "county", user }); expect(mocks.bundle).not.toHaveBeenCalled();
});
it.each([null, { id: "viewer", organizationId: "org", role: "viewer" }])("preserves the existing public redacted recent preview", async user => {
  mocks.currentUser.mockResolvedValue(user);
  const element = await HistoryPage({ searchParams: Promise.resolve({ incidentId: "county" }) });
  expect(element.type).toBe(FireAfterDashboard); expect(mocks.bundle).toHaveBeenCalledExactlyOnceWith("county");
});
it.each(["", ["first", "second"], "x".repeat(257)])("does not silently substitute the default incident for invalid input", async incidentId => {
  const element = await HistoryPage({ searchParams: Promise.resolve({ incidentId }) });
  expect(element.type).toBe("main"); expect(mocks.currentUser).not.toHaveBeenCalled(); expect(mocks.bundle).not.toHaveBeenCalled();
  const link = element.props.children.at(-1);
  expect(link.type).toBe(Link); expect(link.props.href).toBe("/");
});

it("opens unscoped private history for the dashboard's actual incident", async () => {
  const user = { id: "actor", organizationId: "org", role: "incident_commander" };
  mocks.currentUser.mockResolvedValue(user);
  mocks.bundle.mockResolvedValue({ incident: { id: "incident-monterey-county-ca" } });
  const element = await HistoryPage({ searchParams: Promise.resolve({}) });
  expect(mocks.bundle).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(element.type).toBe(HistoryExplorer);
  expect(element.props).toEqual({ incidentId: "incident-monterey-county-ca", user });
});

it("shows the unavailable workspace instead of querying invented county history", async () => {
  mocks.currentUser.mockResolvedValue({ id: "actor", organizationId: "org", role: "incident_commander" });
  const bundle = { incident: { id: "no-incident-selected" }, dataAvailability: "unavailable" };
  mocks.bundle.mockResolvedValue(bundle);
  const element = await HistoryPage({ searchParams: Promise.resolve({}) });
  expect(element.type).toBe(FireAfterDashboard);
  expect(element.props).toEqual({ bundle, initialView: "history" });
});

it.each([null, { id: "viewer", organizationId: "org", role: "viewer" }])("keeps unscoped public history on the redacted dashboard", async user => {
  mocks.currentUser.mockResolvedValue(user);
  const bundle = { incident: { id: "incident-monterey-county-ca" } };
  mocks.bundle.mockResolvedValue(bundle);
  const element = await HistoryPage({ searchParams: Promise.resolve({}) });
  expect(element.type).toBe(FireAfterDashboard);
  expect(element.props.bundle).toBe(bundle);
});
