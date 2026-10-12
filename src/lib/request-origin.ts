const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isCrossOriginMutation(request: Request) {
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    return true;
  }

  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return !originsMatch(new URL(origin), new URL(request.url));
  } catch {
    return true;
  }
}

function originsMatch(origin: URL, requestUrl: URL) {
  if (origin.origin === requestUrl.origin) return true;

  return (
    LOOPBACK_HOSTS.has(origin.hostname) &&
    LOOPBACK_HOSTS.has(requestUrl.hostname) &&
    origin.protocol === requestUrl.protocol &&
    origin.port === requestUrl.port
  );
}
