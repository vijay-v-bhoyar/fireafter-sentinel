/** Destination checks shared by the application and its operator entrypoints.
 * Identifiers are configuration, never credentials. No network call occurs here.
 */
export class SentinelTargetError extends Error {
  constructor() { super("Sentinel destination is missing, protected or mismatched. Configure the distinct target registry."); this.name = "SentinelTargetError"; }
}

/** @param {string | undefined} value @param {boolean} allowLoopback */
export function targetOrigin(value, allowLoopback = false) {
  try {
    if (!value || value !== value.trim()) throw new SentinelTargetError();
    const url = new URL(value);
    const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        !(url.protocol === "https:" || (url.protocol === "http:" && loopback && allowLoopback)) ||
        (!loopback && (/^[\d.]+$/.test(url.hostname) || url.hostname.includes(":") || !url.hostname.includes(".") ||
          /(?:\.localhost|\.local|\.internal)$/.test(url.hostname))) || (loopback && !allowLoopback)) throw new SentinelTargetError();
    return url.origin;
  } catch { throw new SentinelTargetError(); }
}

/** @param {string | undefined} value */
function protectedOrigins(value) {
  if (!value) throw new SentinelTargetError();
  return value.split(",").map(part => targetOrigin(part.trim(), true));
}

/** @param {string} url @param {Record<string, string | undefined>} env */
export function requireSupabaseTarget(url, env = process.env) {
  const local = env.SENTINEL_ALLOW_LOCAL_DB === "true" && env.NODE_ENV !== "production";
  const expected = targetOrigin(env.SENTINEL_TARGET_SUPABASE_URL, local);
  const actual = targetOrigin(url, local);
  const denied = protectedOrigins(env.SENTINEL_PROTECTED_SUPABASE_URLS);
  if (actual !== expected || denied.includes(actual) || actual === "https://fireafter-app.vercel.app" ||
      (!actual.startsWith("http:") && !/^[a-z0-9-]+\.supabase\.co$/.test(new URL(actual).hostname))) throw new SentinelTargetError();
  return actual;
}

/** The verified origin is emitted only by next.config after private target checks.
 * @param {string} url @param {string | undefined} verifiedOrigin */
export function requireBrowserSupabaseTarget(url, verifiedOrigin) {
  const actual = targetOrigin(url, true);
  if (actual !== targetOrigin(verifiedOrigin, true) || actual === "https://fireafter-app.vercel.app") throw new SentinelTargetError();
  return actual;
}

/** @param {string} url @param {Record<string, string | undefined>} env */
export function requireAppTarget(url, env = process.env) {
  const expected = targetOrigin(env.SENTINEL_TARGET_APP_URL, true);
  const actual = targetOrigin(url, true);
  const loopback = ["127.0.0.1", "[::1]"].includes(new URL(actual).hostname);
  const denied = ["https://fireafter-app.vercel.app", "http://127.0.0.1:3010", "http://[::1]:3010",
    ...(loopback && !env.SENTINEL_PROTECTED_APP_URLS ? [] : protectedOrigins(env.SENTINEL_PROTECTED_APP_URLS))];
  if (actual !== expected || denied.includes(actual)) throw new SentinelTargetError();
  return actual;
}
