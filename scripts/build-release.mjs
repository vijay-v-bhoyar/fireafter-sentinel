import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rm } from "node:fs/promises";
import { captureInputs, createRelease, withReleasePublisher } from "./release-artifact.mjs";

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { signal, ...spawnOptions } = options;
    if (signal?.aborted) { reject(new Error("Release interrupted before dispatch.")); return; }
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: "inherit", ...spawnOptions });
    let killTimer;
    const abort = () => {
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", error => { clearTimeout(killTimer); signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code, reason) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Release interrupted; owned child exited."));
      else if (code === 0) resolve();
      else reject(new Error(`Release step failed (${code ?? reason}).`));
    });
  });
}

export function createReleaseScope() {
  const controller = new AbortController();
  const interrupt = () => { process.exitCode = 1; controller.abort(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  return { signal: controller.signal, dispose: () => {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  } };
}

export async function buildRelease(root, env = process.env, args = [], signal) {
  signal?.throwIfAborted();
  if (args.some(arg => arg !== "--webpack")) throw new Error("Only the explicit --webpack compiler option is supported.");
  return withReleasePublisher(root, async publish => {
    const release = { ...createRelease(await captureInputs(root)), compilerArgs: args.length ? args : ["--turbopack"] };
    // Remove only the old receipt: failed builds must never retain a success claim.
    await rm(path.join(root, ".next/fireafter-release.json"), { force: true });
    await runProcess(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build", ...args], {
      cwd: root, env: { ...env, NODE_ENV: "production", FIREAFTER_BUILD_RELEASE_ID: release.releaseId }, signal,
    });
    signal?.throwIfAborted();
    const receipt = await publish(release);
    console.log(`[release] built ${receipt.releaseId}; receipt: .next/fireafter-release.json`);
    return receipt;
  }, signal);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scope = createReleaseScope();
  await buildRelease(process.cwd(), process.env, process.argv.slice(2), scope.signal).catch(() => {
    console.error("[release] Build failed or inputs changed; no new verified release receipt was issued. Inspect the build output.");
    process.exitCode = 1;
  }).finally(scope.dispose);
}
