import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSupabaseServerClientMock = vi.fn();
const getUserMock = vi.fn();
const updateUserMock = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: getSupabaseServerClientMock,
}));

describe("POST /api/auth/password/update", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    updateUserMock.mockResolvedValue({ error: null });
    getSupabaseServerClientMock.mockResolvedValue({
      auth: { getUser: getUserMock, updateUser: updateUserMock },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("updates a password only after resolving the recovery session", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/auth/password/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "long-secure-password", confirmation: "long-secure-password" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(getSupabaseServerClientMock).toHaveBeenCalledWith({ requireCookieWrites: true });
    expect(getUserMock).toHaveBeenCalledOnce();
    expect(updateUserMock).toHaveBeenCalledWith({ password: "long-secure-password" });
  });

  it("redirects a successful form update to sign in", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/password/update", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "long-secure-password", confirmation: "long-secure-password" }),
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?notice=Password+updated.+Sign+in+with+your+new+password.",
    );
  });

  it("rejects an absent or expired recovery session without updating the password", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: new Error("missing session") });
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/auth/password/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "long-secure-password", confirmation: "long-secure-password" }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Recovery session is missing or expired. Request a new link.",
    });
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("rejects weak, mismatched, and cross-origin password changes before Supabase", async () => {
    const { POST } = await import("./route");
    const weak = await POST(
      new Request("http://localhost/api/auth/password/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "short", confirmation: "short" }),
      }),
    );
    const mismatch = await POST(
      new Request("http://localhost/api/auth/password/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "long-secure-password", confirmation: "different-password" }),
      }),
    );
    const crossOrigin = await POST(
      new Request("https://fireafter.example/api/auth/password/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        body: "{}",
      }),
    );

    expect(weak.status).toBe(400);
    expect(mismatch.status).toBe(400);
    expect(crossOrigin.status).toBe(403);
    expect(getSupabaseServerClientMock).not.toHaveBeenCalled();
  });

  it("does not expose provider details when password update fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    updateUserMock.mockResolvedValueOnce({ error: new Error("provider internals") });
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/auth/password/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "long-secure-password", confirmation: "long-secure-password" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to update password. Request a new link.",
    });
    consoleError.mockRestore();
  });
});
