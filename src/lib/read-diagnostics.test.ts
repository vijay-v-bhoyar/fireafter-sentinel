import { afterEach, describe, expect, it, vi } from "vitest";
import { startReadDiagnostics } from "./read-diagnostics";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("read phase diagnostics", () => {
  it.each([undefined, "", "false", "TRUE"])("does not log unless explicitly enabled: %s", value => {
    vi.stubEnv("FIREAFTER_READ_DIAGNOSTICS", value);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const read = startReadDiagnostics("bundle_read");
    read.mark("inventory"); read.finish({ assets: 427 });
    expect(log).not.toHaveBeenCalled();
  });

  it("reports only elapsed phases and whitelisted counts once", () => {
    vi.stubEnv("FIREAFTER_READ_DIAGNOSTICS", "true");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const read = startReadDiagnostics("bundle_read");
    now.mockReturnValue(125); read.mark("incident");
    now.mockReturnValue(175); read.mark("inventory");
    now.mockReturnValue(200);
    read.finish({ sourceCacheHit: true, assets: 427, recommendations: NaN, sources: -1,
      secret: "PRIVATE_DIAGNOSTIC", coordinates: [-119, 34] } as never);
    read.mark("actions"); read.finish();
    expect(log).toHaveBeenCalledExactlyOnceWith("[fireafter] read timing", {
      operation: "bundle_read", totalMs: 100, phases: { incident: 25, inventory: 50 },
      sourceCacheHit: true, assets: 427,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_DIAGNOSTIC");
  });

  it("does not fail the operation if its logging sink throws", () => {
    vi.stubEnv("FIREAFTER_READ_DIAGNOSTICS", "true");
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("logging unavailable"); });
    expect(() => startReadDiagnostics("dashboard_read").finish()).not.toThrow();
  });
});
