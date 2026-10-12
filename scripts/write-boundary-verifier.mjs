import { SECURITY_PROBES } from "./migration-contract-verifier.mjs";

export function buildProbeResult(probe, response) {
  const observedVersion = typeof response?.data === "string" ? response.data : null;
  const failure = response?.error
    ? "security_probe_unavailable"
    : observedVersion === null
      ? "live_controls_not_verified"
      : observedVersion !== probe.expectedVersion
        ? "security_version_mismatch"
        : null;

  return {
    ok: failure === null,
    rpc: probe.rpc,
    expectedVersion: probe.expectedVersion,
    observedVersion,
    failure,
    migration: probe.migration ?? null,
    nextAction: failure ? remediationFor(probe, failure) : null,
  };
}

export function buildVerificationReport(projectHost, probes) {
  const missingControls = SECURITY_PROBES.filter((required) =>
    probes.filter((probe) => probe.rpc === required.rpc).length !== 1);
  const ok = probes.length === SECURITY_PROBES.length && missingControls.length === 0 &&
    SECURITY_PROBES.every((required) => probes.some((probe) =>
      probe.rpc === required.rpc && probe.ok === true &&
      probe.expectedVersion === required.expectedVersion && probe.observedVersion === required.expectedVersion));
  const nextActions = [...new Set([
    ...probes
      .map((probe) => probe.nextAction)
      .filter((action) => typeof action === "string" && action.length > 0),
    ...missingControls.map((probe) => `Run the complete verifier with exactly one result for ${probe.rpc}; do not omit required security controls.`),
  ])];

  return {
    ok,
    projectHost,
    probes,
    failure: ok ? null : "security_controls_unverified",
    nextActions,
  };
}

function remediationFor(probe, failure) {
  const migration = probe.migration ?? "the corresponding FireAfter migration";
  const retry = "npm.cmd run verify:write-boundary";

  if (failure === "security_probe_unavailable") {
    return `Confirm the configured Supabase project and service-role access, apply ${migration} if needed, then rerun ${retry}.`;
  }
  if (failure === "live_controls_not_verified") {
    return `Apply ${migration} to the configured Supabase project, then rerun ${retry}.`;
  }
  return `Reconcile the configured Supabase project with ${migration}, then rerun ${retry}; do not mark the control verified until the exact expected version is returned.`;
}
