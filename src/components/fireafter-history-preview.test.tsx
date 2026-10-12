// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FireAfterDashboard } from "./fireafter-dashboard";
import type { ComponentProps } from "react";

vi.mock("next/navigation", () => ({ usePathname: () => "/history" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("FA10-C2 labels the capped public history as a recent preview", () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({}))));
  const bundle: ComponentProps<typeof FireAfterDashboard>["bundle"] = {
    incident: { id: "history-county", locationId: "county", county: "County", state: "CA", title: "History",
      code: "FA", status: "Stale Data", stormWindow: "Unknown", rainfallForecast: "Unavailable", lastRefresh: "Never",
      dataFreshness: "Low", activeAlerts: 0, selectedFire: { name: "Fire", acres: 0, perimeterUpdated: "Unknown", source: "WFIGS" } },
    locations: [], assets: [], sourceSnapshots: [], recommendations: [], actions: [],
    auditEvents: [{ id: "audit-1", incidentId: "history-county", eventType: "SourcesRefreshed", actorName: "FireAfter",
      summary: "Refreshed", createdAt: "2026-09-14T00:00:00Z", payload: {} }],
  };
  render(<FireAfterDashboard initialView="history" bundle={bundle} />);
  expect(screen.queryByText(/Showing all responder decision records/)).toBeNull();
  expect(screen.getByText(/Recent history preview/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "History & Audit" }).getAttribute("href")).toBe("/history?incidentId=history-county");
});
