export async function closeAuthenticatedSmokeSession(context, browser, baseUrl) {
  let logoutConfirmed = false;
  let closed = true;
  try {
    const response = await context.request.post(`${baseUrl}/api/auth/logout`, {
      headers: { accept: "application/json" }, timeout: 15_000,
    });
    logoutConfirmed = response.ok() && (await response.json())?.ok === true;
  } catch {
    logoutConfirmed = false;
  } finally {
    try { await context.close(); } catch { closed = false; }
    try { await browser.close(); } catch { closed = false; }
  }
  if (!logoutConfirmed) {
    throw new Error("Authenticated smoke sign-out was not confirmed. The session may remain active; operator follow-up is required.");
  }
  if (!closed) throw new Error("Authenticated smoke browser cleanup failed.");
}
