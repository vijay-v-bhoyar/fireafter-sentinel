import { beforeEach, describe, expect, it, vi } from "vitest";

const signOutCurrentUserMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  signOutCurrentUser: signOutCurrentUserMock,
}));

describe("POST /api/auth/logout", () => {
  beforeEach(() => {
    signOutCurrentUserMock.mockReset();
    signOutCurrentUserMock.mockResolvedValue(undefined);
  });

  it("signs out a same-origin JSON client", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/auth/logout", {
        method: "POST",
        headers: {
          accept: "application/json",
          origin: "https://fireafter.example",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(signOutCurrentUserMock).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin logout before clearing the session", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/auth/logout", {
        method: "POST",
        headers: {
          accept: "application/json",
          origin: "https://attacker.example",
        },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin request rejected",
    });
    expect(signOutCurrentUserMock).not.toHaveBeenCalled();
  });

  it.each(["application/json", "text/html"])("returns a safe non-redirecting failure for %s", async (accept) => {
    signOutCurrentUserMock.mockRejectedValue(new Error("private provider credentials"));
    const { POST } = await import("./route");
    const response = await POST(new Request("https://fireafter.example/api/auth/logout", {
      method: "POST", headers: { accept, origin: "https://fireafter.example" },
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "SIGN_OUT_UNCONFIRMED",
      error: "Sign-out could not be confirmed. Your session may still be active. Retry, or contact your operator before leaving this device.",
    });
  });

  it("redirects a form client only after successful logout", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("https://fireafter.example/api/auth/logout", { method: "POST" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://fireafter.example/login");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
