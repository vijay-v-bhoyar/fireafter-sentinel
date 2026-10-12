import { describe, expect, it } from "vitest";
import {
  RequestTooLargeError,
  assertTextWithinLimit,
  requestExceedsLimit,
} from "./request-limits";

describe("request limits", () => {
  it("rejects oversized and malformed content lengths", () => {
    expect(
      requestExceedsLimit(
        new Request("http://localhost", {
          headers: { "content-length": "101" },
        }),
        100,
      ),
    ).toBe(true);
    expect(
      requestExceedsLimit(
        new Request("http://localhost", {
          headers: { "content-length": "not-a-number" },
        }),
        100,
      ),
    ).toBe(true);
  });

  it("allows absent or in-range content lengths", () => {
    expect(requestExceedsLimit(new Request("http://localhost"), 100)).toBe(false);
    expect(
      requestExceedsLimit(
        new Request("http://localhost", {
          headers: { "content-length": "100" },
        }),
        100,
      ),
    ).toBe(false);
  });

  it("bounds parsed text when transfer length is unavailable", () => {
    expect(() => assertTextWithinLimit("abcd", 4)).not.toThrow();
    expect(() => assertTextWithinLimit("abcde", 4)).toThrow(RequestTooLargeError);
  });
});
