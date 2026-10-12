import "server-only";

type Operation = "bundle_read" | "bundle_mapping" | "dashboard_read" | "user_projection" | "client_projection";
type Phase = "incident" | "inventory" | "actions" | "revision_fence" | "mapping" | "cache_store" |
  "decode" | "credential_redaction" | "identity" | "assets" | "sources" | "recommendations" |
  "database" | "county_scope" | "projection" | "freshness" | "user_lookup" | "ownership" |
  "public_redaction" | "hazard_and_source_projection" | "history";
type Counts = { sourceCacheHit?: boolean; assets?: number; recommendations?: number; sources?: number };

export function startReadDiagnostics(operation: Operation) {
  const enabled = process.env.FIREAFTER_READ_DIAGNOSTICS === "true";
  const start = enabled ? performance.now() : 0;
  let previous = start;
  let finished = false;
  const phases: Partial<Record<Phase, number>> = {};
  return {
    mark(phase: Phase) {
      if (!enabled || finished) return;
      const now = performance.now();
      phases[phase] = Math.max(0, Math.round(now - previous));
      previous = now;
    },
    finish(counts: Counts = {}) {
      if (!enabled || finished) return;
      finished = true;
      // Keep diagnostics independent of application success and never spread caller data.
      try {
        const safeCounts: Counts = {};
        for (const key of ["assets", "recommendations", "sources"] as const) {
          const value = counts[key];
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safeCounts[key] = value;
        }
        if (typeof counts.sourceCacheHit === "boolean") safeCounts.sourceCacheHit = counts.sourceCacheHit;
        console.info("[fireafter] read timing", {
          operation, totalMs: Math.max(0, Math.round(performance.now() - start)), phases, ...safeCounts,
        });
      } catch { /* Optional diagnostics must not change the read outcome. */ }
    },
  };
}
