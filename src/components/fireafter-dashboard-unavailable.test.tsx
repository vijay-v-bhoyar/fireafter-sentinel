// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FireAfterDashboard } from "./fireafter-dashboard";
import { inventoryUser } from "../test/asset-page-fixture";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({}))));
});

function unavailableBundle(): ComponentProps<typeof FireAfterDashboard>["bundle"] {
  return {
    dataAvailability: "unavailable",
    incident: {
      id: "no-incident-selected", locationId: "unselected", county: "No county selected", state: "US",
      title: "Search a county to start", code: "FA-UNSELECTED", status: "Monitoring",
      stormWindow: "No active storm window", rainfallForecast: "Not available", lastRefresh: "Never",
      dataFreshness: "Low", activeAlerts: 0,
      selectedFire: { name: "No fire context selected", acres: 0, perimeterUpdated: "Not available", source: "No source selected", coverageStatus: "not_available" },
      coverageStatus: "not_available",
    },
    locations: [], assets: [], sourceSnapshots: [], recommendations: [], actions: [], auditEvents: [],
  };
}

it("labels a read failure without blaming the database or presenting fabricated data", () => {
  render(<FireAfterDashboard bundle={unavailableBundle()} initialView="queue" />);

  const alert = screen.getByRole("alert", { name: "Live incident data unavailable" });
  expect(alert.textContent).toContain("No live incident, source, asset, recommendation, action, or audit data is loaded.");
  expect(alert.textContent).not.toContain("Supabase");
  expect(screen.getByRole("button", { name: "Retry loading live data" })).toBeTruthy();
  expect(screen.queryByText("Very High")).toBeNull();
});

it("directs a missing saved incident to county search rather than the same missing inventory", () => {
  const bundle = unavailableBundle();
  bundle.incident.id = "incident-utah-county-ut";
  bundle.dataUnavailableReason = "not-found";
  bundle.currentUser = inventoryUser;
  render(<FireAfterDashboard bundle={bundle} initialView="queue" />);

  const alert = screen.getByRole("alert", { name: "Saved incident unavailable" });
  expect(alert.textContent).toContain("No other county has been loaded in its place.");
  expect(alert.textContent).not.toContain("Supabase");
  expect(screen.getByRole("link", { name: "Search for a county" }).getAttribute("href")).toBe("#county-search");
  expect(screen.getByRole("textbox", { name: "Search any U.S. county" }).id).toBe("county-search");
  expect(screen.queryByRole("button", { name: "Retry loading live data" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Browse saved assets one page at a time" })).toBeNull();
  expect(screen.queryByText("Very High")).toBeNull();
});

it("offers sign-in with the original incident reference when access was denied", () => {
  const bundle = unavailableBundle();
  bundle.incident.id = "incident-utah-county-ut";
  bundle.dataUnavailableReason = "access-denied";
  bundle.currentUser = inventoryUser;
  render(<FireAfterDashboard bundle={bundle} initialView="queue" />);

  expect(screen.getByRole("alert", { name: "Incident access unavailable" }).textContent).toContain("organization access");
  expect(screen.getByRole("link", { name: "Sign in with an authorized account" }).getAttribute("href"))
    .toBe("/login?returnTo=%2F%3FincidentId%3Dincident-utah-county-ut");
  expect(screen.getByRole("button", { name: "Retry loading live data" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Browse saved assets one page at a time" })).toBeNull();
});

it("retains bounded asset browsing for an unclassified read failure", () => {
  const bundle = unavailableBundle();
  bundle.incident.id = "incident-utah-county-ut";
  bundle.currentUser = inventoryUser;
  render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
  expect(screen.getByRole("link", { name: "Browse saved assets one page at a time" }).getAttribute("href"))
    .toBe("/assets/browse?incidentId=incident-utah-county-ut");
});
