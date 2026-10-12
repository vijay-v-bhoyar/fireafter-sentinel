import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildRelease, createReleaseScope, runProcess } from "./build-release.mjs";
import { captureInputs, assertInputs, verifyRelease, verifyReleaseIdentity } from "./release-artifact.mjs";
import { snapshotRelease, startReleaseServer } from "./local-release.mjs";

const steps = ["test", "lint", "verify:graph", "verify:migration-contract"];

async function main(signal) {
  if (process.env.FIREAFTER_TEST_BASE) throw new Error("verify:local owns its production server. Unset FIREAFTER_TEST_BASE; existing servers are never reused.");
  const root = process.cwd();
  const inputs = await captureInputs(root);
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
  for (const key of Object.keys(env)) {
    if (/^FIREAFTER_(AUTH_SMOKE|OPERATOR|ENABLE_FIXTURES)/.test(key)) delete env[key];
  }
  for (const step of steps) {
    console.log(`[verify:local] ${step}`);
    const args = step === "test" ? ["test"] : ["run", step];
    if (process.platform === "win32") {
      await runProcess(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`], { cwd: root, env, signal });
    } else await runProcess("npm", args, { cwd: root, env, signal });
    await assertInputs(root, inputs);
  }
  const { workspace } = await snapshotRelease(root);
  console.log(`[verify:local] artifacts retained at ${workspace}; .env files are not copied`);
  // Explicit compiler choice: dependencies are linked outside this isolated root.
  const receipt = await buildRelease(workspace, env, ["--webpack"], signal);
  await verifyRelease(workspace, receipt);
  await assertInputs(root, inputs);
  const server = await startReleaseServer(workspace, receipt, env, signal);
  try {
    for (const script of ["verify-product-promise.mjs", "verify-browser-smoke.mjs"]) {
      server.assertAlive();
      await verifyRelease(workspace, receipt);
      await verifyReleaseIdentity(server.baseUrl, receipt.releaseId);
      await runProcess(process.execPath, [path.join(workspace, "scripts", script)], { cwd: workspace, signal,
        env: { ...env, FIREAFTER_TEST_BASE: server.baseUrl, SENTINEL_TARGET_APP_URL: server.baseUrl, FIREAFTER_EXPECTED_RELEASE_ID: receipt.releaseId } });
      server.assertAlive();
      await verifyReleaseIdentity(server.baseUrl, receipt.releaseId);
      await verifyRelease(workspace, receipt);
      await assertInputs(root, inputs);
    }
    console.log(`[verify:local] all gates passed for production release ${receipt.releaseId}`);
  } finally { await server.stop(); }
}

if (!process.argv[1] || path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scope = createReleaseScope();
  await main(scope.signal).catch(error => { console.error(`[verify:local] ${error.message}`); process.exitCode = 1; }).finally(scope.dispose);
}
