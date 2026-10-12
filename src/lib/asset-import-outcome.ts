import { z } from "zod";

export const IMPORT_REFRESH_UNCONFIRMED = "Assets were saved, but refresh completion is unconfirmed. Do not import them again. Reload and check the current evidence, then refresh if needed.";
export const IMPORT_OUTCOME_UNCONFIRMED = "Asset import outcome is unconfirmed. Check History and Operational Health before resubmitting; a failed response does not prove rollback.";

export const AssetImportOutcomeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("no_changes"), refresh: z.literal("not_attempted") }).strict(),
  z.object({ state: z.literal("persisted"), refresh: z.enum(["completed", "unconfirmed"]), auditEventId: z.string().min(1).max(512) }).strict(),
  z.object({ state: z.literal("local_fixture"), refresh: z.literal("completed") }).strict(),
]);
export type AssetImportOutcome = z.infer<typeof AssetImportOutcomeSchema>;

export function validateAssetImportOutcome(value: unknown, assetCount: number, auditEventId: string | null | undefined, hasBundle: boolean): AssetImportOutcome {
  const result = AssetImportOutcomeSchema.safeParse(value);
  if (!result.success || !Number.isSafeInteger(assetCount) || assetCount < 0) throw new Error(IMPORT_OUTCOME_UNCONFIRMED);
  const outcome = result.data;
  if ((outcome.state === "no_changes" && (assetCount !== 0 || auditEventId != null)) ||
    (outcome.state === "persisted" && (assetCount === 0 || auditEventId !== outcome.auditEventId)) ||
    (outcome.state === "local_fixture" && process.env.NODE_ENV === "production") ||
    (outcome.refresh === "completed") !== hasBundle) throw new Error(IMPORT_OUTCOME_UNCONFIRMED);
  return outcome;
}
