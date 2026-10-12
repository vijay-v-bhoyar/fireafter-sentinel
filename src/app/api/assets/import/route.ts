import { z } from "zod";
import { AuthError, requireIncidentAccess } from "@/lib/auth";
import { importIncidentAssets, toClientDashboardBundle } from "@/lib/fireafter-data";
import {
  ASSET_IMPORT_BODY_BYTES,
  ASSET_IMPORT_CONTENT_CHARS,
  RequestTooLargeError,
  assertTextWithinLimit,
  readBoundedRequestBody,
  requestBodyFailure,
} from "@/lib/request-limits";
import { isCrossOriginMutation } from "@/lib/request-origin";
import { InventoryCapacityError } from "@/lib/inventory-error";
import { BundleWriteError } from "@/lib/bundle-write";
import { IMPORT_OUTCOME_UNCONFIRMED } from "@/lib/asset-import-outcome";
import { RefreshOperationError } from "@/lib/refresh-operation";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

const ImportRequest = z.object({
  operationId: z.uuid(),
  incidentId: z.string().min(1).max(256),
  fileName: z.string().min(1).max(255),
  content: z.string().min(1).max(ASSET_IMPORT_CONTENT_CHARS),
});

export async function POST(request: Request) {
  if (isCrossOriginMutation(request)) {
    return Response.json({ error: "Cross-origin request rejected" }, { status: 403, headers });
  }
  let body: unknown;
  try {
    body = await readImportRequest(request);
  } catch (error) {
    const failure = requestBodyFailure(error, "Asset import is too large");
    if (failure) return Response.json({ error: failure.message }, { status: failure.status, headers });
    return Response.json({ error: "Invalid asset import" }, { status: 400, headers });
  }

  const parsed = ImportRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid asset import" }, { status: 400, headers });
  }

  try {
    const user = await requireIncidentAccess(parsed.data.incidentId);
    const result = await importIncidentAssets({
        ...parsed.data,
        actorName: user.email,
        actorOrganizationId: user.organizationId ?? undefined,
        principal: { kind: "user", actorId: user.id, organizationId: user.organizationId ?? "" },
      }, request.signal);
    return Response.json({
      ...result,
      bundle: result.bundle ? toClientDashboardBundle(result.bundle) : result.bundle,
    }, { headers });
  } catch (error) {
    const isAuthError = error instanceof AuthError;
    if (error instanceof RefreshOperationError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    if (error instanceof BundleWriteError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    if (error instanceof InventoryCapacityError) {
      console.warn("[fireafter] import inventory unavailable", { code: error.code });
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    }
    if (!isAuthError) {
      console.error("[fireafter] asset import unconfirmed", { operation: "asset_import", code: "import_unconfirmed" });
    }
    return Response.json(
      {
        error: isAuthError
          ? error.message
          : IMPORT_OUTCOME_UNCONFIRMED,
      },
      { status: isAuthError ? error.status : 500, headers },
    );
  }
}

async function readImportRequest(request: Request) {
  const body = await readBoundedRequestBody(request, ASSET_IMPORT_BODY_BYTES);
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await body.formData();
    const file = form.get("file");
    if (file instanceof File) {
      if (file.size > ASSET_IMPORT_CONTENT_CHARS) {
        throw new RequestTooLargeError();
      }
    }
    const content =
      file instanceof File
        ? await file.text()
        : String(form.get("content") ?? "");
    assertTextWithinLimit(content, ASSET_IMPORT_CONTENT_CHARS);
    return {
      operationId: String(form.get("operationId") ?? ""),
      incidentId: String(form.get("incidentId") ?? ""),
      fileName:
        file instanceof File
          ? file.name
          : String(form.get("fileName") ?? "uploaded-assets.txt"),
      content,
    };
  }

  return body.json();
}
