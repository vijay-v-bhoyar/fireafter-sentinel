import { afterEach, describe, expect, it, vi } from "vitest";
import { getPasswordRecoveryRedirectUrl, getPublicAppOrigin } from "./public-app-url";

afterEach(() => vi.unstubAllEnvs());

describe("public application origin", () => {
  it("accepts a canonical HTTPS production origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FIREAFTER_PUBLIC_APP_URL", "https://fireafter-app.vercel.app");

    expect(getPublicAppOrigin()).toBe("https://fireafter-app.vercel.app");
    expect(getPasswordRecoveryRedirectUrl()).toBe(
      "https://fireafter-app.vercel.app/auth/callback?next=%2Freset-password",
    );
  });

  it.each([
    "http://fireafter-app.vercel.app",
    "https://fireafter-app.vercel.app/recovery",
    "https://user:password@fireafter-app.vercel.app",
    "https://fireafter-app.vercel.app/?next=https://attacker.example",
  ])("rejects a non-canonical production origin: %s", (value) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FIREAFTER_PUBLIC_APP_URL", value);

    expect(getPublicAppOrigin()).toBeNull();
  });

  it("allows HTTP only for an explicit local development origin", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FIREAFTER_PUBLIC_APP_URL", "http://127.0.0.1:3010");

    expect(getPublicAppOrigin()).toBe("http://127.0.0.1:3010");
  });
});
