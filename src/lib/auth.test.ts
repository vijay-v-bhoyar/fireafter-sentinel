import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultOrganizationMembership,
  getIncidentAuthorizationContext,
  getRecommendationAuthorizationContext,
} from "./fireafter-supabase";
import { getSupabaseServerClient } from "./supabase";
import {
  requireCurrentUser,
  getCurrentUser,
  requireIncidentAccess,
  requireRecommendationAccess,
  signInWithPassword,
  signOutCurrentUser,
  verifySignedInOrganizationMembership,
} from "./auth";

vi.mock("./supabase", () => ({
  getSupabaseServerClient: vi.fn(),
}));

vi.mock("./fireafter-supabase", () => ({
  getDefaultOrganizationMembership: vi.fn(),
  getIncidentAuthorizationContext: vi.fn(),
  getRecommendationAuthorizationContext: vi.fn(),
}));

const getSupabaseServerClientMock = vi.mocked(getSupabaseServerClient);
const getDefaultOrganizationMembershipMock = vi.mocked(
  getDefaultOrganizationMembership,
);
const getIncidentAuthorizationContextMock = vi.mocked(
  getIncidentAuthorizationContext,
);
const getRecommendationAuthorizationContextMock = vi.mocked(
  getRecommendationAuthorizationContext,
);

describe("requireCurrentUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getSupabaseServerClientMock.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: "11111111-1111-4111-8111-111111111111",
              email: "commander@example.com",
            },
          },
          error: null,
        }),
        signOut: vi.fn().mockResolvedValue({ error: null }),
      },
    } as never);
  });

  it("fails closed to anonymous context when an existing session cannot read membership", async () => {
    getDefaultOrganizationMembershipMock.mockRejectedValue(
      new Error("private membership transport details"),
    );
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(getCurrentUser()).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      "[fireafter] current user membership lookup unavailable",
      { errorName: "Error" },
    );
    consoleWarn.mockRestore();
  });

  it("fails closed to anonymous context when the current session cannot be read", async () => {
    getSupabaseServerClientMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockRejectedValue(new Error("private session transport details")) },
    } as never);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(getCurrentUser()).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      "[fireafter] current user lookup unavailable",
      { errorName: "Error" },
    );
    consoleWarn.mockRestore();
  });

  it("rejects authenticated users without an explicit organization membership", async () => {
    getDefaultOrganizationMembershipMock.mockResolvedValue(null);

    await expect(requireCurrentUser()).rejects.toMatchObject({
      message: "Organization membership required",
      status: 403,
    });
  });

  it("returns authenticated users with an explicit organization membership", async () => {
    getDefaultOrganizationMembershipMock.mockResolvedValue({
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "11111111-1111-4111-8111-111111111111",
      role: "incident_commander",
    });

    await expect(requireCurrentUser()).resolves.toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "commander@example.com",
      organizationId: "22222222-2222-4222-8222-222222222222",
      role: "incident_commander",
    });
  });

  it("allows incident access only inside the user's organization", async () => {
    getDefaultOrganizationMembershipMock.mockResolvedValue({
      organization_id: "org-user",
      user_id: "11111111-1111-4111-8111-111111111111",
      role: "incident_commander",
    });
    getIncidentAuthorizationContextMock.mockResolvedValue({
      databaseIncidentId: "incident-db",
      domainIncidentId: "incident-domain",
      organizationId: "org-user",
    });

    await expect(requireIncidentAccess("incident-domain")).resolves.toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: "org-user",
    });

    getIncidentAuthorizationContextMock.mockResolvedValueOnce({
      databaseIncidentId: "incident-db-other",
      domainIncidentId: "incident-domain-other",
      organizationId: "org-other",
    });
    await expect(requireIncidentAccess("incident-domain-other")).rejects.toMatchObject({
      message: "Incident access denied",
      status: 403,
    });
  });

  it("allows recommendation actions only inside the user's organization", async () => {
    getDefaultOrganizationMembershipMock.mockResolvedValue({
      organization_id: "org-user",
      user_id: "11111111-1111-4111-8111-111111111111",
      role: "analyst",
    });
    getRecommendationAuthorizationContextMock.mockResolvedValue({
      databaseIncidentId: "incident-db",
      domainIncidentId: "incident-domain",
      organizationId: "org-user",
      databaseRecommendationId: "rec-db",
      domainRecommendationId: "rec-domain",
    });

    await expect(requireRecommendationAccess("rec-domain")).resolves.toMatchObject({
      organizationId: "org-user",
      role: "analyst",
    });

    getRecommendationAuthorizationContextMock.mockResolvedValueOnce({
      databaseIncidentId: "incident-db",
      domainIncidentId: "incident-domain",
      organizationId: "org-other",
      databaseRecommendationId: "rec-db",
      domainRecommendationId: "rec-domain",
    });
    await expect(requireRecommendationAccess("rec-domain")).rejects.toMatchObject({
      message: "Incident access denied",
      status: 403,
    });
  });

  it("signs in without granting organization membership", async () => {
    const signInWithPasswordMock = vi.fn().mockResolvedValue({
      data: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "commander@example.com",
        },
      },
      error: null,
    });
    getSupabaseServerClientMock.mockResolvedValue({
      auth: {
        signInWithPassword: signInWithPasswordMock,
      },
    } as never);

    await expect(
      signInWithPassword({
        email: "commander@example.com",
        password: "correct-password",
      }),
    ).resolves.toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "commander@example.com",
    });
    expect(getDefaultOrganizationMembershipMock).not.toHaveBeenCalled();
  });

  it.each(["returned", "thrown"])("reports %s login transport failure as unavailable, without retrying", async (mode) => {
    const failure = { name: "AuthRetryableFetchError", status: 0, message: "Upstream response exceeded its full-body deadline." };
    const login = mode === "returned"
      ? vi.fn().mockResolvedValue({ data: { user: null }, error: failure })
      : vi.fn().mockRejectedValue(failure);
    getSupabaseServerClientMock.mockResolvedValue({ auth: { signInWithPassword: login } } as never);
    await expect(signInWithPassword({ email: "user@example.com", password: "test" }))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining("Sign-in could not be confirmed") });
    expect(login).toHaveBeenCalledTimes(1);
    expect(getDefaultOrganizationMembershipMock).not.toHaveBeenCalled();
  });

  it("reports the required public auth configuration when the client is unavailable", async () => {
    getSupabaseServerClientMock.mockResolvedValue(null);

    await expect(
      signInWithPassword({
        email: "commander@example.com",
        password: "correct-password",
      }),
    ).rejects.toMatchObject({
      message:
        "Supabase Auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY).",
      status: 503,
    });
  });

  it("accepts an issued viewer membership for read-only sign-in", async () => {
    getDefaultOrganizationMembershipMock.mockResolvedValue({
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "11111111-1111-4111-8111-111111111111",
      role: "viewer",
    });

    await expect(
      verifySignedInOrganizationMembership("11111111-1111-4111-8111-111111111111"),
    ).resolves.toMatchObject({ role: "viewer" });
  });

  it("clears the session and explains how to fix an unissued account", async () => {
    getDefaultOrganizationMembershipMock.mockResolvedValue(null);
    const signOut = vi.fn().mockResolvedValue({ error: null });
    getSupabaseServerClientMock.mockResolvedValueOnce({
      auth: { signOut },
    } as never);

    await expect(
      verifySignedInOrganizationMembership("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      message:
        "Account authenticated, but no valid FireAfter organization membership was found. Ask an operator to issue or reissue this account.",
      status: 403,
    });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("fails closed when membership verification is unavailable", async () => {
    getDefaultOrganizationMembershipMock.mockRejectedValue(
      new Error("database transport details"),
    );
    const signOut = vi.fn().mockResolvedValue({ error: null });
    getSupabaseServerClientMock.mockResolvedValueOnce({
      auth: { signOut },
    } as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      verifySignedInOrganizationMembership("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      message:
        "Unable to verify FireAfter organization access. Try again or ask an operator to reissue this account.",
      status: 503,
    });
    expect(signOut).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[fireafter] authenticated membership verification failed",
      { errorName: "Error" },
    );
    consoleError.mockRestore();
  });

  it("rejects a membership returned for another user or unsupported role", async () => {
    getDefaultOrganizationMembershipMock.mockResolvedValue({
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
      role: "viewer",
    });

    await expect(
      verifySignedInOrganizationMembership("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an unsupported membership role", async () => {
    getDefaultOrganizationMembershipMock.mockResolvedValue({
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "11111111-1111-4111-8111-111111111111",
      role: "operator" as never,
    });

    await expect(
      verifySignedInOrganizationMembership("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each(["returned", "thrown", "missing-client"])("rejects unconfirmed logout: %s", async (failure) => {
    const signOut = failure === "returned"
      ? vi.fn().mockResolvedValue({ error: new Error("private provider details") })
      : vi.fn().mockRejectedValue(new Error("private provider details"));
    getSupabaseServerClientMock.mockResolvedValue(failure === "missing-client" ? null : { auth: { signOut } } as never);
    await expect(signOutCurrentUser()).rejects.toMatchObject({
      name: "AuthError", status: 503,
      message: "Sign-out could not be confirmed. Your session may still be active. Retry, or contact your operator before leaving this device.",
    });
  });

  it("requires cookie writes and preserves the existing global logout scope", async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });
    getSupabaseServerClientMock.mockResolvedValue({ auth: { signOut } } as never);
    await expect(signOutCurrentUser()).resolves.toBeUndefined();
    expect(getSupabaseServerClientMock).toHaveBeenCalledWith({ requireCookieWrites: true });
    expect(signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("keeps failed-login membership denial when logout cleanup also fails", async () => {
    getDefaultOrganizationMembershipMock.mockResolvedValue(null);
    getSupabaseServerClientMock.mockResolvedValue({ auth: {
      signOut: vi.fn().mockResolvedValue({ error: new Error("private provider details") }),
    } } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(verifySignedInOrganizationMembership("unissued-user")).rejects.toMatchObject({ status: 403 });
      expect(warn).toHaveBeenCalledExactlyOnceWith("[fireafter] could not clear unverified login session", { errorName: "AuthError" });
    } finally { warn.mockRestore(); }
  });

  it("propagates a provider rejection through the real logout route without a success response", async () => {
    getSupabaseServerClientMock.mockResolvedValue({ auth: {
      signOut: vi.fn().mockResolvedValue({ error: new Error("private provider details") }),
    } } as never);
    const { POST } = await import("../app/api/auth/logout/route");
    const response = await POST(new Request("https://fireafter.example/api/auth/logout", {
      method: "POST", headers: { accept: "application/json" },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SIGN_OUT_UNCONFIRMED" });
  });
});
