import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getIncidentAuthorizationContext } from "./fireafter-supabase";
import { getSupabaseAdminClient } from "./supabase";
import { BundleWriteError, bundleWriteFailure, type BundlePrincipal } from "./bundle-write";
import { IMPORT_RECEIPT_RPC, readImportReceipt } from "./import-operation";

export function importRequestHash(databaseIncidentId: string, fileName: string, content: string) {
  return createHash("sha256").update(JSON.stringify(["fireafter-import-v1", databaseIncidentId, fileName, content])).digest("hex");
}

export async function lookupImportOperation(input: { incidentId: string; operationId: string; principal: BundlePrincipal; fileName?: string; content?: string }) {
  if (!z.uuid().safeParse(input.operationId).success || input.principal.kind !== "user" ||
    !z.uuid().safeParse(input.principal.actorId).success || !z.uuid().safeParse(input.principal.organizationId).success) throw new BundleWriteError("FB400");
  const context = await getIncidentAuthorizationContext(input.incidentId);
  if (!context) throw new BundleWriteError("FB404");
  if (context.organizationId !== input.principal.organizationId) throw new BundleWriteError("FB401");
  const requestHash = input.fileName !== undefined && input.content !== undefined
    ? importRequestHash(context.databaseIncidentId, input.fileName, input.content) : undefined;
  const client = getSupabaseAdminClient();
  if (!client) throw new BundleWriteError("FB503");
  try {
    const { data, error } = await client.rpc(IMPORT_RECEIPT_RPC as never, {
      p_actor_id: input.principal.actorId, p_organization_id: context.organizationId,
      p_incident_id: context.databaseIncidentId, p_operation_id: input.operationId,
    } as never);
    if (error) throw error;
    const receipt = data === null ? null : readImportReceipt(data, { operationId: input.operationId, incidentId: context.databaseIncidentId });
    if (receipt && requestHash !== undefined && receipt.requestHash !== requestHash) throw new BundleWriteError("FB408");
    return { context, requestHash, receipt };
  } catch (error) {
    const failure = bundleWriteFailure(error);
    console.warn("[fireafter] import receipt lookup unavailable", { operation: "import_receipt", code: failure.code });
    throw failure;
  }
}
