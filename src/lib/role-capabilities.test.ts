import { describe, expect, it } from "vitest";
import { canWriteOperationalRecords } from "./role-capabilities";

describe("operational role capabilities", () => {
  it("allows organization commanders and analysts to write", () => {
    expect(
      canWriteOperationalRecords({
        organizationId: "org-1",
        role: "incident_commander",
      }),
    ).toBe(true);
    expect(
      canWriteOperationalRecords({ organizationId: "org-1", role: "analyst" }),
    ).toBe(true);
  });

  it("keeps viewers and users without organization membership read-only", () => {
    expect(
      canWriteOperationalRecords({ organizationId: "org-1", role: "viewer" }),
    ).toBe(false);
    expect(
      canWriteOperationalRecords({ organizationId: null, role: "analyst" }),
    ).toBe(false);
    expect(canWriteOperationalRecords({ role: null })).toBe(false);
    expect(canWriteOperationalRecords(null)).toBe(false);
  });
});
