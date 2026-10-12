import { z } from "zod";

export const ASSET_PAGE_BYTES = 4 * 1024 * 1024;
export const ASSET_PAGE_UNAVAILABLE = "Asset inventory could not be read within its limits. Retry with a smaller page, or ask an operator to check the stored records. No records were changed.";
export class AssetInventoryError extends Error {
  constructor(readonly status: number, message = ASSET_PAGE_UNAVAILABLE) { super(message); }
}
export const AssetInventoryQuerySchema = z.object({
  incidentId: z.string().trim().min(1).max(256),
  start: z.string().regex(/^(?:0|[1-9]\d{0,4})$/).default("0"),
  limit: z.enum(["1", "10", "25", "50"]).default("25"),
  revision: z.uuid().optional(),
}).strict().refine(value => value.start === "0" || Boolean(value.revision), { message: "A continuation requires its published revision." });
export type AssetInventoryQuery = z.infer<typeof AssetInventoryQuerySchema>;

const evidenceSchema = z.object({ sourceKey: z.string(), sourceName: z.string(), sourceUrl: z.string().optional(),
  sourceFeatureId: z.string().optional(), sourcePartIndex: z.number().int().nonnegative().optional(), summary: z.string() }).strict();
export const AssetInventoryRecordSchema = z.object({
  id: z.string().min(1), name: z.string(), type: z.enum(["Road Crossing", "Culvert", "Bridge", "Evacuation Route", "Critical Facility", "Inferred Crossing"]),
  locationLabel: z.string(), coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  source: z.string(), confidence: z.enum(["High", "Medium", "Low"]), localOrUploaded: z.boolean(),
  sourceKey: z.string().optional(), sourceUrl: z.string().optional(), sourceFeatureId: z.string().optional(),
  sourceFeatureIds: z.array(z.string()), confidenceReason: z.string().optional(), evidence: z.array(evidenceSchema),
}).strict();
export const AssetInventoryItemSchema = z.discriminatedUnion("status", [
  z.object({ position: z.number().int().positive(), status: z.literal("available"), asset: AssetInventoryRecordSchema }).strict(),
  z.object({ position: z.number().int().positive(), status: z.literal("withheld"), reason: z.enum(["non-operational", "unverified-geometry", "outside-county"]) }).strict(),
]);
export const AssetInventoryPageSchema = z.object({
  incidentId: z.string().min(1).max(256), canonicalIncidentId: z.string().min(1).max(256),
  county: z.string(), state: z.string(), title: z.string(), publishedAt: z.string().nullable(),
  revision: z.uuid(), start: z.number().int().min(0).max(99999), limit: z.number().int().min(1).max(50),
  totalStoredAssets: z.number().int().min(0).max(100000),
  items: z.array(AssetInventoryItemSchema).max(50), nextStart: z.number().int().positive().max(99999).nullable(),
}).strict();
export type AssetInventoryPage = z.infer<typeof AssetInventoryPageSchema>;
