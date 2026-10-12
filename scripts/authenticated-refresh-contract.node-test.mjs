import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAuthenticatedReadinessEvidence,
  validateAuthenticatedRefreshEvidence,
} from "./authenticated-refresh-contract.mjs";

function refreshedBundle(overrides = {}) {
  return {
    incident: { id: "incident-utah-county-ut" },
    sourceSnapshots: [{
      sourceKey: "usgs-pwfdf",
      coverageStatus: "available",
      rawPayload: { basinCount: 3 },
    }],
    recommendations: [{
      evidence: [{ sourceKey: "usgs-pwfdf", sourceFeatureId: "pwfdf-Iron-7" }],
    }],
    ...overrides,
  };
}

test("accepts compact refresh evidence with a validated basin and linked recommendation", () => {
  assert.deepEqual(
    validateAuthenticatedRefreshEvidence(refreshedBundle(), "incident-utah-county-ut"),
    { ok: true, basinCount: 3, linkedRecommendationCount: 1 },
  );
});

test("fails closed when refresh returns unavailable PWFDF evidence", () => {
  const result = validateAuthenticatedRefreshEvidence(
    refreshedBundle({
      sourceSnapshots: [{
        sourceKey: "usgs-pwfdf",
        coverageStatus: "not_available",
        rawPayload: { basinCount: 0 },
      }],
    }),
    "incident-utah-county-ut",
  );

  assert.deepEqual(result, { ok: false, failure: "validated_pwfdf_basin_layer_missing" });
});

test("fails closed when no recommendation carries PWFDF feature evidence", () => {
  const result = validateAuthenticatedRefreshEvidence(
    refreshedBundle({ recommendations: [{ evidence: [] }] }),
    "incident-utah-county-ut",
  );

  assert.deepEqual(result, { ok: false, failure: "basin_linked_recommendation_missing" });
});

test("requires the readiness product-promise gate to pass", () => {
  assert.deepEqual(
    validateAuthenticatedReadinessEvidence({
      productPromise: [{ id: "basin_asset_linkage", status: "gap" }],
    }),
    { ok: false, failure: "basin_asset_linkage_not_pass" },
  );
  assert.deepEqual(
    validateAuthenticatedReadinessEvidence({
      productPromise: [{ id: "basin_asset_linkage", status: "pass" }],
    }),
    { ok: true },
  );
});
