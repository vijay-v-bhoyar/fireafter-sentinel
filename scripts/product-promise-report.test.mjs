import assert from "node:assert/strict";
import test from "node:test";
import { formatProductPromiseGateIssue } from "./product-promise-report.mjs";

test("renders safe gate gaps, evidence, and next action", () => {
  assert.equal(
    formatProductPromiseGateIssue({
      id: "basin_asset_linkage",
      label: "Basin-to-asset linkage",
      gaps: ["No linked recommendation."],
      evidence: ["285 basins and 65 assets loaded."],
      nextAction: "Select a published perimeter and run Refresh.",
    }),
    "Basin-to-asset linkage not pass: No linked recommendation. Evidence: 285 basins and 65 assets loaded. Next action: Select a published perimeter and run Refresh.",
  );
});

test("fails closed to actionable generic text when optional fields are absent", () => {
  assert.equal(
    formatProductPromiseGateIssue({ id: "auditability", label: "Auditability" }),
    "Auditability not pass: no evidence Evidence: No supporting evidence was returned. Next action: Review the Product Promise panel for the required remediation.",
  );
});
