import { z } from "zod";

export const IMPORT_COMMIT_RPC = "fireafter_commit_import";
export const IMPORT_RECEIPT_RPC = "fireafter_read_import_receipt";
export const IMPORT_RECOVERY_UNCONFIRMED = "Asset import outcome is unconfirmed. Keep the operation reference and check its status. A missing receipt does not prove rollback. Retry only this same operation with the original input.";
export const IMPORT_STORAGE_UNAVAILABLE = "Import recovery storage is unavailable. No import was sent. Enable browser storage and retry, or contact your operator.";
export const ImportOperationSchema = z.object({ operationId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ImportOperation = z.infer<typeof ImportOperationSchema>;
export const ImportReceiptSchema = z.object({
  operationId: z.uuid(), incidentId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  auditEventId: z.uuid(), revision: z.uuid(), assetCount: z.number().int().min(1).max(100_000),
  committedAt: z.iso.datetime({ offset: true }),
}).strict();
export type ImportReceipt = z.infer<typeof ImportReceiptSchema>;

export function readImportReceipt(value: unknown, expected: { operationId: string; incidentId?: string; requestHash?: string }): ImportReceipt {
  const parsed = ImportReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.operationId !== expected.operationId ||
    (expected.incidentId !== undefined && parsed.data.incidentId !== expected.incidentId) ||
    (expected.requestHash !== undefined && parsed.data.requestHash !== expected.requestHash)) {
    throw new Error(IMPORT_RECOVERY_UNCONFIRMED);
  }
  return parsed.data;
}
