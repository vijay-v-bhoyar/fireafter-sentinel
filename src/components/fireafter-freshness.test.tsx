// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FireAfterDashboard } from "./fireafter-dashboard";
import { MTBS_INTERPRETATION_VERSION, projectBundleFreshness } from "@/lib/source-freshness";
import { toClientDashboardBundle } from "@/lib/fireafter-data";
import { SCORING_VERSION } from "@/lib/scoring";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const checkedAt = "2026-09-12T12:00:00.000Z";
const renderedAt = "2026-09-12T12:00:45.000Z";
type Bundle = ComponentProps<typeof FireAfterDashboard>["bundle"];

function freshBundle(): Bundle {
  return projectBundleFreshness({
    incident: {
      id: "incident-clock", locationId: "county-clock", county: "Test County", state: "CA",
      title: "Clock validation", code: "CLOCK", status: "Storm Watch", stormWindow: "48 hours",
      rainfallForecast: "Source forecast", lastRefresh: checkedAt, dataFreshness: "High",
      activeAlerts: 1, alertCoverageStatus: "available",
      selectedFire: { name: "Test fire", acres: 100, perimeterUpdated: checkedAt, source: "WFIGS" },
    },
    sourceSnapshots: [{
      id: "source-clock", incidentId: "incident-clock", sourceKey: "nws", sourceName: "NWS",
      fetchedAt: checkedAt, sourceUpdatedAt: checkedAt, sourceTimeBasis: "provider",
      validUntil: "2026-09-14T12:00:00Z", status: "online", stale: false,
      freshnessLabel: "Just now", detail: "Forecast", coverageStatus: "available",
      sourceUrl: "https://api.weather.gov/",
    }],
    recommendations: [{
      id: "recommendation-clock", incidentId: "incident-clock", assetId: "asset-clock",
      assetName: "Clock test road", assetType: "Road Crossing", locationLabel: "Test County",
      coordinates: [-119, 35], recommendedAction: "Review evidence", finalScore: 0.9, score100: 90,
      riskLevel: "Very High", confidenceLevel: "High", reasonCodes: ["Fresh Source Data"],
      limitations: [], changedSinceLastRefresh: "Updated", sourcesUpdatedLabel: "Just now",
      dataFreshnessHours: 0, sourceSnapshotIds: ["source-clock"], createdAt: checkedAt,
      scoreBreakdown: {
        scoringVersion: SCORING_VERSION, scoreBasis: "hazard-screening",
        rainfallThreat: 0.9, burnSeverity: 0.9, slopeTerrain: 0.9, downstreamExposure: 0.9,
        dataFreshness: 1, confidenceMultiplier: 1, baseScore: 0.9, finalScore: 0.9,
        metricStatus: { rainfallThreat: "available", burnSeverity: "available", slopeTerrain: "available",
          downstreamExposure: "available", dataFreshness: "available" },
      },
    }],
    assets: [], locations: [], actions: [], auditEvents: [], currentUser: null,
  } satisfies Bundle, new Date(renderedAt), 1);
}

describe("open-tab evidence expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(renderedAt));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!url.startsWith("/api/map/features?")) throw new Error(`Unexpected test request: ${url}`);
      return Response.json({ roads: [], hydro: [], basins: [], assets: [], recommendations: [] });
    }));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps compact MTBS boundary context honest after client freshness ticks", async () => {
    const original = freshBundle();
    original.sourceSnapshots.push({
      id: "mtbs", incidentId: original.incident.id, sourceKey: "mtbs-burn-severity", sourceName: "MTBS boundary context",
      fetchedAt: checkedAt, sourceUpdatedAt: checkedAt, status: "delayed", stale: true,
      coverageStatus: "not_available", freshnessLabel: "Severity measurements unavailable",
      detail: "Boundary-only context; incident burn severity remains unavailable.",
      rawPayload: { interpretationVersion: MTBS_INTERPRETATION_VERSION, sample: [{ geometry: "server-only" }] },
    });
    const bundle = JSON.parse(JSON.stringify(toClientDashboardBundle(original)));
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.queryByText(/Legacy MTBS interpretation requires refresh/)).toBeNull();
    expect(screen.getAllByText(/Boundary-only context; incident burn severity remains unavailable/).length).toBeGreaterThan(0);
    expect(bundle.sourceSnapshots[1].coverageStatus).toBe("not_available");
    expect(bundle.sourceSnapshots[1].rawPayload).not.toHaveProperty("sample");
  });

  it.each(["timer", "focus", "visibility"])("downgrades the rendered queue on %s without a refresh", async (trigger) => {
    const bundle = freshBundle();
    const original = structuredClone(bundle);
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getAllByText("VERY HIGH").length).toBeGreaterThan(0);
    expect(screen.getByRole("status", { name: "Source evidence health" }).textContent).toMatch(/1\s+current,\s+0\s+limited/);
    const requestsBeforeExpiry = vi.mocked(fetch).mock.calls.length;

    await act(async () => {
      if (trigger === "timer") await vi.advanceTimersByTimeAsync(15_000);
      else {
        vi.setSystemTime(new Date("2026-09-12T12:01:00Z"));
        if (trigger === "focus") fireEvent(window, new Event("focus"));
        else fireEvent(document, new Event("visibilitychange"));
      }
    });

    expect(screen.queryByText("VERY HIGH")).toBeNull();
    expect(screen.getAllByText("Evidence review required").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unverified").length).toBeGreaterThan(0);
    expect(screen.getByRole("status", { name: "Source evidence health" }).textContent).toMatch(/0\s+current,\s+1\s+limited/);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requestsBeforeExpiry);
    expect(bundle).toEqual(original);
  });

  it("keeps stale, partial and failed online feeds limited without double-counting them", async () => {
    const bundle = freshBundle();
    const base = bundle.sourceSnapshots[0];
    bundle.sourceSnapshots.push(
      { ...base, id: "old-fire", sourceKey: "wfigs-ytd", sourceName: "Historical fire context", stale: true },
      { ...base, id: "partial-roads", sourceKey: "tiger-roads", sourceName: "Partial road source", coverageStatus: "partial" },
      { ...base, id: "failed-source", sourceKey: "3dhp-flowlines", sourceName: "Failed source", coverageStatus: "error" },
    );
    const original = structuredClone(bundle);
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status", { name: "Source evidence health" }).textContent).toMatch(/1\s+current,\s+3\s+limited/);
    expect(screen.getAllByTitle("Current, available evidence")).toHaveLength(1);
    expect(screen.getAllByTitle("Limited evidence: review age, coverage and retrieval status")).toHaveLength(3);
    expect(screen.getAllByTitle("Limited evidence: review age, coverage and retrieval status")
      .every(element => element.classList.contains("text-amber-300"))).toBe(true);
    expect(bundle).toEqual(original);
  });

  it("does not restore a server-expired assessment when the client clock is behind", async () => {
    const bundle = projectBundleFreshness(freshBundle(), new Date("2026-09-12T12:01:00Z"), 1);
    vi.setSystemTime(new Date(checkedAt));
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.queryByText("VERY HIGH")).toBeNull();
    expect(screen.getAllByText("Evidence review required").length).toBeGreaterThan(0);
    expect(bundle.recommendations[0].score100).toBe(90);
  });

  it("marks persisted source rows and exposes a safe provenance link", async () => {
    const { container } = render(<FireAfterDashboard bundle={freshBundle()} initialView="queue" />);

    expect(container.querySelectorAll("[data-source-row]")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open NWS official source" }).getAttribute("href"))
      .toBe("https://api.weather.gov/");
  });

  it("shows a retryable unavailable map instead of successful empty layers after a saved-read failure", async () => {
    const bundle = freshBundle();
    const collection = { type: "FeatureCollection", features: [] };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: "COUNTY_DATA_UNAVAILABLE", error: "Saved county evidence is unavailable." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ incidentId: bundle.incident.id, county: collection, roads: collection,
        hydrography: collection, pwfdfBasins: collection, assets: collection, recommendations: collection }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Source geometry unavailable\. Retry loading the map\./)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry map" });
    await act(async () => { fireEvent.click(retry); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole("button", { name: "Retry map" })).toBeNull();
    expect(screen.queryByText(/Source geometry unavailable/)).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
