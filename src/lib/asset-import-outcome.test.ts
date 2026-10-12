import { afterEach, describe, expect, it, vi } from "vitest";
import { IMPORT_OUTCOME_UNCONFIRMED, validateAssetImportOutcome } from "./asset-import-outcome";

afterEach(() => vi.unstubAllEnvs());
describe("asset import outcome contract", () => {
  it.each(["completed", "unconfirmed"])("accepts persisted imports with refresh=%s", refresh => {
    const value = { state: "persisted", refresh, auditEventId: "audit-import" };
    expect(validateAssetImportOutcome(value, 2, "audit-import", refresh === "completed")).toEqual(value);
  });
  it("accepts a no-op only with no assets and no audit", () => {
    expect(validateAssetImportOutcome({ state: "no_changes", refresh: "not_attempted" }, 0, null, false).state).toBe("no_changes");
  });
  it.each([
    [undefined, 1, "audit-import"],
    [{ state: "persisted", refresh: "completed", auditEventId: "different" }, 1, "audit-import"],
    [{ state: "persisted", refresh: "completed", auditEventId: "audit-import" }, 0, "audit-import"],
    [{ state: "persisted", refresh: "queued", auditEventId: "audit-import" }, 1, "audit-import"],
    [{ state: "no_changes", refresh: "not_attempted" }, 1, null],
    [{ state: "no_changes", refresh: "not_attempted" }, 0, "audit-import"],
    [{ state: "no_changes", refresh: "not_attempted", diagnostic: "PRIVATE" }, 0, null],
  ])("rejects inconsistent or unsupported receipts", (value, count, audit) => {
    expect(() => validateAssetImportOutcome(value, count as number, audit as string | null, false)).toThrow(IMPORT_OUTCOME_UNCONFIRMED);
  });
  it("does not accept fixture persistence in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => validateAssetImportOutcome({ state: "local_fixture", refresh: "completed" }, 1, "audit", true)).toThrow(IMPORT_OUTCOME_UNCONFIRMED);
  });
  it.each([
    [{ state: "persisted", refresh: "completed", auditEventId: "audit" }, 1, "audit", false],
    [{ state: "persisted", refresh: "unconfirmed", auditEventId: "audit" }, 1, "audit", true],
    [{ state: "no_changes", refresh: "not_attempted" }, 0, null, true],
  ])("FA10-O3 rejects an outcome that contradicts bundle presence", (outcome, count, audit, hasBundle) => {
    expect(() => validateAssetImportOutcome(outcome, count as number, audit as string | null, hasBundle as boolean)).toThrow(IMPORT_OUTCOME_UNCONFIRMED);
  });
});
