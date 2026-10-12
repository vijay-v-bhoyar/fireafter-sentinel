import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

test("FA23 retirement: package does not expose the uncoordinated seed issuer", () => {
  const { scripts } = JSON.parse(read("package.json"));
  assert.equal(Object.hasOwn(scripts, "seed:demo"), false);
  assert.equal(Object.values(scripts).some(command => command.includes("seed-demo.mjs")), false);
});

test("FA23 retirement: direct legacy invocation cannot load credentials or mutate Auth", () => {
  const retired = new URL("scripts/seed-demo.mjs", root);
  // Never execute the unsafe pre-fix issuer, even with test credentials.
  assert.equal(existsSync(retired), false, "Remove the alternate issuer before exercising its old path");
  const result = spawnSync(process.execPath, [fileURLToPath(retired)], {
    cwd: fileURLToPath(root), env: {}, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
});

test("FA23 retirement: supported issuance remains the real coordinated CLI", () => {
  const { scripts } = JSON.parse(read("package.json"));
  assert.equal(scripts["issue:account"], "node scripts/issue-account.mjs");
  const cli = read("scripts/issue-account.mjs");
  assert.match(cli, /issueOperatorAccount/);
  assert.match(cli, /reconcileOperatorAccount/);
  assert.match(cli, /getOperatorAccountIssuance/);
  assert.match(cli, /FIREAFTER_OPERATOR_ATTEMPT_ID/);
  assert.match(cli, /FIREAFTER_OPERATOR_AUTH_EMAIL/);
  assert.match(cli, /FIREAFTER_OPERATOR_AUTH_PASSWORD/);
  assert.doesNotMatch(cli, /FIREAFTER_OPERATOR_IDENTITY/);
  const workflow = read("scripts/operator-account.mjs");
  assert.match(workflow, /fireafter_begin_account_issuance_as_operator/);
  assert.doesNotMatch(cli, /auth\.admin\.(?:createUser|updateUserById)/);
});

test("FA23 retirement: onboarding and rotation use the recoverable issuance contract", () => {
  const readme = read("README.md");
  const runbook = read("docs/OPERATIONS_AND_COST_PLAN.md");
  assert.match(runbook, /FIREAFTER_OPERATOR_ATTEMPT_ID = \[guid\]::NewGuid\(\)\.ToString\(\)/);
  assert.match(readme, /docs\/OPERATIONS_AND_COST_PLAN\.md/);
  assert.doesNotMatch(readme, /^npm\.cmd run seed:demo\s*$/m);
  assert.doesNotMatch(runbook, /Run `npm\.cmd run seed:demo`/);
  assert.match(runbook, /FIREAFTER_OPERATOR_ACCOUNT_PASSWORD/);
  assert.match(runbook, /original attempt UUID/);
  assert.match(runbook, /Target-safe bootstrap/);
  assert.match(runbook, /operator_account_issuance_operators/);
  assert.match(runbook, /do not grant table writes to `service_role`/);
});
