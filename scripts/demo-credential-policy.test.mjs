import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertDemoPasswordNotCompromised,
  matchesBlockedPasswordHash,
} from "./demo-credential-policy.mjs";

describe("demo credential policy", () => {
  it("rejects a password matching an injected blocked digest", () => {
    const password = "test-only-compromised-password";
    const digest = createHash("sha256").update(password, "utf8").digest("hex");

    expect(matchesBlockedPasswordHash(password, new Set([digest]))).toBe(true);
  });

  it("accepts a password that does not match a blocked digest", () => {
    const blockedDigest = createHash("sha256")
      .update("different-test-password", "utf8")
      .digest("hex");

    expect(
      matchesBlockedPasswordHash(
        "operator-issued-test-password",
        new Set([blockedDigest]),
      ),
    ).toBe(false);
    expect(() =>
      assertDemoPasswordNotCompromised(
        "operator-issued-test-password",
        "TEST_PASSWORD",
      ),
    ).not.toThrow();
  });
});
