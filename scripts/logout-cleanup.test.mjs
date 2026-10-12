import { describe, expect, it, vi } from "vitest";
import { closeAuthenticatedSmokeSession } from "./logout-cleanup.mjs";

describe("authenticated smoke logout", () => {
  it.each(["success", "http", "network", "invalid-json", "unconfirmed", "context-close", "browser-close"])("requires confirmation and closes resources: %s", async (mode) => {
    const post = vi.fn().mockResolvedValue({
      ok: () => mode !== "http",
      json: mode === "invalid-json" ? vi.fn().mockRejectedValue(new Error("private payload")) : async () => ({ ok: mode !== "unconfirmed" }),
    });
    if (mode === "network") post.mockRejectedValue(new Error("private transport"));
    const context = { request: { post }, close: vi.fn().mockResolvedValue(undefined) };
    const browser = { close: vi.fn().mockResolvedValue(undefined) };
    if (mode === "context-close") context.close.mockRejectedValue(new Error("private context"));
    if (mode === "browser-close") browser.close.mockRejectedValue(new Error("private browser"));
    const result = closeAuthenticatedSmokeSession(context, browser, "https://fireafter.example");
    if (mode === "success") await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow(mode.endsWith("close")
      ? "Authenticated smoke browser cleanup failed."
      : "Authenticated smoke sign-out was not confirmed. The session may remain active; operator follow-up is required.");
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith("https://fireafter.example/api/auth/logout", {
      headers: { accept: "application/json" }, timeout: 15_000,
    });
  });
});
