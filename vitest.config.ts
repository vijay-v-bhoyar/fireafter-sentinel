import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./scripts/server-only-test-boundary.mjs", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Bound worker memory; keep assertion deadlines and the full suite unchanged.
    maxWorkers: 2,
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.next/**",
      "**/.loop/**", // Immutable repair snapshots are evidence, not executable suites.
      "**/output/**",
      "**/dist/**",
      "build/**",
      "**/scripts/operator-account.test.mjs",
      "**/scripts/auth-smoke-config.test.mjs",
      "**/scripts/verify-server-owned-writes.test.mjs",
      "**/scripts/product-promise-report.test.mjs",
    ],
  },
});
