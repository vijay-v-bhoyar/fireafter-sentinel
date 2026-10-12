// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestStorage, createTestLocks } from "../test/browser-storage";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FireAfterDashboard } from "./fireafter-dashboard";
import { createIncident, getIncidentBundle, prepareAssetImport } from "@/lib/fireafter-store";

vi.mock("next/navigation", () => ({ usePathname: () => "/assets", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const storage = createTestStorage();
beforeEach(() => { vi.stubGlobal("localStorage", storage); vi.stubGlobal("navigator", { locks: createTestLocks() }); });
afterEach(() => { cleanup(); storage.clear(); vi.unstubAllGlobals(); });

describe("FA12 rendered upload feedback with the real parser and test-only HTTP transport", () => {
  it.each([
    ["anonymous", false], ["anonymous", true],
    ["viewer", false], ["viewer", true],
    ["analyst", false], ["analyst", true],
  ] as const)("FA12-C2 shows unverified upload trust for %s with populated=%s", (role, populated) => {
    const incident = createIncident("ventura-ca");
    const parsed = prepareAssetImport({ incidentId: incident.id, fileName: "assets.csv",
      content: "name,lat,lon\nUnverified county culvert,34.4,-119.2" }, incident);
    const bundle = { ...getIncidentBundle(incident.id), assets: populated ? parsed.assets : [],
      currentUser: role === "anonymous" ? null : { id: "test-operator", email: "operator@example.com",
        organizationId: "test-org", role } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    render(<FireAfterDashboard bundle={bundle} initialView="assets" />);
    const card = screen.getByText("Uploaded Local Assets", { exact: true }).parentElement!.parentElement!;
    expect(within(card).queryByText(/high.confidence/i)).toBeNull();
    expect(within(card).getByText(/uploads remain unverified with Low confidence/i)).toBeTruthy();
    expect(within(card).getByText(/format checks do not establish field accuracy or condition/i)).toBeTruthy();
    if (populated) {
      const row = screen.getByRole("row", { name: /Unverified county culvert/ });
      expect(within(row).getByRole("cell", { name: /^Low$/ })).toBeTruthy();
    }
    fireEvent.change(screen.getByRole("textbox", { name: "Local asset CSV or GeoJSON" }), {
      target: { value: "name,lat,lon\nAnother culvert,34.4,-119.2" },
    });
    expect((screen.getByRole("button", { name: "Import Assets" }) as HTMLButtonElement).disabled).toBe(role !== "analyst");
  });

  it("keeps rejected input and shows validation without adding a null audit record", async () => {
    const incident = createIncident("ventura-ca");
    const bundle = { ...getIncidentBundle(incident.id), currentUser: { id: "test-operator", email: "operator@example.com", organizationId: "test-org", role: "analyst" as const } };
    const importFetch = vi.fn(async (_url, init) => {
      const result = prepareAssetImport(JSON.parse(init.body), incident);
      expect(result.auditEvent).toBeNull();
      return Response.json({ ...result, operationId: JSON.parse(init.body).operationId, bundle: null, importOutcome: { state: "no_changes", refresh: "not_attempted" } });
    });
    vi.stubGlobal("fetch", vi.fn((url, init) => url === "/api/assets/import" ? importFetch(url, init) : Promise.resolve(Response.json({}))));
    render(<FireAfterDashboard bundle={bundle} initialView="assets" />);
    const uploadPanel = screen.getByRole("heading", { name: "Local Asset Upload" }).closest("section")!;
    expect(within(uploadPanel).getByText(/Uploads remain unverified/)).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Local asset CSV or GeoJSON" });
    const content = "name,lat,lon\nInvalid,not-a-latitude,-119.2";
    fireEvent.change(input, { target: { value: content } });
    fireEvent.click(screen.getByRole("button", { name: "Import Assets" }));
    expect(await screen.findByText(/CSV row 2: missing valid lat\/lon/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe(content);
    expect(importFetch).toHaveBeenCalledTimes(1);
  });

  it("FA10-O3 shows the saved/refresh-unconfirmed outcome without duplicating a retained asset", async () => {
    const incident = createIncident("ventura-ca");
    const content = "name,lat,lon\nRetained import,34.4,-119.2";
    const parsed = prepareAssetImport({ incidentId: incident.id, fileName: "assets.csv", content }, incident);
    const bundle = { ...getIncidentBundle(incident.id), assets: parsed.assets,
      currentUser: { id: "test-operator", email: "operator@example.com", organizationId: "test-org", role: "analyst" as const } };
    const importFetch = vi.fn(async (init) => Response.json({ ...parsed, operationId: JSON.parse(init.body).operationId, bundle: null,
      importOutcome: { state: "persisted", refresh: "unconfirmed", auditEventId: parsed.auditEvent!.id } }));
    vi.stubGlobal("fetch", vi.fn((url, init) => url === "/api/assets/import" ? importFetch(init) : Promise.resolve(Response.json({}))));
    render(<FireAfterDashboard bundle={bundle} initialView="assets" />);
    const input = screen.getByRole("textbox", { name: "Local asset CSV or GeoJSON" });
    fireEvent.change(input, { target: { value: content } });
    fireEvent.click(screen.getByRole("button", { name: "Import Assets" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Assets were saved, but refresh completion is unconfirmed");
    expect(screen.getByRole("alert").textContent).toContain("Do not import them again");
    expect(screen.getAllByText("Retained import")).toHaveLength(1);
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(importFetch).toHaveBeenCalledTimes(1);
  });

  it("FA10-O3 preserves input when a success-shaped response lacks trustworthy outcome evidence", async () => {
    const incident = createIncident("ventura-ca");
    const bundle = { ...getIncidentBundle(incident.id), currentUser: { id: "test-operator", email: "operator@example.com", organizationId: "test-org", role: "analyst" as const } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ assets: [], auditEvent: null, bundle: null })));
    render(<FireAfterDashboard bundle={bundle} initialView="assets" />);
    const input = screen.getByRole("textbox", { name: "Local asset CSV or GeoJSON" });
    const content = "name,lat,lon\nUnknown receipt,34.4,-119.2";
    fireEvent.change(input, { target: { value: content } });
    fireEvent.click(screen.getByRole("button", { name: "Import Assets" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Asset import outcome is unconfirmed");
    expect((input as HTMLTextAreaElement).value).toBe(content);
  });
});
