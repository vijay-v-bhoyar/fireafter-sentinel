import { describe, expect, it } from "vitest";
import { isCrossOriginMutation } from "./request-origin";

function request(headers?: HeadersInit, url = "https://fireafter.example/api/actions") {
  return new Request(url, { method: "POST", headers });
}

describe("mutation request origin", () => {
  it("allows non-browser clients without origin metadata", () => {
    expect(isCrossOriginMutation(request())).toBe(false);
  });

  it("allows exact same-origin browser requests", () => {
    expect(
      isCrossOriginMutation(request({ origin: "https://fireafter.example" })),
    ).toBe(false);
  });

  it("normalizes default ports and equivalent loopback hosts", () => {
    expect(
      isCrossOriginMutation(
        request({ origin: "https://fireafter.example:443" }),
      ),
    ).toBe(false);
    expect(
      isCrossOriginMutation(
        request(
          { origin: "http://localhost:3010" },
          "http://127.0.0.1:3010/api/actions",
        ),
      ),
    ).toBe(false);
  });

  it.each([
    "https://attacker.example",
    "https://sub.fireafter.example",
    "http://fireafter.example",
    "null",
  ])("rejects an untrusted origin: %s", (origin) => {
    expect(isCrossOriginMutation(request({ origin }))).toBe(true);
  });

  it("rejects explicit cross-site fetch metadata even without Origin", () => {
    expect(
      isCrossOriginMutation(request({ "sec-fetch-site": "cross-site" })),
    ).toBe(true);
  });
});
