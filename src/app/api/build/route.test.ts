import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());
describe("release identity response contract (compiled binding requires real build proof)", () => {
  it("returns only a nonsecret identity with no-store", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FIREAFTER_COMPILED_RELEASE_ID", "a".repeat(64));
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ application: "fireafter-sentinel", mode: "production", releaseId: "a".repeat(64) });
  });
  it.each([undefined, "", "bad-id"])("rejects missing/invalid compiled identity %s", value => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("FIREAFTER_COMPILED_RELEASE_ID", value);
    expect(GET().status).toBe(503);
  });
  it("rejects a development server even with a supplied identity", () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("FIREAFTER_COMPILED_RELEASE_ID", "a".repeat(64));
    expect(GET().status).toBe(503);
  });
});
