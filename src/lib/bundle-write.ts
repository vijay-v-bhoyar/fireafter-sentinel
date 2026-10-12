import { z } from "zod";
import { ImportOperationSchema } from "./import-operation";

export type BundlePrincipal =
  | { kind: "user"; actorId: string; organizationId: string }
  | { kind: "cron" };
export type BundlePersistence = {
  organizationId: string;
  expectedRevision: string | null;
  databaseIncidentId?: string;
  rowIds?: Record<"asset" | "recommendation" | "source", Record<string, string>>;
};
export type BundleOperation = "create" | "refresh" | "import" | "fire_context";
const RowIdsSchema = z.custom<Record<string, string>>((value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "__proto__"))
  .pipe(z.record(z.string().min(1), z.uuid())).refine((ids) =>
  Object.keys(ids).length <= 100_000 && new Set(Object.values(ids).map((id) => id.toLowerCase())).size === Object.keys(ids).length);
const WriteSchema = z.object({
  actorId: z.uuid().nullable(), organizationId: z.uuid(), expectedRevision: z.uuid().nullable(),
  databaseIncidentId: z.uuid().optional(),
  importOperation: ImportOperationSchema.optional(),
  rowIds: z.object({ asset: RowIdsSchema, recommendation: RowIdsSchema, source: RowIdsSchema }).strict().optional(),
  operation: z.enum(["create", "refresh", "import", "fire_context", "cron_refresh"]),
}).strict().refine((value) => (value.operation === "cron_refresh") === (value.actorId === null))
  .refine((value) => (value.operation === "import") === (value.importOperation !== undefined))
  .refine((value) => value.operation !== "create" || (value.expectedRevision === null && value.databaseIncidentId === undefined && value.rowIds === undefined));
export type BundleWrite = z.infer<typeof WriteSchema>;

const failures = {
  FB400: [400, "Bundle write context is invalid. Reload the incident and retry through the authorized workflow."],
  FB401: [403, "Your incident write access is no longer valid. Ask an operator to verify membership before retrying."],
  FB404: [404, "The incident or organization no longer exists. Reload before continuing."],
  FB408: [409, "This import operation reference belongs to different input. Check the original operation status; do not reuse its reference for a changed import."],
  FB409: [409, "The incident changed during this operation. Reload and review the current evidence before retrying."],
  FB503: [503, "The bundle write outcome is unconfirmed. Check History and Operational Health before retrying; a failed response does not prove rollback."],
} as const;
export class BundleWriteError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof failures) {
    super(failures[code][1]);
    this.name = "BundleWriteError";
    this.status = failures[code][0];
  }
}
export function validateBundleWrite(value: unknown): BundleWrite {
  const parsed = WriteSchema.safeParse(value);
  if (!parsed.success) throw new BundleWriteError("FB400");
  return parsed.data;
}
export function bundleWrite(principal: BundlePrincipal, persistence: BundlePersistence | undefined, operation: BundleOperation, importOperation?: z.infer<typeof ImportOperationSchema>): BundleWrite {
  if (!persistence || !principal || (principal.kind !== "user" && principal.kind !== "cron")) throw new BundleWriteError("FB400");
  if (principal.kind === "cron" && operation !== "refresh") throw new BundleWriteError("FB401");
  if (principal.kind === "user" && principal.organizationId !== persistence.organizationId) throw new BundleWriteError("FB401");
  return validateBundleWrite({ ...persistence, ...(importOperation ? { importOperation } : {}), actorId: principal.kind === "user" ? principal.actorId : null,
    operation: principal.kind === "cron" ? "cron_refresh" : operation });
}
export function bundleWriteFailure(error: unknown): BundleWriteError {
  if (error instanceof BundleWriteError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return new BundleWriteError(typeof code === "string" && Object.hasOwn(failures, code) ? code as keyof typeof failures : "FB503");
}
