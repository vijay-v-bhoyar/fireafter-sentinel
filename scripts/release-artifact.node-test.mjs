import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureInputs, createRelease, assertInputs, sealRelease, verifyRelease, releaseTarget, verifyReleaseIdentity, isTrustedReleaseOrigin } from "./release-artifact.mjs";
import * as releaseTools from "./release-artifact.mjs";
import { createReleaseScope, runProcess } from "./build-release.mjs";

// Execute the actual CLI with explicitly isolated transport/process doubles.
// No real provider, database, browser, build or external mutation is invoked.
function runFalseGreenVerifier(script, expected, actual, mode = "production") {
  const code = `
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ok:true,checks:16,issues:[]})); child.emit('close',0); });
      return child;
    };
    syncBuiltinESMExports();
    globalThis.fetch = async input => {
      const path = new URL(input).pathname;
      if (path === '/api/build') return Response.json({application:'fireafter-sentinel',mode:${JSON.stringify(mode)},releaseId:${JSON.stringify(actual)}});
      if (path === '/settings') return new Response('Recent fire perimeter fallback');
      return Response.json({overallStatus:'operational',overallScore:5,
        productPromise:[{status:'pass'}],coverageMatrix:Array(14).fill({})});
    };
    await import(${JSON.stringify(pathToFileURL(script).href)});
  `;
  const env = { ...process.env, FIREAFTER_TEST_BASE: "http://127.0.0.1:39999",
    FIREAFTER_PRODUCTION_BASE: "http://127.0.0.1:39999" };
  delete env.FIREAFTER_EXPECTED_RELEASE_ID;
  if (expected) env.FIREAFTER_EXPECTED_RELEASE_ID = expected;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 15000 });
}

for (const [name, expected, actual, mode] of [
  ["missing expected identity", undefined, "a".repeat(64), "production"],
  ["wrong build despite green readiness", "a".repeat(64), "b".repeat(64), "production"],
  ["development build despite matching identity", "a".repeat(64), "a".repeat(64), "development"],
]) test(`FA14 production rejects ${name}`, () => {
  const result = runFalseGreenVerifier("scripts/verify-production-smoke.mjs", expected, actual, mode);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, `False green: ${result.stdout}`);
});

test("FA14 local verification refuses a caller-selected existing server", () => {
  const result = runFalseGreenVerifier("scripts/verify-local-readiness.mjs", undefined, "a".repeat(64), "development");
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, `False green: ${result.stdout}`);
});

test("release verifier accepts only the exact production identity", async () => {
  const id = "a".repeat(64);
  let request;
  const transport = async (url, init) => {
    request = { url, init };
    return Response.json({ application: "fireafter-sentinel", mode: "production", releaseId: id });
  };
  assert.deepEqual(await verifyReleaseIdentity("http://127.0.0.1:39999", id, transport), {
    baseUrl: "http://127.0.0.1:39999", releaseId: id,
  });
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.url, "http://127.0.0.1:39999/api/build");
});

test("release browser binding accepts only exact origins or equivalent same-port HTTP loopbacks", () => {
  expectTrustedOrigin("http://127.0.0.1:3010", "http://127.0.0.1:3010", true);
  expectTrustedOrigin("http://localhost:3010", "http://127.0.0.1:3010", true);
  expectTrustedOrigin("http://[::1]:3010", "http://localhost:3010", true);
  expectTrustedOrigin("http://localhost:3011", "http://127.0.0.1:3010", false);
  expectTrustedOrigin("https://localhost:3010", "http://127.0.0.1:3010", false);
  expectTrustedOrigin("https://attacker.invalid", "https://fireafter-sentinel.vercel.app", false);
});

function expectTrustedOrigin(actual, expected, trusted) {
  assert.equal(isTrustedReleaseOrigin(actual, expected), trusted, `${actual} against ${expected}`);
}

test("identity mismatch, malformed, redirected and oversized responses fail without provider detail", async () => {
  const id = "a".repeat(64);
  for (const response of [Response.json({ application: "other", mode: "production", releaseId: id }),
    Response.json({ application: "fireafter-app", mode: "production", releaseId: id }),
    Response.json({ application: "fireafter-sentinel", mode: "development", releaseId: id }),
    Response.json({ application: "fireafter-sentinel", mode: "production", releaseId: "b".repeat(64) }),
    new Response("private-provider-detail", { status: 503 }), new Response("{"), new Response("x".repeat(4097))]) {
    await assert.rejects(verifyReleaseIdentity("http://127.0.0.1:39999", id, async () => response), error =>
      error.message.includes("Release identity verification failed") && !error.message.includes("private-provider-detail"));
  }
  const redirected = Response.json({ application: "fireafter-sentinel", mode: "production", releaseId: id });
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(verifyReleaseIdentity("http://127.0.0.1:39999", id, async () => redirected));
});

test("target and expected identity are validated before network", async () => {
  for (const target of ["http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com/?token=x"]) {
    assert.throws(() => releaseTarget(target, "a".repeat(64)));
  }
  let called = false;
  await assert.rejects(verifyReleaseIdentity("https://example.com", "invalid", async () => { called = true; }));
  assert.equal(called, false);
});

test("receipt binds added/deleted/modified inputs and emitted output, not local env files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fireafter-receipt-test-"));
  for (const dir of ["src", ".next/server", ".next/static"]) await mkdir(path.join(root, dir), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "src/example.ts", ".next/BUILD_ID", ".next/server/route.js", ".next/static/client.js"]) {
    await writeFile(path.join(root, file), "fixture-input");
  }
  await writeFile(path.join(root, ".env.local"), "TEST_ONLY_SECRET=not-a-real-credential");
  const inputs = await captureInputs(root);
  assert.equal(inputs.some(file => file.path.includes(".env")), false);
  const release = createRelease(inputs);
  assert.notEqual(createRelease(inputs).releaseId, release.releaseId);
  const receipt = await sealRelease(root, release);
  await verifyRelease(root, receipt);
  await writeFile(path.join(root, "src/new.ts"), "added");
  await assert.rejects(assertInputs(root, inputs), /inputs changed/);
  await rm(path.join(root, "src/new.ts"));
  await writeFile(path.join(root, "src/example.ts"), "changed");
  await assert.rejects(verifyRelease(root, receipt), /inputs changed/);
  await rm(path.join(root, "src/example.ts"));
  await assert.rejects(verifyRelease(root, receipt), /inputs changed/);
  await writeFile(path.join(root, "src/example.ts"), "fixture-input");
  await writeFile(path.join(root, ".next/server/route.js"), "changed-output");
  await assert.rejects(verifyRelease(root, receipt), /output changed/);
});

test("input manifests reject symlinked source directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fireafter-link-test-"));
  const outside = await mkdtemp(path.join(tmpdir(), "fireafter-link-target-"));
  await symlink(outside, path.join(root, "src"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(captureInputs(root), /symbolic links/);
});

test("material content rejects redirected success rather than accepting another target", async () => {
  assert.equal(typeof releaseTools.fetchReleaseText, "function");
  const response = new Response("apparently healthy");
  Object.defineProperty(response, "redirected", { value: true });
  await assert.rejects(releaseTools.fetchReleaseText("https://example.com/api/readiness", async () => response, "a".repeat(64)));
});

test("pre-canceled release steps cannot run and claim success", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(0)"], { signal: AbortSignal.abort(), stdio: "ignore" }));
});

test("every material response must carry the compiled release identity", async () => {
  const id = "a".repeat(64);
  for (const header of [null, "b".repeat(64)]) {
    await assert.rejects(releaseTools.fetchReleaseText("https://example.com/api/readiness", async () =>
      new Response("healthy", { headers: header ? { "x-fireafter-release-id": header } : {} }), id));
  }
  assert.equal(await releaseTools.fetchReleaseText("https://example.com/api/readiness", async () =>
    new Response("healthy", { headers: { "x-fireafter-release-id": id } }), id), "healthy");
});

test("cancellation waits for the actual owned process to exit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fireafter-cancel-test-"));
  const pidFile = path.join(root, "owned-pid.txt");
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ["-e",
    `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`],
  { signal: controller.signal, stdio: "ignore" });
  const rejection = assert.rejects(pending, /interrupted/);
  let pid;
  try {
    const until = Date.now() + 5000;
    while (!pid && Date.now() < until) {
      try { pid = Number(await readFile(pidFile, "utf8")); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "Owned child must actually start before interruption");
  } finally { controller.abort(); }
  await rejection;
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
});

test("catchable interruption aborts its release scope and removes its handlers", () => {
  const before = process.listenerCount("SIGINT");
  const previousExit = process.exitCode;
  const scope = createReleaseScope();
  try {
    assert.equal(process.listenerCount("SIGINT"), before + 1);
    process.emit("SIGINT");
    assert.equal(scope.signal.aborted, true);
  } finally { scope.dispose(); process.exitCode = previousExit; }
  assert.equal(process.listenerCount("SIGINT"), before);
});
