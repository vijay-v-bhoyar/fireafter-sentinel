const SAFE_NAVIGATION_ORIGIN = "https://fireafter.internal";
const MAX_INTERNAL_PATH_LENGTH = 2048;

export function safeInternalPath(value: unknown, fallback = "/") {
  if (typeof value !== "string") return fallback;

  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > MAX_INTERNAL_PATH_LENGTH ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return fallback;
  }

  try {
    const destination = new URL(candidate, SAFE_NAVIGATION_ORIGIN);
    if (destination.origin !== SAFE_NAVIGATION_ORIGIN) return fallback;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
}
