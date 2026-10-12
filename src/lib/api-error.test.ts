import { describe, expect, it } from "vitest";
import { parseApiErrorMessage } from "./api-error";

describe("parseApiErrorMessage", () => {
  it("extracts JSON error messages from protected API responses", () => {
    expect(parseApiErrorMessage(401, '{"error":"Authentication required"}')).toBe(
      "Authentication required",
    );
  });

  it("falls back to HTTP status when the response body is empty or invalid", () => {
    expect(parseApiErrorMessage(500, "")).toBe("Request failed with 500");
    expect(parseApiErrorMessage(403, "{not-json")).toBe("Request failed with 403");
  });
});
