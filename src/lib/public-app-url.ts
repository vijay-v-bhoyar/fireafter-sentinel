const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function getPublicAppOrigin(value = process.env.FIREAFTER_PUBLIC_APP_URL) {
  if (!value) return null;

  try {
    const url = new URL(value);
    const isCanonicalOrigin =
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password;
    const allowsLocalHttp =
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname);

    if (!isCanonicalOrigin || (url.protocol !== "https:" && !allowsLocalHttp)) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function getPasswordRecoveryRedirectUrl() {
  const origin = getPublicAppOrigin();
  if (!origin) return null;

  const redirectUrl = new URL("/auth/callback", origin);
  redirectUrl.searchParams.set("next", "/reset-password");
  return redirectUrl.toString();
}
