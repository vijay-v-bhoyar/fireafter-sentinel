import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { requireSupabaseTarget } from "./src/lib/sentinel/target-policy.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === "development";
const compiledReleaseId = !isDev && /^[a-f0-9]{64}$/.test(process.env.FIREAFTER_BUILD_RELEASE_ID ?? "")
  ? process.env.FIREAFTER_BUILD_RELEASE_ID! : "unbound";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
// Private target checks precede public browser configuration.
const verifiedSupabaseOrigin = supabaseUrl ? requireSupabaseTarget(supabaseUrl, process.env) : "";
const connectSources = ["'self'", ...(supabaseUrl ? [supabaseUrl] : [])].join(" ");
const cspHeader = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://server.arcgisonline.com",
  "font-src 'self' data:",
  `connect-src ${connectSources}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  env: {
    FIREAFTER_COMPILED_RELEASE_ID: compiledReleaseId,
    NEXT_PUBLIC_SENTINEL_VERIFIED_SUPABASE_URL: verifiedSupabaseOrigin,
  },
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: projectRoot,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-FireAfter-Release-ID", value: compiledReleaseId },
          { key: "Content-Security-Policy", value: cspHeader },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          ...(!isDev
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=31536000",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default withWorkflow(nextConfig);
