import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { requireSupabaseTarget, requireBrowserSupabaseTarget, SentinelTargetError } from "./sentinel/target-policy.mjs";
import { createResponseBudget, OutboundResponseError, responseByteLimit } from "./bounded-response";
import { fetchOperationResponse } from "./refresh-operation";
import { REFRESH_RECOMMENDATION_SELECT } from "./refresh-history";

let adminClient: ReturnType<typeof createClient> | null = null;
let adminIdentity = "";

const DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS = 5000;
const MAX_SUPABASE_REQUEST_TIMEOUT_MS = 60000;

function inventoryReadOperation(url: URL) {
  const table = url.pathname === "/rest/v1/assets" ? "asset_inventory_read" :
    url.pathname === "/rest/v1/recommendations" ? "recommendation_inventory_read" : null;
  if (!table) return null;
  const params = url.searchParams;
  const allowed = new Set(["incident_id", "select", "order", "limit", "id"]);
  if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) return null;
  if (!/^eq\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.get("incident_id") ?? "") ||
    !(params.get("select") === "*" || (table === "recommendation_inventory_read" && params.get("select") === REFRESH_RECOMMENDATION_SELECT)) || params.get("order") !== "id.asc" ||
    !/^[1-9]\d{0,2}$/.test(params.get("limit") ?? "") || Number(params.get("limit")) > 500) return null;
  if (params.has("id") && !/^gt\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.get("id")!)) return null;
  return table;
}

export function getSupabaseRequestTimeoutMs() {
  const configured = Number(process.env.FIREAFTER_SUPABASE_TIMEOUT_MS);
  if (
    Number.isSafeInteger(configured) &&
    configured >= 250 &&
    configured <= MAX_SUPABASE_REQUEST_TIMEOUT_MS
  ) {
    return configured;
  }
  return DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS;
}

function createSupabaseFetch(targetOrigin: string, admin = false): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== targetOrigin) throw new SentinelTargetError();
    if (admin || typeof window === "undefined") {
      if (requireSupabaseTarget(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env) !== targetOrigin) throw new SentinelTargetError();
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const passwordLogin = method === "POST" &&
      url.origin === new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin &&
      url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password";
    const bundleCommit = admin && method === "POST" &&
      url.origin === new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin &&
      ["/rest/v1/rpc/fireafter_commit_bundle", "/rest/v1/rpc/fireafter_commit_import", "/rest/v1/rpc/fireafter_commit_ingestion",
        "/rest/v1/rpc/fireafter_commit_staged_ingestion"].includes(url.pathname);
    const sourceRead = admin && method === "GET" &&
      url.origin === new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin && url.pathname === "/rest/v1/source_snapshots";
    const inventoryRead = admin && method === "GET" &&
      url.origin === new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin ? inventoryReadOperation(url) : null;
    const compactRead = admin && method === "POST" && url.origin === new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin &&
      url.pathname === "/rest/v1/rpc/fireafter_read_refresh_recommendations" && !url.search;
    // Complete inventory pages need transfer time; readRows still caps the entire inventory at 30s.
    const timeoutMs = Math.max(bundleCommit ? 40_000 : sourceRead || inventoryRead || compactRead || passwordLogin ? 20_000 : 0, getSupabaseRequestTimeoutMs());
    const maxBytes = responseByteLimit(process.env.FIREAFTER_SUPABASE_MAX_RESPONSE_BYTES ??
      (sourceRead ? 16 * 1024 * 1024 : undefined));
    try {
      return await fetchOperationResponse(input, { ...init, redirect: "error" }, createResponseBudget(maxBytes, timeoutMs));
    } catch (error) {
      console.warn("[fireafter] Supabase response rejected", {
        code: error instanceof OutboundResponseError ? error.code : "network", timeoutMs, maxBytes,
        operation: passwordLogin ? "password_login" : bundleCommit ? "bundle_commit" : sourceRead ? "source_read" : compactRead ? "compact_refresh_read" : inventoryRead ?? "request",
        requestBytes: typeof init?.body === "string" ? new TextEncoder().encode(init.body).byteLength : undefined,
      });
      throw error;
    }
  };
}

export function getSupabasePublicKey() {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ""
  );
}

export function hasSupabaseEnv() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      getSupabasePublicKey(),
  );
}

export function hasSupabaseAdminEnv() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export function getSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabasePublicKey();
  if (!url || !key) return null;
  const origin = requireBrowserSupabaseTarget(url, process.env.NEXT_PUBLIC_SENTINEL_VERIFIED_SUPABASE_URL);
  return createBrowserClient(url, key, {
    global: { fetch: createSupabaseFetch(origin) },
  });
}

export async function getSupabaseServerClient(options: { requireCookieWrites?: boolean } = {}) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabasePublicKey();
  if (!url || !key) return null;
  const origin = requireSupabaseTarget(url, process.env);
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    global: { fetch: createSupabaseFetch(origin) },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(items) {
        try {
          items.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          if (options.requireCookieWrites) throw new Error("Session cookie update failed");
          // Server Components cannot always set cookies; route handlers can.
        }
      },
    },
  });
}

export function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const origin = requireSupabaseTarget(url, process.env);
  const identity = origin + "|" + key;
  if (!adminClient || adminIdentity !== identity) {
    adminIdentity = identity;
    adminClient = createClient(url, key, {
      global: { fetch: createSupabaseFetch(origin, true) },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return adminClient;
}
