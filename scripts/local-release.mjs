import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, copyFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { captureInputs, assertInputs, verifyReleaseIdentity } from "./release-artifact.mjs";

export async function snapshotRelease(root) {
  const inputs = await captureInputs(root);
  const workspace = await mkdtemp(path.join(tmpdir(), "fireafter-release-"));
  for (const file of inputs) {
    const destination = path.join(workspace, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, file.path), destination);
  }
  await assertInputs(root, inputs);
  await assertInputs(workspace, inputs);
  // This controlled dependency link is the sole link allowed outside the snapshot.
  await symlink(await realpath(path.join(root, "node_modules")), path.join(workspace, "node_modules"),
    process.platform === "win32" ? "junction" : "dir");
  return { workspace, inputs };
}

export async function startReleaseServer(workspace, receipt, env, signal) {
  signal?.throwIfAborted();
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(workspace, "node_modules/next/dist/bin/next"),
    "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: workspace, env: { ...env, NODE_ENV: "production" }, shell: false, windowsHide: true, stdio: "inherit",
  });
  let ended = false;
  let spawnError;
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const closed = new Promise(resolve => {
    child.once("error", error => { spawnError = error; if (!child.pid) { ended = true; resolve(); } });
    child.once("close", () => { ended = true; resolve(); });
  });
  const assertAlive = () => {
    signal?.throwIfAborted();
    if (ended || spawnError) throw new Error("Owned release server stopped or failed to start; no existing server will be reused.");
  };
  const stop = async () => {
    if (!ended) child.kill();
    await Promise.race([closed, delay(5000, undefined, { ref: false })]);
    if (!ended) { child.kill("SIGKILL"); await Promise.race([closed, delay(5000, undefined, { ref: false })]); }
    if (!ended) throw new Error("Owned release server shutdown was not confirmed.");
    signal?.removeEventListener("abort", abort);
  };
  try {
    const until = Date.now() + 60_000;
    while (true) {
      assertAlive();
      try { await verifyReleaseIdentity(baseUrl, receipt.releaseId); break; } catch {
        assertAlive();
        if (Date.now() >= until) throw new Error("Owned production build did not become ready within 60 seconds.");
        await delay(250);
      }
    }
    assertAlive();
    return { baseUrl, assertAlive, stop };
  } catch (error) { await stop(); throw error; }
}
