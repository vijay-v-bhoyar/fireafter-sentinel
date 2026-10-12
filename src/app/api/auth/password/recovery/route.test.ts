import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSupabaseServerClientMock = vi.fn();
const resetPasswordForEmailMock = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: getSupabaseServerClientMock,
}));

describe("POST /api/auth/password/recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FIREAFTER_PUBLIC_APP_URL", "https://fireafter-app.vercel.app");
    resetPasswordForEmailMock.mockResolvedValue({ error: null });
    getSupabaseServerClientMock.mockResolvedValue({
      auth: { resetPasswordForEmail: resetPasswordForEmailMock },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("sends recovery through Supabase using the configured callback origin", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/auth/password/recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "commander@example.com" }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "If an issued account matches this email, a recovery link has been sent.",
    });
    expect(resetPasswordForEmailMock).toHaveBeenCalledWith("commander@example.com", {
      redirectTo: "https://fireafter-app.vercel.app/auth/callback?next=%2Freset-password",
    });
  });

  it("redirects valid form requests without placing the submitted email in the URL", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/password/recovery", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "commander@example.com" }),
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/recover?submitted=1");
  });

  it("does not disclose account existence when Supabase rejects the request", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetPasswordForEmailMock.mockResolvedValueOnce({ error: new Error("unknown user") });
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/auth/password/recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "unknown@example.com" }),
      }),
    );

    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toEqual({
      error: "Password recovery is temporarily unavailable",
    });
    expect(JSON.stringify(payload)).not.toContain("unknown@example.com");
    consoleError.mockRestore();
  });

  it("fails closed when no canonical public application origin is configured", async () => {
    vi.stubEnv("FIREAFTER_PUBLIC_APP_URL", "https://fireafter.example/recover");
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/auth/password/recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "commander@example.com" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled();
  });

  it("rejects malformed and cross-origin requests before Supabase", async () => {
    const { POST } = await import("./route");
    const malformed = await POST(
      new Request("http://localhost/api/auth/password/recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad-json",
      }),
    );
    const crossOrigin = await POST(
      new Request("https://fireafter.example/api/auth/password/recovery", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        body: "{}",
      }),
    );

    expect(malformed.status).toBe(400);
    expect(crossOrigin.status).toBe(403);
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled();
  });
});
