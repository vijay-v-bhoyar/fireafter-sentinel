import { beforeEach, describe, expect, it, vi } from "vitest";

const exchangeCodeForSessionMock = vi.fn();
const getSupabaseServerClientMock = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: getSupabaseServerClientMock,
}));

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    getSupabaseServerClientMock.mockResolvedValue({
      auth: { exchangeCodeForSession: exchangeCodeForSessionMock },
    });
  });

  it("exchanges the code and preserves a same-origin destination", async () => {
    const url = new URL("http://localhost/auth/callback");
    url.searchParams.set("code", "one-time-code");
    url.searchParams.set("next", "/settings?panel=auth#evidence");

    const { GET } = await import("./route");
    const response = await GET(new Request(url));

    expect(exchangeCodeForSessionMock).toHaveBeenCalledWith("one-time-code");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/settings?panel=auth#evidence",
    );
  });

  it("accepts the password-recovery destination after exchanging the code", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://fireafter.example/auth/callback?code=one-time-code&next=%2Freset-password"),
    );

    expect(response.headers.get("location")).toBe("https://fireafter.example/reset-password");
  });

  it.each([
    "https://attacker.example/phish",
    "//attacker.example/phish",
    "javascript:alert(1)",
    "\\\\attacker.example\\phish",
  ])("rejects an off-origin next destination: %s", async (next) => {
    const url = new URL("https://fireafter.example/auth/callback");
    url.searchParams.set("code", "one-time-code");
    url.searchParams.set("next", next);

    const { GET } = await import("./route");
    const response = await GET(new Request(url));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://fireafter.example/");
  });

  it("fails closed when the callback code is missing", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/auth/callback?next=/settings"),
    );

    expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?error=Invalid+sign-in+callback",
    );
  });

  it("reports an unavailable auth service instead of silently continuing", async () => {
    getSupabaseServerClientMock.mockResolvedValueOnce(null);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/auth/callback?code=one-time-code"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?error=Responder+authentication+is+unavailable",
    );
  });

  it("reports code-exchange failures instead of creating a false success", async () => {
    exchangeCodeForSessionMock.mockResolvedValueOnce({
      error: new Error("expired code"),
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/auth/callback?code=expired"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?error=Unable+to+complete+sign+in",
    );
  });
});
