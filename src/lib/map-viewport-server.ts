import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CurrentUser } from "./auth";
import { getSupabaseAdminClient } from "./supabase";
import { canWriteOperationalRecords } from "./role-capabilities";
import { MAP_VIEW_BYTES, MapViewportError, MapViewportQuerySchema, validateMapViewportResponse, type MapViewportQuery } from "./map-viewport-contract";

export async function getMapViewport(raw: MapViewportQuery, user: CurrentUser, callerSignal: AbortSignal) {
  const input = MapViewportQuerySchema.parse(raw);
  if (!canWriteOperationalRecords(user) || !user.organizationId) throw new MapViewportError(403);
  const db = getSupabaseAdminClient();
  if (!db) throw new MapViewportError();
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(12000)]);
  const { data, error } = await (db as unknown as SupabaseClient).rpc("fireafter_read_asset_viewport", {
    p_incident_id: input.incidentId, p_actor_id: user.id, p_organization_id: user.organizationId, p_role: user.role,
    p_revision: input.revision, p_bbox: input.bbox, p_zoom: Number(input.zoom),
  }).abortSignal(signal).retry(false);
  if (signal.aborted) throw new MapViewportError();
  if (error) throw new MapViewportError(error.code === "MV403" ? 403 : error.code === "MV409" ? 409 : error.code === "MV404" ? 404 : 503);
  if (Buffer.byteLength(JSON.stringify(data)) > MAP_VIEW_BYTES) throw new MapViewportError();
  return validateMapViewportResponse(data, input);
}
