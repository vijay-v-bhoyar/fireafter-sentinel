import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseId = "a".repeat(64);

function runVerifier(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/verify-product-promise.mjs"], {
      cwd: root,
      env: { ...process.env, ...env, SENTINEL_TARGET_APP_URL: env.FIREAFTER_TEST_BASE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

test("reports a safe discoverability gap when the bound county search is unavailable", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("x-fireafter-release-id", releaseId);
    if (request.url === "/api/build") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ application: "fireafter-sentinel", mode: "production", releaseId }));
      return;
    }
    if (request.url?.startsWith("/api/search?")) {
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ code: "county_search_unavailable", retryable: true, results: [] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const result = await runVerifier({
      FIREAFTER_TEST_BASE: `http://127.0.0.1:${address.port}`,
      FIREAFTER_EXPECTED_RELEASE_ID: releaseId,
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /\[FAIL\] 1\) Incident discoverability/);
    assert.match(result.output, /County search could not be verified at the bound release origin\./);
    assert.match(result.output, /No county result is available, so persisted incident derivation cannot begin\./);
    assert.match(result.output, /\[FAIL\] 6\) Final demo-readiness blocker check/);
    assert.doesNotMatch(result.output, /Audit script crashed/);
    assert.doesNotMatch(result.output, /location "undefined"/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("requires a persisted incident for the discovered county rather than accepting an unrelated record", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("x-fireafter-release-id", releaseId);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/build") {
      response.end(JSON.stringify({ application: "fireafter-sentinel", mode: "production", releaseId }));
      return;
    }
    if (request.url?.startsWith("/api/search?")) {
      response.end(JSON.stringify({ results: [{ id: "utah-county-ut" }] }));
      return;
    }
    if (request.url === "/api/recommendations") {
      response.end(JSON.stringify({ recommendations: [{ incidentId: "incident-other-county" }] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const result = await runVerifier({
      FIREAFTER_TEST_BASE: `http://127.0.0.1:${address.port}`,
      FIREAFTER_EXPECTED_RELEASE_ID: releaseId,
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /\[PASS\] 1\) Incident discoverability/);
    assert.match(result.output, /No persisted incident is discoverable from recommendations for location "utah-county-ut"\./);
    assert.match(result.output, /Create and refresh that real incident as an authenticated responder, then rerun this check\./);
    assert.doesNotMatch(result.output, /derived persisted incident/);
  } finally {
    server.close();
    await once(server, "close");
  }
});
