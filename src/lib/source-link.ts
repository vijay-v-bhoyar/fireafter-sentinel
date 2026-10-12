export const FIRMS_PUBLIC_SOURCE_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/";

// FIRMS API credentials are path segments, not URL username/password fields.
// Apply to JSON provenance (including old audit snapshots) without mutating it.
export function redactFirmsProvenance<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(
      /https?:\/\/firms\.modaps\.eosdis\.nasa\.gov(?=[:/?#\s"'<>]|$)(?::\d+)?(?:[/?#][^\s"'<>]*)?/gi,
      FIRMS_PUBLIC_SOURCE_URL,
    ) as T;
  }
  if (Array.isArray(value)) {
    // Keep unchanged geometry arrays shared; still inspect every present item so
    // credential-bearing strings in mixed or nested arrays cannot bypass redaction.
    let redacted: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) continue;
      const item = redactFirmsProvenance(value[index]);
      if (item !== value[index]) {
        redacted ??= value.slice();
        redacted[index] = item;
      }
    }
    return (redacted ?? value) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactFirmsProvenance(key),
        redactFirmsProvenance(item),
      ]),
    ) as T;
  }
  return value;
}

export function sourceLinkHref(value?: string | null) {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (!(url.protocol === "http:" || url.protocol === "https:")) return null;
    if (url.username || url.password) return null;
    return redactFirmsProvenance(url.href);
  } catch {
    return null;
  }
}
