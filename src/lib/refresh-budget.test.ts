import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runLiveSourceRefresh } from "./live-sources";
import type { Incident } from "./types";

const incident: Incident = {
  id: "incident-budget-test", locationId: "budget-county", county: "Budget County", state: "CA",
  title: "Test incident", code: "TEST", status: "Storm Watch", stormWindow: "Next 48 hours",
  rainfallForecast: "Unavailable", lastRefresh: "Unavailable", dataFreshness: "Low", activeAlerts: 0,
  selectedFire: { name: "Test Fire", acres: 1, perimeterUpdated: "", source: "test-only" },
  locationContext: { id: "budget-county", county: "Budget County", state: "CA", label: "Test area",
    centroid: [-119, 34], bbox: [-119.5, 33.5, -118.5, 34.5], fips: "06111", fireWeatherZone: "test-only", population: 1, wildfireContext: "test-only" },
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("NASA_FIRMS_MAP_KEY", "");
  vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "5000");
  vi.stubEnv("FIREAFTER_REFRESH_MAX_BYTES", "67108864");
  vi.stubEnv("FIREAFTER_REFRESH_MAX_REQUESTS", "512");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("one request budget includes retries and every source adapter", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_MAX_REQUESTS", "1");
  const fetchImpl = vi.fn(async () => Response.json({ error: { message: "test provider failure" } }));
  const result = await runLiveSourceRefresh({ incident, assets: [], fetchImpl }).catch(error => error);
  expect(result).toMatchObject({ code: "refresh_requests", status: 503 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("decoded bytes across refresh sources have an operation ceiling", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_MAX_BYTES", "1024");
  const fetchImpl = vi.fn(async () => new Response("x".repeat(2048)));
  const result = await runLiveSourceRefresh({ incident, assets: [], fetchImpl }).catch(error => error);
  expect(result).toMatchObject({ code: "refresh_bytes", status: 503 });
});

it("sequential source phases cannot each reset the refresh deadline", async () => {
  vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", "250");
  const fetchImpl = vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 180));
    return Response.json({ error: { message: "test provider failure" } });
  });
  const result = await runLiveSourceRefresh({ incident, assets: [], fetchImpl }).catch(error => error);
  expect(result).toMatchObject({ code: "refresh_deadline", status: 503 });
});
