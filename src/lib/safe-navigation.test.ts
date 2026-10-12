import { describe, expect, it } from "vitest";
import { safeInternalPath } from "./safe-navigation";

describe("safeInternalPath", () => {
  it("preserves a same-origin path, query, and fragment", () => {
    expect(safeInternalPath(" /settings?panel=auth#evidence ")).toBe(
      "/settings?panel=auth#evidence",
    );
  });

  it.each([
    "https://attacker.example/phish",
    "//attacker.example/phish",
    "javascript:alert(1)",
    "\\\\attacker.example\\phish",
    "/\\attacker.example/phish",
    "/settings\u0000",
  ])("falls back for an unsafe internal path: %s", (value) => {
    expect(safeInternalPath(value, "/")).toBe("/");
  });

  it("falls back for absent or oversized values", () => {
    expect(safeInternalPath(undefined, "/queue")).toBe("/queue");
    expect(safeInternalPath(`/${"x".repeat(2048)}`, "/")).toBe("/");
  });
});
