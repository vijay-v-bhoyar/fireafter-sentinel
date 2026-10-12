import { z } from "zod";
import { IdSchema, InstantSchema, ModeSchema, CorrectionTextSchema } from "./contracts";
const id = IdSchema.transform(value => value.toLowerCase());
const age = z.number().int().min(1).max(1440);
const documentRule = z.strictObject({ documentId: id, maxAgeMinutes: age,
  requirePublicationTime: z.boolean(), requireEffectiveInterval: z.boolean() });
const nativeRule = z.strictObject({ sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), maxAgeMinutes: age,
  requireProviderTime: z.boolean(), requireValidUntil: z.boolean() }).superRefine((v, c) => {
    if (["nws", "nws-forecast"].includes(v.sourceKey) && (!v.requireProviderTime || !v.requireValidUntil))
      c.addIssue({ code: "custom", message: "Forecast evidence requires provider time and validity bounds." });
    if (v.sourceKey === "usgs-pwfdf" && !v.requireProviderTime)
      c.addIssue({ code: "custom", message: "Assessment evidence requires provider time." });
  });
export const PolicyConfigurationSchema = z.strictObject({ schemaVersion: z.literal(1), inputBasis: z.enum(["user_authored", "demo"]),
  evaluationAt: InstantSchema.nullable(), documentRules: z.array(documentRule).min(1).max(5),
  nativeRules: z.array(nativeRule).min(1).max(10), note: CorrectionTextSchema.transform(v => v.trim()).refine(v => v.length > 0 && !v.includes("\0") &&
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(v)) === v) })
  .superRefine((v, c) => {
    if (new Set(v.documentRules.map(r => r.documentId)).size !== v.documentRules.length ||
        new Set(v.nativeRules.map(r => r.sourceKey)).size !== v.nativeRules.length)
      c.addIssue({ code: "custom", message: "Policy rules must have unique identities." });
  }).transform(v => ({ ...v, evaluationAt: v.evaluationAt === null ? null : new Date(v.evaluationAt).toISOString(),
    documentRules: [...v.documentRules].sort((a, b) => a.documentId.localeCompare(b.documentId)),
    nativeRules: [...v.nativeRules].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)) }));
export const PolicyCommandSchema = z.strictObject({ incidentId: id, mode: ModeSchema, commandId: id,
  expectedPolicyRevision: id.nullable(), expectedSourceConfiguration: id, expectedEvidenceGeneration: z.number().int().nonnegative().safe(),
  configuration: PolicyConfigurationSchema }).superRefine((v, c) => {
    if (v.mode === "live" ? v.configuration.evaluationAt !== null || v.configuration.inputBasis !== "user_authored" : v.configuration.evaluationAt === null)
      c.addIssue({ code: "custom", message: "Live policy uses the database clock; replay and synthetic policy require a recorded scenario clock." });
  });
export type PolicyConfiguration = z.infer<typeof PolicyConfigurationSchema>;
