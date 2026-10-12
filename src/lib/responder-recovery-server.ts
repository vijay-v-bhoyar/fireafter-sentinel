import "server-only";
import { z } from "zod";
import { getIncidentAuthorizationContext, mapResponderCommandReceipt } from "./fireafter-supabase";
import { getSupabaseAdminClient } from "./supabase";
import { ATOMIC_RESPONDER_ACTION_SECURITY_RPC } from "./operational-write-security";
import { ResponderCommandSchema, ResponderCommandError, responderCommandFailure } from "./responder-command";
import { redactFirmsProvenance } from "./source-link";

const ReceiptReferenceSchema = z.object({
  actor_id: z.uuid(), organization_id: z.uuid(), incident_id: z.uuid(), command_id: z.uuid(), expected_revision: z.uuid(),
  request: z.object({ recommendationId: z.uuid(), action: z.enum(["accept", "modify", "reject", "annotate"]),
    note: z.string().max(2000), modifiedPriority: z.enum(["Very High", "High", "Medium", "Low", "Very Low"]).nullable() }).strict(),
}).strict();

export async function lookupResponderCommandReceipt(input: { incidentId: string; commandId: string; actorId: string; organizationId: string }) {
  if (![input.commandId, input.actorId, input.organizationId].every(value => z.uuid().safeParse(value).success)) throw new ResponderCommandError("FA422");
  try {
    const context = await getIncidentAuthorizationContext(input.incidentId);
    if (!context) throw new ResponderCommandError("NOT_FOUND");
    if (context.organizationId !== input.organizationId) throw new ResponderCommandError("FA401");
    const identity = { databaseIncidentId: z.uuid().parse(context.databaseIncidentId),
      canonicalIncidentId: z.string().min(1).max(256).parse(context.domainIncidentId) };
    const client = getSupabaseAdminClient();
    if (!client) throw new ResponderCommandError("unavailable");
    const { data, error } = await client.from("responder_command_receipts" as never)
      .select("actor_id,organization_id,incident_id,command_id,expected_revision,request")
      .eq("actor_id", input.actorId).eq("command_id", input.commandId)
      .eq("organization_id", input.organizationId).eq("incident_id", context.databaseIncidentId).maybeSingle();
    if (error) throw error;
    if (data === null) return { ...identity, receipt: null }; // Absence is uncertain, never permission to replace a command.
    const row = ReceiptReferenceSchema.parse(data);
    if (row.actor_id !== input.actorId || row.organization_id !== input.organizationId ||
      row.incident_id !== context.databaseIncidentId || row.command_id !== input.commandId) throw new ResponderCommandError("unavailable");
    const command = ResponderCommandSchema.parse({ ...row.request, modifiedPriority: row.request.modifiedPriority ?? undefined,
      commandId: row.command_id, expectedRevision: row.expected_revision });
    // No receipt content crosses the API until the existing transaction rechecks
    // current membership and incident ownership. Null rows cannot create a decision.
    const rpcClient = client as unknown as { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };
    const result = await rpcClient.rpc(ATOMIC_RESPONDER_ACTION_SECURITY_RPC, {
      p_command_id: row.command_id, p_actor_id: input.actorId, p_organization_id: input.organizationId,
      p_expected_revision: row.expected_revision, p_request: row.request, p_action: null, p_audit_event: null,
    });
    if (result.error) throw result.error;
    if (result.data === null) throw new ResponderCommandError("unavailable");
    z.object({ auditEvent: z.object({ incident_id: z.literal(context.databaseIncidentId) }) }).parse(result.data);
    const mapped = mapResponderCommandReceipt(result.data, input.actorId, row.request.recommendationId, command);
    if (mapped.auditEvent.incidentId !== context.domainIncidentId || mapped.recommendationSnapshot.incidentId !== context.domainIncidentId) throw new ResponderCommandError("unavailable");
    console.info("[fireafter] responder receipt confirmed", { operation: "responder_receipt", code: "committed", commandId: row.command_id });
    return { ...identity, receipt: redactFirmsProvenance(mapped) };
  } catch (error) {
    const failure = error instanceof ResponderCommandError ? error : responderCommandFailure(error);
    console.warn("[fireafter] responder receipt unavailable", { operation: "responder_receipt", code: failure.code });
    throw failure;
  }
}
