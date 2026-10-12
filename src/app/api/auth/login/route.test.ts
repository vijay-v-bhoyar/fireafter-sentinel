import { beforeEach, describe, expect, it, vi } from "vitest";

class MockAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

const signInWithPasswordMock = vi.fn();
const verifySignedInOrganizationMembershipMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  AuthError: MockAuthError,
  signInWithPassword: signInWithPasswordMock,
  verifySignedInOrganizationMembership: verifySignedInOrganizationMembershipMock,
}));

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    signInWithPasswordMock.mockReset();
    verifySignedInOrganizationMembershipMock.mockReset();
    signInWithPasswordMock.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      email: "commander@example.com",
    });
    verifySignedInOrganizationMembershipMock.mockResolvedValue({
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "11111111-1111-4111-8111-111111111111",
      role: "incident_commander",
    });
  });

  it("signs in with JSON credentials", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "commander@example.com",
          password: "correct-password",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: "commander@example.com",
      password: "correct-password",
    });
    expect(verifySignedInOrganizationMembershipMock).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("allows a valid viewer membership to sign in as read-only", async () => {
    verifySignedInOrganizationMembershipMock.mockResolvedValueOnce({
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "11111111-1111-4111-8111-111111111111",
      role: "viewer",
    });
    const { POST } = await import("./route");

    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "viewer@example.com",
          password: "correct-password",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("fails closed when Auth succeeds without an issued organization membership", async () => {
    verifySignedInOrganizationMembershipMock.mockRejectedValueOnce(
      new MockAuthError(
        "Account authenticated, but no valid FireAfter organization membership was found. Ask an operator to issue or reissue this account.",
        403,
      ),
    );
    const { POST } = await import("./route");

    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "unissued@example.com",
          password: "correct-password",
          returnTo: "/settings",
        }),
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?error=Account+authenticated%2C+but+no+valid+FireAfter+organization+membership+was+found.+Ask+an+operator+to+issue+or+reissue+this+account.&returnTo=%2Fsettings",
    );
  });

  it("redirects form logins to a same-origin return destination", async () => {
    const { POST } = await import("./route");
    const body = new URLSearchParams({
      email: "commander@example.com",
      password: "correct-password",
      returnTo: "/settings?panel=auth",
    });

    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/settings?panel=auth",
    );
  });

  it.each([
    "https://attacker.example/phish",
    "//attacker.example/phish",
    "javascript:alert(1)",
    "\\\\attacker.example\\phish",
  ])("falls back to the queue for an unsafe form return destination: %s", async (returnTo) => {
    const { POST } = await import("./route");
    const body = new URLSearchParams({
      email: "commander@example.com",
      password: "correct-password",
      returnTo,
    });

    const response = await POST(
      new Request("https://fireafter.example/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://fireafter.example/");
  });

  it("preserves a safe return destination after invalid credentials", async () => {
    signInWithPasswordMock.mockRejectedValueOnce(
      new MockAuthError("Invalid email or password"),
    );
    const { POST } = await import("./route");
    const body = new URLSearchParams({
      email: "commander@example.com",
      password: "wrong-password",
      returnTo: "/queue",
    });

    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?error=Invalid+email+or+password&returnTo=%2Fqueue",
    );
  });

  it("preserves a safe return destination after malformed form input", async () => {
    const { POST } = await import("./route");
    const body = new URLSearchParams({
      email: "not-an-email",
      password: "short",
      returnTo: "/settings",
    });

    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?error=Invalid+login+request&returnTo=%2Fsettings",
    );
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
  });

  it("returns a validation error for a null JSON payload", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid login request",
    });
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON instead of a blank server error", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid login request",
    });
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
  });

  it("rejects oversized login requests before authentication", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(32 * 1024 + 1),
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Login request is too large",
    });
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
  });

  it("rejects credentials beyond the bounded field limits", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "commander@example.com",
          password: "x".repeat(1025),
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
  });

  it("keeps invalid credentials explicit for JSON clients", async () => {
    signInWithPasswordMock.mockRejectedValueOnce(
      new MockAuthError("Invalid email or password"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "commander@example.com",
          password: "wrong-password",
        }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid email or password",
    });
  });

  it("does not expose unexpected authentication-provider errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    signInWithPasswordMock.mockRejectedValueOnce(
      new Error("upstream auth transport failed at internal host"),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "commander@example.com",
          password: "valid-shape-password",
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Login failed" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("rejects cross-origin login attempts before authentication", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://fireafter.example/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin request rejected",
    });
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
  });
});
