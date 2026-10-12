import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bundle: vi.fn(), map: vi.fn() }));
vi.mock("@/lib/fireafter-data", () => ({ getClientDashboardBundle: mocks.bundle }));
vi.mock("@/lib/queue-dashboard-server", () => ({ getQueueDashboardBundle: mocks.bundle, getMapDashboardBundle: mocks.map }));
vi.mock("@/components/fireafter-dashboard", () => ({ FireAfterDashboard: () => null }));

import Home from "./page";
import MapPage from "./map/page";
import AssetsPage from "./assets/page";
import SettingsPage from "./settings/page";
import { FireAfterDashboard } from "@/components/fireafter-dashboard";
import { queueBundle } from "../test/queue-page-fixture";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bundle.mockResolvedValue({ incident: { id: "no-incident-selected" }, dataAvailability: "unavailable" });
  mocks.map.mockImplementation(id => mocks.bundle(id));
});

it("passes the explicit unavailable public bundle to the dashboard", async () => {
  const element = await Home({});

  expect(mocks.bundle).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(element.type).toBe(FireAfterDashboard);
  expect(element.props).toMatchObject({ initialView: "queue", bundle: { dataAvailability: "unavailable" } });
});

it.each([Home, MapPage])("remounts paged state when identity, organization, role or publication changes on %s", async Page => {
  const bundle = queueBundle(); mocks.bundle.mockResolvedValue(bundle); const initial = await Page({});
  for (const changed of [
    { ...bundle, currentUser: { ...bundle.currentUser!, id: "other" } },
    { ...bundle, currentUser: { ...bundle.currentUser!, organizationId: "other" } },
    { ...bundle, currentUser: { ...bundle.currentUser!, role: "viewer" } },
    { ...bundle, queuePage: { ...bundle.queuePage!, revision: "other" } },
  ]) { mocks.bundle.mockResolvedValue(changed); expect((await Page({})).key).not.toBe(initial.key); }
});

const pages = [[Home, "queue"], [MapPage, "map"], [AssetsPage, "assets"], [SettingsPage, "settings"]] as const;
it.each(pages)("loads the selected incident for %s instead of the default", async (Page, initialView) => {
  const bundle = { incident: { id: "incident-okanogan-county-wa" } };
  mocks.bundle.mockResolvedValue(bundle);
  const element = await Page({ searchParams: Promise.resolve({ incidentId: bundle.incident.id }) });
  expect(mocks.bundle).toHaveBeenCalledExactlyOnceWith(bundle.incident.id);
  expect(element.type).toBe(FireAfterDashboard);
  expect(element.key).toBe(bundle.incident.id);
  expect(element.props).toEqual({ bundle, initialView });
  if (initialView === "map") expect(mocks.map).toHaveBeenCalledExactlyOnceWith(bundle.incident.id);
  else expect(mocks.map).not.toHaveBeenCalled();
});
it.each(pages)("retains the default only for an unscoped %s visit", async Page => {
  await Page({ searchParams: Promise.resolve({}) });
  expect(mocks.bundle).toHaveBeenCalledExactlyOnceWith(undefined);
});
it.each(pages)("rejects malformed references without substituting another county on %s", async Page => {
  for (const incidentId of ["", " ", ["a", "b"], "x".repeat(257)]) {
    const element = await Page({ searchParams: Promise.resolve({ incidentId }) });
    expect(element.type).toBe("main");
    expect(mocks.bundle).not.toHaveBeenCalled();
  }
});
it.each(pages)("preserves an unavailable scoped bundle on %s", async Page => {
  const bundle = { incident: { id: "missing-county" }, dataAvailability: "unavailable" };
  mocks.bundle.mockResolvedValue(bundle);
  const element = await Page({ searchParams: Promise.resolve({ incidentId: "missing-county" }) });
  expect(mocks.bundle).toHaveBeenCalledExactlyOnceWith("missing-county");
  expect(element.props.bundle).toBe(bundle);
});
