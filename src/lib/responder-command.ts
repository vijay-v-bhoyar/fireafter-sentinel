import { z } from "zod";

export const ResponderCommandSchema = z.object({
  commandId: z.uuid(),
  expectedRevision: z.uuid(),
  recommendationId: z.string().min(1).max(256),
  action: z.enum(["accept", "modify", "reject", "annotate"]),
  note: z.string().max(2000).default(""),
  modifiedPriority: z.enum(["Very High", "High", "Medium", "Low", "Very Low"]).optional(),
}).refine((value) => value.action === "modify"
  ? value.note.trim().length > 0 && value.modifiedPriority !== undefined
  : value.modifiedPriority === undefined, { message: "Modification requires a note and priority; other actions cannot change priority." });

export type ResponderCommand = z.infer<typeof ResponderCommandSchema>;

export type ResponderAuthority = { actorId: string; organizationId: string };
export function responderAuthorityHeaders(authority: ResponderAuthority) {
  return { "x-fireafter-actor": authority.actorId, "x-fireafter-organization": authority.organizationId };
}
export function assertResponderAuthority(request: Request, user: { id: string; organizationId: string | null }) {
  if (!user.organizationId || request.headers.get("x-fireafter-actor") !== user.id ||
    request.headers.get("x-fireafter-organization") !== user.organizationId) throw new ResponderCommandError("FA401");
}

const errors = {
  AUTH_REQUIRED: { status: 401, message: "Sign in again before submitting a decision. If an earlier attempt was uncertain, reconcile that original command before creating a replacement." },
  NOT_FOUND: { status: 404, message: "This recommendation is no longer available. Ask an operator to verify the incident and any earlier command before submitting another decision." },
  FA401: { status: 403, message: "Your authority changed. Ask your operator to verify your organization access before submitting another decision." },
  FA409: { status: 409, message: "The recommendation inventory changed. Reload and review the current evidence before submitting a new decision." },
  FA408: { status: 409, message: "This command ID belongs to a different decision. Retry the original command or review History & Audit; do not change an uncertain command." },
  FA422: { status: 400, message: "Invalid responder command. Review the note, priority and current recommendation." },
  unavailable: { status: 503, message: "Responder command outcome could not be confirmed. Retry this same command. An operator must verify migration 20260914010000 and database connectivity; do not use the legacy action RPC." },
} as const;

export class ResponderCommandError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code].message);
    this.name = "ResponderCommandError";
    this.status = errors[code].status;
  }
}

export function responderCommandFailure(error: unknown, httpStatus?: number) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "AUTH_REQUIRED" || code === "NOT_FOUND" || code === "FA401" || code === "FA409" || code === "FA408" || code === "FA422") {
    return new ResponderCommandError(code);
  }
  // Older route responses and gateways may reject before producing our JSON contract.
  return new ResponderCommandError(httpStatus === 401 ? "AUTH_REQUIRED"
    : httpStatus === 403 ? "FA401" : httpStatus === 404 ? "NOT_FOUND"
      : httpStatus === 400 || httpStatus === 413 ? "FA422" : "unavailable");
}
