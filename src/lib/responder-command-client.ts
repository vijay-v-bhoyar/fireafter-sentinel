import { ResponderCommandError, responderCommandFailure, responderAuthorityHeaders, type ResponderAuthority, type ResponderCommand } from "./responder-command";
import type { ResponderAction } from "./types";

export async function sendResponderCommand(command: ResponderCommand, fetchImpl: typeof fetch = fetch, authority?: ResponderAuthority): Promise<ResponderAction> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl("/api/actions", {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json", ...(authority ? responderAuthorityHeaders(authority) : {}) },
      body: JSON.stringify(command), signal: controller.signal,
    });
    let result;
    try { result = await response.json(); }
    catch {
      throw response.ok ? new ResponderCommandError("unavailable") : responderCommandFailure(undefined, response.status);
    }
    if (!response.ok) throw responderCommandFailure(result, response.status);
    if (!result || typeof result.id !== "string" || !result.auditEvent ||
      result.auditEvent.payload?.commandId !== command.commandId ||
      result.auditEvent.payload?.expectedRevision !== command.expectedRevision ||
      result.recommendationId !== command.recommendationId || result.action !== command.action ||
      result.note !== command.note || (result.modifiedPriority ?? undefined) !== command.modifiedPriority) {
      throw new ResponderCommandError("unavailable");
    }
    return result as ResponderAction;
  } catch (error) {
    throw error instanceof ResponderCommandError ? error : new ResponderCommandError("unavailable");
  } finally { clearTimeout(timeout); }
}
