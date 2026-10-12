// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FireAfterDashboard } from "./fireafter-dashboard";
import { SCORING_VERSION } from "@/lib/scoring";
import { webcrypto } from "node:crypto";
import { createTestStorage, createTestLocks } from "../test/browser-storage";

const navigation = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const revision = "0ca1f8d8-a8bb-440a-a4bf-ddbbf31a0069";
const bundle: ComponentProps<typeof FireAfterDashboard>["bundle"] = {
  incident: { id: "test-incident", recoveryScopeId: "10000000-0000-4000-8000-000000000001", locationId: "test-county", county: "Test County", state: "CA",
    title: "Command tests", code: "TEST", status: "Stale Data", stormWindow: "Unknown",
    rainfallForecast: "Unavailable", lastRefresh: "2026-09-13T12:00:00Z", dataFreshness: "Low", activeAlerts: 0,
    selectedFire: { name: "Test fire", acres: 100, perimeterUpdated: "2026-09-13T12:00:00Z", source: "WFIGS" } },
  assets: [], sourceSnapshots: [], actions: [], auditEvents: [], locations: [],
  currentUser: { id: "00000000-0000-4000-8000-000000000001", email: "test@example.com", organizationId: "test-org", role: "analyst" },
  recommendations: [{ id: "test-recommendation", incidentId: "test-incident", assetId: "test-asset",
    inventoryRevision: revision, assetName: "Test crossing", assetType: "Road Crossing", locationLabel: "Test County",
    coordinates: [-119, 35], recommendedAction: "Review evidence", finalScore: 0.8, score100: 80,
    riskLevel: "Unknown", confidenceLevel: "Low", reasonCodes: [], limitations: [], changedSinceLastRefresh: "Updated",
    sourcesUpdatedLabel: "Unavailable", dataFreshnessHours: 10, createdAt: "2026-09-13T12:00:00Z",
    scoreBreakdown: { scoringVersion: SCORING_VERSION, scoreBasis: "review-only", rainfallThreat: 0.8,
      burnSeverity: 0.8, slopeTerrain: 0.8, downstreamExposure: 0.8, dataFreshness: 0,
      confidenceMultiplier: 0.2, baseScore: 0.8, finalScore: 0.8 } }],
};
const actionFetch = vi.fn();
const storage = createTestStorage();
const authority = vi.hoisted(() => ({ authorize: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  AuthError: class extends Error {
    constructor(message: string, readonly status = 401) { super(message); }
  }, requireRecommendationAccess: authority.authorize,
}));
vi.mock("@/lib/fireafter-data", () => ({ recordResponderAction: authority.record }));
beforeEach(() => {
  navigation.pathname = "/";
  window.history.replaceState(null, "", "/");
  storage.clear();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { locks: createTestLocks() });
  vi.stubGlobal("crypto", webcrypto);
  actionFetch.mockReset();
  authority.authorize.mockReset();
  authority.record.mockReset();
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url === "/api/actions"
    ? actionFetch(url, init) : Promise.resolve(Response.json({}))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("FA10 displayed revision and uncertain command journey", () => {
  it("keeps every workspace link scoped to the displayed incident", () => {
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    for (const [label, path] of [["Action Queue", "/"], ["Map View", "/map"], ["Assets", "/assets"], ["History & Audit", "/history"], ["Settings", "/settings"], ["Feature Graph", "/features"]]) {
      expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(`${path}?incidentId=test-incident`);
    }
  });
  it("allows the full responder role to wrap inside a narrow account tile", () => {
    render(<FireAfterDashboard bundle={{ ...bundle, currentUser: { ...bundle.currentUser!, role: "incident_commander" } }} initialView="queue" />);
    expect(screen.getByText("incident_commander").className).toContain("[overflow-wrap:anywhere]");
  });
  it("does not advertise an unimplemented MTBS severity adapter in Settings", () => {
    navigation.pathname = "/settings";
    render(<FireAfterDashboard bundle={bundle} initialView="settings" />);
    expect(screen.getByText("MTBS currently supplies county boundary context only, not measured burn severity. Selected-fire-linked severity integration remains unavailable.")).toBeTruthy();
    expect(screen.queryByText(/burn severity is used when published/)).toBeNull();
  });
  it("pins a successfully opened county in the URL without repeating the write", async () => {
    window.history.replaceState(null, "", "/?view=rehearsal#queue");
    const next = { ...bundle, incident: { ...bundle.incident, id: "incident-okanogan-county-wa", title: "Okanogan Fire" }, recommendations: [] };
    const open = vi.fn(async () => Response.json(next));
    vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/incident" ? open() : Promise.resolve(Response.json({}))));
    render(<FireAfterDashboard bundle={{ ...bundle, locations: [{ id: "okanogan-county-wa", label: "Okanogan County, WA", county: "Okanogan County", state: "WA", centroid: [-119.7, 48.5], wildfireContext: "Public county", fips: "53047", fireWeatherZone: "", population: 0 }] }} initialView="queue" />);
    fireEvent.click(screen.getByRole("button", { name: /Okanogan County, WA/ }));
    await screen.findByRole("heading", { name: "Okanogan Fire" });
    expect(window.location.search).toBe("?view=rehearsal&incidentId=incident-okanogan-county-wa");
    expect(window.location.hash).toBe("#queue");
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Map View" }).getAttribute("href")).toBe("/map?incidentId=incident-okanogan-county-wa");
    expect(screen.getByRole("link", { name: "Feature Graph" }).getAttribute("href")).toBe("/features?incidentId=incident-okanogan-county-wa");
  });
  it("keeps the current incident URL when a county open fails", async () => {
    window.history.replaceState(null, "", "/?incidentId=test-incident");
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/incident"
      ? Response.json({ error: "Live sources unavailable" }, { status: 503 }) : Response.json({}))));
    render(<FireAfterDashboard bundle={{ ...bundle, locations: [{ id: "other", label: "Other County", county: "Other County", state: "WA", centroid: [-119.7, 48.5], wildfireContext: "Public county", fips: "53047", fireWeatherZone: "", population: 0 }] }} initialView="queue" />);
    fireEvent.click(screen.getByRole("button", { name: /Other County/ }));
    await screen.findByText("Live sources unavailable");
    expect(window.location.search).toBe("?incidentId=test-incident");
    expect(screen.getByRole("heading", { name: "Command tests" })).toBeTruthy();
  });
  const inventoryBundle = () => ({ ...bundle, recommendations: Array.from({ length: 12 }, (_, index) => ({
    ...bundle.recommendations[0], id: `rec-${index}`, assetId: `asset-${index}`,
    assetName: `Inventory ${String(index + 1).padStart(2, "0")}`,
    evidence: index === 11 ? [{ sourceKey: "usgs-pwfdf", sourceName: "USGS", sourceFeatureId: "basin-197", summary: "Published basin" }] : [],
  })) });
  it("exposes items beyond the first ten without changing original queue ranks", () => {
    render(<FireAfterDashboard bundle={inventoryBundle()} initialView="queue" />);
    expect(screen.queryByRole("heading", { name: "Inventory 12" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more queue items" }));
    const card = screen.getByRole("heading", { name: "Inventory 12" }).closest("button")!;
    expect(within(card).getByText("12", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more queue items" })).toBeNull();
    expect(actionFetch).not.toHaveBeenCalled();
  });
  it("filters USGS evidence, selects the real original rank and includes its map marker", () => {
    render(<FireAfterDashboard bundle={inventoryBundle()} initialView="queue" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Only items with USGS basin evidence" }));
    expect(screen.getByText(/Showing 1 of 1 matching items/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    const card = screen.getByRole("heading", { name: "Inventory 12" }).closest("button")!;
    expect(within(card).getByText("12", { exact: true })).toBeTruthy();
    fireEvent.click(card);
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select Inventory 12" }).textContent).toBe("12");
    expect(actionFetch).not.toHaveBeenCalled();
  });
  it("combines asset search with the evidence filter and hides unrelated decision controls", () => {
    render(<FireAfterDashboard bundle={inventoryBundle()} initialView="queue" />);
    const search = screen.getByRole("searchbox", { name: "Search queue assets" });
    fireEvent.change(search, { target: { value: "inventory 12" } });
    expect(screen.getByRole("heading", { name: "Inventory 12" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Only items with USGS basin evidence" }));
    fireEvent.change(search, { target: { value: "does not exist" } });
    expect(screen.getByText(/No queue items match these filters/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(actionFetch).not.toHaveBeenCalled();
  });
  it("labels inventory and downstream-context counts without claiming assessed risk or community counts", () => {
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    expect(screen.getByText("Road Crossings Loaded")).toBeTruthy();
    expect(screen.getByText("Culverts Loaded")).toBeTruthy();
    expect(screen.getByText("Downstream Context Items")).toBeTruthy();
    expect(screen.queryByText("Communities Downstream")).toBeNull();
    expect(screen.queryByText("Culverts at Risk")).toBeNull();
  });
  it("keeps asset names readable beside an Unknown risk label on narrow screens", () => {
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    const heading = screen.getAllByRole("heading", { name: "Test crossing" }).find(node => node.closest("button"))!;
    expect(heading.className).toContain("break-words");
    expect(heading.className).not.toContain("truncate");
    expect(heading.parentElement?.parentElement?.parentElement?.className).toContain("flex-col");
  });
  it("announces a live-source mutation and prevents duplicate requests until completion", async () => {
    let finish!: (response: Response) => void;
    const refresh = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/refresh/test-incident"
      ? refresh() : Promise.resolve(Response.json({}))));
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    const button = screen.getByRole("button", { name: /^Refresh$/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Loading live sources and saving validated data/).getAttribute("role")).toBe("status");
    expect(screen.getByRole("textbox", { name: "Search any U.S. county" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { finish(Response.json(bundle)); });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/Loading live sources and saving validated data/)).toBeNull();
  });
  it("fails visibly before dispatch when secure command identity is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText(/Safe decision identity is unavailable/)).toBeTruthy();
    expect(actionFetch).not.toHaveBeenCalled();
  });
  it("retains the original reference across dashboard loss without persisting the private note", async () => {
    actionFetch.mockRejectedValueOnce(new Error("test-only lost response"));
    const first = render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByRole("button", { name: "Retry original decision" });
    await waitFor(() => expect(actionFetch).toHaveBeenCalledTimes(1));
    const command = JSON.parse(actionFetch.mock.calls[0][1].body);
    expect(storage.length).toBe(1);
    expect(storage.getItem(storage.key(0)!)).toContain(command.commandId);
    expect(JSON.parse(storage.getItem(storage.key(0)!)!)).not.toHaveProperty("note");
    first.unmount();
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    expect(await screen.findByRole("button", { name: "Check decision status" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);
    expect(actionFetch).toHaveBeenCalledTimes(1);
  });
  it.each([[401, /Sign in again/], [403, /Your authority changed/], [404, /recommendation is no longer available/]] as const)(
    "shows actual route %s authority guidance without an uncertain-command retry", async (status, message) => {
      const { POST } = await import("@/app/api/actions/route");
      const { AuthError } = await import("@/lib/auth");
      authority.authorize.mockRejectedValue(new AuthError("Access rejected", status));
      actionFetch.mockImplementation((_url, init) => POST(new Request("http://localhost/api/actions", init)));
      render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry original decision" })).toBeNull();
      expect(authority.record).not.toHaveBeenCalled();
    },
  );
  it.each(["AUTH_REQUIRED", "FA401", "NOT_FOUND", "FA409", "FA422"])(
    "does not discard an earlier uncertain command when retry receives %s", async (code) => {
      actionFetch.mockRejectedValueOnce(new Error("test-only lost response"));
      render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      const retry = await screen.findByRole("button", { name: "Retry original decision" });
      await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
      const originalBody = actionFetch.mock.calls[0][1].body;
      if (["AUTH_REQUIRED", "FA401", "NOT_FOUND"].includes(code)) {
        const { POST } = await import("@/app/api/actions/route");
        const { AuthError } = await import("@/lib/auth");
        authority.authorize.mockRejectedValue(new AuthError("Access rejected", code === "AUTH_REQUIRED" ? 401 : code === "FA401" ? 403 : 404));
        actionFetch.mockImplementationOnce((_url, init) => POST(new Request("http://localhost/api/actions", init)));
      } else {
        actionFetch.mockResolvedValueOnce(Response.json({ code }, { status: 409 }));
      }
      fireEvent.click(retry);
      expect(await screen.findByText(/An earlier attempt may already have been recorded/)).toBeTruthy();
      expect(screen.getByText(new RegExp(JSON.parse(originalBody).commandId))).toBeTruthy();
      expect(screen.getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);
      expect(actionFetch.mock.calls[1][1].body).toBe(originalBody);
      expect(authority.record).not.toHaveBeenCalled();
      actionFetch.mockImplementationOnce(async (_url, init) => {
        const request = JSON.parse(init.body);
        return Response.json({ ...request, id: "reconciled", actorName: "test@example.com", createdAt: "2026-09-13T12:01:00Z",
          recommendationSnapshot: bundle.recommendations[0], auditEvent: { id: "reconciled-audit", incidentId: "test-incident",
            recommendationId: request.recommendationId, eventType: "RecommendationAccepted", actorName: "test@example.com",
            createdAt: "2026-09-13T12:01:00Z", summary: "Reconciled test record", payload: request } });
      });
      await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
      fireEvent.click(retry);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Retry original decision" })).toBeNull());
      expect(actionFetch.mock.calls[2][1].body).toBe(originalBody);
      expect(screen.queryByText(/An earlier attempt may already have been recorded/)).toBeNull();
    },
  );
  it("retries the same command and does not allow a replacement after a lost response", async () => {
    actionFetch.mockRejectedValueOnce(new Error("test-only lost response"));
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    const retry = await screen.findByRole("button", { name: "Retry original decision" });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);
    const original = JSON.parse(actionFetch.mock.calls[0][1].body);
    expect(original.expectedRevision).toBe(revision);
    expect(original.commandId).toMatch(/^[a-f0-9-]{36}$/);
    actionFetch.mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(init.body);
      return Response.json({ ...request, id: "stored", actorName: "test@example.com", createdAt: "2026-09-13T12:01:00Z",
        recommendationSnapshot: bundle.recommendations[0], auditEvent: { id: "stored-audit", incidentId: "test-incident",
          recommendationId: request.recommendationId, eventType: "RecommendationAccepted", actorName: "test@example.com",
          createdAt: "2026-09-13T12:01:00Z", summary: "Accepted test record", payload: request } });
    });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry original decision" })).toBeNull());
    expect(actionFetch.mock.calls[1][1].body).toBe(actionFetch.mock.calls[0][1].body);
    expect(screen.getByText(/Accepted recorded in History/)).toBeTruthy();
  });
  it("does not manufacture a revision for a legacy displayed recommendation", async () => {
    const legacy = structuredClone(bundle); delete legacy.recommendations[0].inventoryRevision;
    render(<FireAfterDashboard bundle={legacy} initialView="queue" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText(/Reload and review the current recommendation inventory/)).toBeTruthy();
    expect(actionFetch).not.toHaveBeenCalled();
  });
});
