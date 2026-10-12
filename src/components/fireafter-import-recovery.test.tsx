// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTestStorage, createTestLocks } from "../test/browser-storage";
import { FireAfterDashboard } from "./fireafter-dashboard";
import { createIncident, getIncidentBundle } from "@/lib/fireafter-store";
import { checkpointImport } from "@/lib/import-operation-client";
import { importReceipt } from "../test/import-operation-fixture";
vi.mock("next/navigation", () => ({ usePathname: () => "/assets" }));
const storage = createTestStorage();
const incident = createIncident("ventura-ca");
const currentUser = { id: "test-operator", email: "operator@example.com", organizationId: "test-org", role: "analyst" as const };
const bundle = { ...getIncidentBundle(incident.id), currentUser };
const scope = { actorId: currentUser.id, organizationId: currentUser.organizationId, incidentId: incident.id };
beforeEach(() => { vi.stubGlobal("localStorage", storage); vi.stubGlobal("navigator", { locks: createTestLocks() }); });
afterEach(() => { cleanup(); storage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("FA10-R4 rendered import restart recovery", () => {
  it("checkpoints before POST and retains the operation across lost response and remount", async () => {
    let operationId = "";
    const post = vi.fn(async (_url, init) => {
      operationId = JSON.parse(init.body).operationId;
      expect(storage.getItem(storage.key(0)!)).toBe(JSON.stringify({ operationId }));
      throw new Error("Network response lost");
    });
    const lookup = vi.fn(async () => Response.json({ operationId, incidentId: incident.id, state: "committed", receipt: { ...importReceipt, operationId } }));
    vi.stubGlobal("fetch", vi.fn((url, init) => url === "/api/assets/import" ? post(url, init) : String(url).startsWith("/api/assets/import/status?") ? lookup() : Promise.resolve(Response.json({}))));
    const first = render(<FireAfterDashboard bundle={bundle} initialView="assets" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Local asset CSV or GeoJSON" }), { target: { value: "name,lat,lon\nPrivate,34.4,-119.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Import Assets" }));
    await screen.findByText("Network response lost");
    expect(post).toHaveBeenCalledTimes(1);
    expect(storage.getItem(storage.key(0)!)).not.toContain("Private");
    first.unmount();
    render(<FireAfterDashboard bundle={bundle} initialView="assets" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check import status" }));
    expect((await screen.findByRole("status", { name: "Import confirmation" })).textContent).toContain(operationId);
    expect(screen.getByRole("alert").textContent).toContain("refresh completion is not established");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(storage.length).toBe(0);
  });
  it("never dispatches if storage is denied", async () => {
    vi.stubGlobal("localStorage", { get length() { throw new Error("Denied"); } });
    const post = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url) => url === "/api/assets/import" ? post() : Promise.resolve(Response.json({}))));
    render(<FireAfterDashboard bundle={bundle} initialView="assets" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Local asset CSV or GeoJSON" }), { target: { value: "name,lat,lon\nA,34.4,-119.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Import Assets" }));
    expect((await screen.findByRole("alert")).textContent).toContain("No import was sent");
    expect(post).not.toHaveBeenCalled();
  });
  it("retains an unconfirmed checkpoint and blocks creating a replacement", async () => {
    checkpointImport(scope, importReceipt.operationId, storage);
    const post = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url) => url === "/api/assets/import" ? post() : String(url).startsWith("/api/assets/import/status?")
      ? Promise.resolve(Response.json({ operationId: importReceipt.operationId, incidentId: incident.id, state: "unconfirmed", receipt: null })) : Promise.resolve(Response.json({}))));
    render(<FireAfterDashboard bundle={bundle} initialView="assets" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check import status" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("does not prove rollback"));
    fireEvent.change(screen.getByRole("textbox", { name: "Local asset CSV or GeoJSON" }), { target: { value: "name,lat,lon\nA,34.4,-119.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Import Assets" }));
    expect(storage.length).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });
});
