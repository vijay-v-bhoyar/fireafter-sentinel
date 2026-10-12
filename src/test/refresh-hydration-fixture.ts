import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import type { FireAfterSupabasePayload } from "../lib/fireafter-supabase";
import type { getSupabaseAdminClient } from "../lib/supabase";
import { fetchOperationResponse } from "../lib/refresh-operation";
import { createResponseBudget } from "../lib/bounded-response";
import { REFRESH_RECOMMENDATION_SELECT } from "../lib/refresh-history";

// Local HTTP fixture exercises the actual SDK query/response path. It is not a
// PostgREST/PostGIS or hosted authorization substitute.
export async function hydrationFixture(payload: FireAfterSupabasePayload, options: {
  cap?: number; defect?: string; bounded?: boolean;
  rpc?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const requests: URL[] = [];
  const assets = new Map(payload.assets.map(row => [row.id, row]));
  let parentReads = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost"); requests.push(url);
    if (request.method === "POST" && url.pathname.startsWith("/rest/v1/rpc/") && options.rpc) {
      try {
        let body = "";
        for await (const chunk of request) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 4096) throw new Error("Local RPC fixture request too large");
        }
        const value = await options.rpc(url.pathname.split("/").at(-1)!, JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ code: failure.code ?? "TEST", message: failure.message }));
      }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
    const table = url.pathname.split("/").at(-1);
    let rows: unknown[], count: number;
    if (table === "incidents") {
      parentReads++;
      const row = structuredClone(payload.incident);
      if (options.defect === "foreign" || (options.defect === "authority-drift" && parentReads > 2)) row.organization_id = "30000000-0000-4000-8000-000000000001";
      if (options.defect === "drift" && parentReads > 2) row.title = "Changed while reading";
      rows = options.defect === "missing-incident" ? [] : [row]; count = rows.length;
    } else {
      const values = table === "source_snapshots" ? payload.sourceSnapshots : table === "assets" ? payload.assets : table === "recommendations" ? payload.recommendations : null;
      if (!values || url.searchParams.get("incident_id") !== `eq.${payload.incident.id}`) { response.writeHead(400).end(); return; }
      const after = url.searchParams.get("id")?.slice(3);
      const ordered = [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).filter(row => !after || row.id > after);
      count = ordered.length;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), options.cap ?? 500);
      rows = request.method === "HEAD" ? [] : structuredClone(ordered.slice(0, limit));
      if (table === "recommendations" && url.searchParams.get("select") === REFRESH_RECOMMENDATION_SELECT) {
        rows = (rows as typeof payload.recommendations).map(row => {
          const related = assets.get(row.asset_id);
          const asset = related ? { id: related.id, incident_id: related.incident_id, name: related.name, asset_type: related.asset_type,
            location_label: related.location_label, local_or_uploaded: related.local_or_uploaded, origin: related.origin, source_key: related.source_key,
            coordinates: related.properties.coordinates, domainAssetId: related.properties.domainAssetId, propertySourceKey: related.properties.sourceKey } : null;
          return { ...row, asset: structuredClone(asset) };
        });
        if (options.defect === "missing-related" && rows.length) (rows[0] as { asset: unknown }).asset = null;
      }
      if (options.defect === "wrong-count" && table === "assets" && after) count++;
      if (options.defect === "wrong-final-count" && table === "assets" && request.method === "HEAD") count++;
      if (options.defect === "empty-page" && count && table === "assets") rows = [];
      if (options.defect === "duplicate" && rows.length && table === "assets") rows.push(rows[0]);
      if (options.defect === "wrong-incident" && rows.length && table === "assets") (rows[0] as { incident_id: string }).incident_id = "30000000-0000-4000-8000-000000000001";
    }
    response.writeHead(200, { "content-type": "application/json", "content-range": `0-${Math.max(0, rows.length - 1)}/${count}` });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify(rows));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fixture port unavailable");
  const client = createClient(`http://127.0.0.1:${address.port}`, "local-fixture-only", {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(options.bounded ? { global: { fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetchOperationResponse(input, init, createResponseBudget(16 * 1024 * 1024, 20_000)) } } : {}),
  });
  return { client: client as NonNullable<ReturnType<typeof getSupabaseAdminClient>>, requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
