// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FireAfterDashboard } from "./fireafter-dashboard";
import { createTestStorage } from "../test/browser-storage";

const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => navigation }));

const replaceDocument = vi.fn();
const logoutFetch = vi.fn();
const bundle: ComponentProps<typeof FireAfterDashboard>["bundle"] = {
  incident: {
    id: "logout-test", locationId: "test-county", county: "Test County", state: "CA",
    title: "Logout validation", code: "TEST", status: "Stale Data", stormWindow: "Unknown",
    rainfallForecast: "Unavailable", lastRefresh: "2026-09-13T12:00:00Z",
    dataFreshness: "Low", activeAlerts: 0,
    selectedFire: { name: "Test fire", acres: 100, perimeterUpdated: "2026-09-13T12:00:00Z", source: "WFIGS" },
  },
  assets: [], locations: [], recommendations: [], sourceSnapshots: [], actions: [], auditEvents: [],
  currentUser: { id: "test-user", email: "reviewer@example.com", organizationId: "test-org", role: "analyst" },
};
const failureMessage = "Sign-out could not be confirmed. Your session may still be active. Retry, or contact your operator before leaving this device.";

describe("confirmed logout journey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logoutFetch.mockReset();
    vi.stubGlobal("localStorage", createTestStorage());
    vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", replace: replaceDocument });
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/auth/logout") return logoutFetch(url, init);
      if (url.startsWith("/api/map/features?")) return Promise.resolve(Response.json({
        incidentId: "logout-test",
        county: { features: [] }, roads: { features: [] }, hydrography: { features: [] },
        pwfdfBasins: { features: [] }, assets: { features: [] }, recommendations: { features: [] },
      }));
      throw new Error(`Unexpected test request: ${url}`);
    }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each(["http", "network", "invalid-json", "unconfirmed"])("stays on the dashboard and permits retry after %s failure", async (failure) => {
    if (failure === "network") logoutFetch.mockRejectedValueOnce(new Error("private transport details"));
    else logoutFetch.mockResolvedValueOnce(failure === "http"
      ? Response.json({ error: "private provider details" }, { status: 503 })
      : failure === "invalid-json" ? new Response("not JSON") : Response.json({ ok: false }));
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    const button = screen.getByRole("button", { name: /reviewer@example.com/ });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(failureMessage));
    expect(replaceDocument).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(button.hasAttribute("disabled")).toBe(false);
    logoutFetch.mockResolvedValueOnce(Response.json({ ok: true }));
    fireEvent.click(button);
    await waitFor(() => expect(replaceDocument).toHaveBeenCalledExactlyOnceWith("/login"));
    expect(logoutFetch).toHaveBeenCalledTimes(2);
  });

  it("disables duplicate clicks until confirmed and replaces the whole document", async () => {
    let resolve!: (response: Response) => void;
    logoutFetch.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    const button = screen.getByRole("button", { name: /reviewer@example.com/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(logoutFetch).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.textContent).toContain("Signing out");
    expect(replaceDocument).not.toHaveBeenCalled();
    await act(async () => { resolve(Response.json({ ok: true })); });
    expect(replaceDocument).toHaveBeenCalledExactlyOnceWith("/login");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByText("analyst")).toBeTruthy();
  });

  it("aborts a stalled sign-out and exposes the same retryable warning", async () => {
    vi.useFakeTimers();
    logoutFetch.mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    render(<FireAfterDashboard bundle={bundle} initialView="queue" />);
    const button = screen.getByRole("button", { name: /reviewer@example.com/ });
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("alert").textContent).toContain(failureMessage);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(replaceDocument).not.toHaveBeenCalled();
  });
});
