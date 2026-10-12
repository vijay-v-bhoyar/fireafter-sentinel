export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const primary = stringField(record.message) ?? stringField(record.error);
    const details = stringField(record.details);
    const hint = stringField(record.hint);
    const code = stringField(record.code);
    const messageParts = [
      primary,
      details ? `Details: ${details}` : undefined,
      hint ? `Hint: ${hint}` : undefined,
      code ? `Code: ${code}` : undefined,
    ].filter(Boolean);

    if (messageParts.length > 0) {
      return messageParts.join(" ");
    }
  }

  return fallback;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
