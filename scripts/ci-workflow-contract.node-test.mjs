import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const workflowPath = new URL("../.github/workflows/quality.yml", import.meta.url);

test("GitHub quality workflow runs deterministic gates without production authority", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  for (const command of [
    "npm ci",
    "npm test",
    "npm run lint",
    "npm run build",
    "npm run verify:graph",
    "npm run verify:migration-contract",
  ]) {
    assert.ok(workflow.includes(`- run: ${command}`), `missing CI command: ${command}`);
  }

  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /actions\/checkout@v5/);
  assert.match(workflow, /actions\/setup-node@v5/);
  assert.match(workflow, /node-version: 22/);
  assert.doesNotMatch(workflow, /secrets\.|verify:(?:local|production|authenticated|write-boundary)|issue:account/);
});
