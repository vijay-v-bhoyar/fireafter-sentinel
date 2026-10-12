export function parseApiErrorMessage(status: number, body: string) {
  if (body.trim()) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error;
      }
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return parsed.message;
      }
    } catch {
      return `Request failed with ${status}`;
    }
  }

  return `Request failed with ${status}`;
}
