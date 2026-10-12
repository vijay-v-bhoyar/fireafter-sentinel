// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IngestionProgress, useIngestionProgress } from "./ingestion-progress";
import { createTestStorage } from "@/test/browser-storage";

const operationId = "50000000-0000-4000-a000-000000000001";
const saved = { id: operationId, kind: "create", target: "test-county-ca" };
const job = { id: operationId, incidentId: "incident-test-county-ca", county: "Test County, CA", status: "running", stage: "terrain:2",
  published: true, terrainCompleted: 2, terrainTotal: 45, errorCode: null, updatedAt: new Date().toISOString() };
function Harness() {
  const state = useIngestionProgress("actor");
  return <><button onClick={() => state.begin({ kind: "create", target: "test-county-ca" })}>Start county</button><IngestionProgress state={state} /></>;
}
beforeEach(() => { vi.stubGlobal("localStorage", createTestStorage()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("restores the original operation after page reload without creating a new job", async () => {
  localStorage.setItem("fireafter:ingestion:v1:actor", JSON.stringify(saved));
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ingestion: job }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<Harness />);
  await screen.findByText(/Terrain batches saved: 2 \/ 45/);
  expect(fetchMock).toHaveBeenCalledWith(`/api/ingestion/${operationId}`, expect.objectContaining({ cache: "no-store" }));
  expect(fetchMock.mock.calls.every(call => call[1]?.method !== "POST")).toBe(true);
  expect(screen.getByRole("link", { name: "Open available evidence" }).getAttribute("href")).toContain("incident-test-county-ca");
});
it("explains that an incomplete inventory refresh preserves the saved county without renewing dates", async () => {
  localStorage.setItem("fireafter:ingestion:v1:actor", JSON.stringify({ ...saved, kind: "refresh" }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ingestion: {
    ...job, stage: "source:bridges", errorCode: "inventory_refresh_unavailable",
  } }), { status: 200 })));
  render(<Harness />);
  await screen.findByText(/last saved county remains available with its original dates/);
  expect(screen.getByText(/no assets were removed by this attempt/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open available evidence" })).toBeTruthy();
});

it("shows saved inventory progress without claiming the incomplete set is ready", async () => {
  localStorage.setItem("fireafter:ingestion:v1:actor", JSON.stringify(saved));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ingestion: {
    ...job, stage: "source:hydro", terrainTotal: 0, inventory: { source: "hydro", saved: 800, total: 1601 },
  } })));
  render(<Harness />);
  await screen.findByText(/hydro features saved: 800 \/ 1601/);
  expect(screen.getByText(/Full inventory verification is still required/)).toBeTruthy();
  expect(screen.queryByText(/Processing has finished/)).toBeNull();
});
it("shows derivation progress separately from published assets and explains a deterministic capacity stop", async () => {
  localStorage.setItem("fireafter:ingestion:v1:actor", JSON.stringify(saved));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ingestion: {
    ...job, stage: "derive:final", status: "failed", terrainTotal: 0, errorCode: "inference_candidates",
    crossings: { roadsCompleted: 2976, candidatesSaved: 18180 },
  } })));
  render(<Harness />);
  await screen.findByText(/Roads processed: 2976/);
  expect(screen.getByText(/complete set must be verified before publication/)).toBeTruthy();
  expect(screen.getByText(/Repeating Refresh will not resolve the limit/)).toBeTruthy();
  expect(screen.getByText(/No partial crossing inventory was published/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resume original operation" })).toBeNull();
  expect(screen.queryByText(/Processing has finished/)).toBeNull();
});
it("keeps the same request reference when server acceptance is unconfirmed", async () => {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? new Response(JSON.stringify({ ingestion: { ...job, status: "completed", stage: "done" } }), { status: 202 })
    : new Response("not found", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<Harness />);
  // Wait for storage hydration before a user interaction.
  await waitFor(() => expect(screen.getByRole("button", { name: "Start county" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Start county" }));
  await screen.findByText(/Server acceptance is not yet confirmed/);
  const reference = JSON.parse(localStorage.getItem("fireafter:ingestion:v1:actor")!).id;
  await screen.findByText(/not confirmed yet/);
  fireEvent.click(screen.getByRole("button", { name: "Resume original operation" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(call => call[0] === "/api/incident")).toBe(true));
  const retry = fetchMock.mock.calls.find(call => call[0] === "/api/incident")!;
  expect(retry[1].headers["X-Ingestion-Operation-ID"]).toBe(reference);
  expect(JSON.parse(retry[1].body)).toEqual({ locationId: "test-county-ca" });
  await screen.findByText(`Operation: ${operationId}`);
  expect(JSON.parse(localStorage.getItem("fireafter:ingestion:v1:actor")!).id).toBe(operationId);
});
