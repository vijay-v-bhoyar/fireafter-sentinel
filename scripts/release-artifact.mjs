import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, readFile, writeFile, rename, open, rm } from "node:fs/promises";
import path from "node:path";

export const RELEASE_SCHEMA = "fireafter-release-v1";
export const INPUT_ROOTS = ["src", "public", "scripts", "package.json", "package-lock.json",
  "next.config.ts", "tsconfig.json", "postcss.config.mjs", "eslint.config.mjs", "vitest.config.ts", "vercel.json"];
export const digest = value => createHash("sha256").update(value).digest("hex");
const validId = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export async function fileManifest(root, roots) {
  const entries = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    let stat;
    try { stat = await lstat(absolute); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Release inputs/outputs must not contain symbolic links.");
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      entries.push({ path: relative, sha256: digest(await readFile(absolute)) });
    } else throw new Error("Release inputs/outputs must be regular files.");
  }
  for (const relative of roots) await visit(relative);
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function captureInputs(root) {
  // Workflow generates these handlers from hashed workflow sources and the pinned
  // SDK during compilation. Their compiled form is included in captureOutputs.
  const files = (await fileManifest(root, INPUT_ROOTS))
    .filter(file => !file.path.startsWith("src/app/.well-known/workflow/"));
  for (const required of ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json"]) {
    if (!files.some(file => file.path === required)) throw new Error(`Missing release input: ${required}`);
  }
  return files;
}

export function createRelease(inputs) {
  const nonce = randomBytes(32).toString("hex");
  return { schema: RELEASE_SCHEMA, nonce, inputs, releaseId: digest(nonce + JSON.stringify(inputs)) };
}

export async function assertInputs(root, inputs) {
  if (JSON.stringify(await captureInputs(root)) !== JSON.stringify(inputs)) {
    throw new Error("Release inputs changed; rebuild and rerun verification.");
  }
}

export async function captureOutputs(root) {
  const names = await readdir(path.join(root, ".next"));
  const roots = [".next/server", ".next/static", ".next/BUILD_ID",
    ...names.filter(name => name.endsWith(".json") && name !== "fireafter-release.json").map(name => `.next/${name}`)];
  const files = await fileManifest(root, roots);
  if (!files.some(file => file.path === ".next/BUILD_ID") ||
      !files.some(file => file.path.startsWith(".next/server/")) ||
      !files.some(file => file.path.startsWith(".next/static/"))) throw new Error("Incomplete production build output.");
  return files;
}

export async function withReleasePublisher(root, operation, signal) {
  signal?.throwIfAborted();
  const lockPath = path.join(root, ".fireafter-release.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); } catch (error) {
    if (error.code === "EEXIST") throw new Error("Release workspace is locked. Wait for its build to finish; after a crash, confirm the owning process has stopped before operator removal of .fireafter-release.lock and a fresh build.");
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    signal?.throwIfAborted();
    return await operation((release) => publishRelease(root, release, signal));
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

export async function sealRelease(root, release, signal) {
  return withReleasePublisher(root, publish => publish(release), signal);
}

async function publishRelease(root, release, signal) {
  signal?.throwIfAborted();
  await assertInputs(root, release.inputs);
  if (release.schema !== RELEASE_SCHEMA || !validId(release.nonce) || !validId(release.releaseId) ||
      digest(release.nonce + JSON.stringify(release.inputs)) !== release.releaseId) throw new Error("Invalid release receipt.");
  const receipt = { ...release, outputs: await captureOutputs(root), node: process.version,
    builtAt: new Date().toISOString(), scope: "Source/config files and emitted server/static/manifests; not secrets, runtime configuration, SQL or operator approval." };
  const target = path.join(root, ".next/fireafter-release.json");
  const temporary = `${target}.${release.nonce}.tmp`;
  let temporaryOwned = false;
  let published = false;
  try {
    signal?.throwIfAborted();
    const file = await open(temporary, "wx");
    temporaryOwned = true;
    await file.close();
    await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", { flag: "r+", signal });
    signal?.throwIfAborted();
    await verifyRelease(root, receipt);
    signal?.throwIfAborted();
    await rename(temporary, target);
    published = true;
    signal?.throwIfAborted();
    // Hashing is not a filesystem freeze; check again across the publication boundary.
    await verifyRelease(root, receipt);
    signal?.throwIfAborted();
    return receipt;
  } catch (error) {
    if (published) await rm(target, { force: true });
    throw error;
  } finally {
    if (temporaryOwned) await rm(temporary, { force: true });
  }
}

export async function verifyRelease(root, receipt) {
  if (receipt?.schema !== RELEASE_SCHEMA || !validId(receipt.releaseId) || !validId(receipt.nonce) ||
      digest(receipt.nonce + JSON.stringify(receipt.inputs)) !== receipt.releaseId) throw new Error("Invalid release receipt.");
  await assertInputs(root, receipt.inputs);
  if (JSON.stringify(await captureOutputs(root)) !== JSON.stringify(receipt.outputs)) {
    throw new Error("Production output changed; rebuild and rerun verification.");
  }
}

export function releaseTarget(baseUrl, expected = process.env.FIREAFTER_EXPECTED_RELEASE_ID) {
  if (!validId(expected)) throw new Error("Set FIREAFTER_EXPECTED_RELEASE_ID from the reviewed build receipt; never obtain it from the target.");
  const url = new URL(baseUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Release verification requires an HTTPS origin or an owned loopback origin.");
  }
  return { baseUrl: url.origin, releaseId: expected };
}

export async function fetchReleaseText(url, fetchImpl = fetch, expected = process.env.FIREAFTER_EXPECTED_RELEASE_ID) {
  releaseTarget(new URL(url).origin, expected);
  const controller = new AbortController();
  let reader;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Release content deadline exceeded.")); }, 15_000);
  });
  try {
    return await Promise.race([expired, (async () => {
      const response = await fetchImpl(url, { redirect: "error", cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error("Expired."); }
      if (!response.ok || response.redirected || (response.url && response.url !== String(url)) || !response.body ||
          response.headers.get("x-fireafter-release-id") !== expected) {
        throw new Error("Unexpected response.");
      }
      reader = response.body.getReader();
      const bytes = new Uint8Array(16 * 1024 * 1024);
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > bytes.length) throw new Error("Content budget exceeded.");
        bytes.set(chunk.value, size); size += chunk.value.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    })()]);
  } catch { throw new Error("Release content unavailable, redirected, invalid or over budget; verification stopped."); }
  finally {
    clearTimeout(timer); controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

export async function bindReleasePage(page, baseUrl, issues, expected = process.env.FIREAFTER_EXPECTED_RELEASE_ID) {
  releaseTarget(baseUrl, expected);
  page.on("response", response => {
    const originIsTrusted = isTrustedReleaseOrigin(response.url(), baseUrl);
    let previous = response.request().redirectedFrom();
    let fromRelease = false;
    while (previous) {
      if (new URL(previous.url()).origin === baseUrl) fromRelease = true;
      previous = previous.redirectedFrom();
    }
    // Playwright routing is not called for every redirect hop. Observe final
    // responses too; this rejects evidence, it is not network isolation.
    if (!originIsTrusted && (response.request().isNavigationRequest() || fromRelease)) {
      issues.push("Release navigation/content left the verified origin; evidence rejected.");
    }
    if (originIsTrusted && response.headers()["x-fireafter-release-id"] !== expected) {
      issues.push("A release response had a missing or mismatched compiled identity.");
    }
  });
  await page.route("**/*", async route => {
    const request = route.request();
    const originIsTrusted = isTrustedReleaseOrigin(request.url(), baseUrl);
    let previous = request.redirectedFrom();
    let fromRelease = false;
    while (previous) {
      if (new URL(previous.url()).origin === baseUrl) fromRelease = true;
      previous = previous.redirectedFrom();
    }
    if (!originIsTrusted && (request.isNavigationRequest() || fromRelease)) {
      issues.push("Release navigation/content attempted to leave the verified origin.");
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
}

export function isTrustedReleaseOrigin(actualUrl, expectedUrl) {
  const actual = new URL(actualUrl);
  const expected = new URL(expectedUrl);
  if (actual.origin === expected.origin) return true;
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  return actual.protocol === "http:" && expected.protocol === "http:"
    && actual.port === expected.port
    && loopbackHosts.has(actual.hostname) && loopbackHosts.has(expected.hostname);
}

export async function verifyReleaseIdentity(baseUrl, expected = process.env.FIREAFTER_EXPECTED_RELEASE_ID, fetchImpl = fetch) {
  const target = releaseTarget(baseUrl, expected);
  const controller = new AbortController();
  let reader;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Release identity timed out.")); }, 5000);
  });
  try {
    const work = (async () => {
      const response = await fetchImpl(`${target.baseUrl}/api/build`, { redirect: "error", cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "application/json" }, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error("Release identity timed out."); }
      if (!response.ok || response.redirected || !response.body) throw new Error("Release identity unavailable; rebuild with npm run build.");
      reader = response.body.getReader();
      const bytes = new Uint8Array(4096);
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > bytes.length) throw new Error("Release identity exceeds its response budget.");
        bytes.set(chunk.value, size); size += chunk.value.byteLength;
      }
      const identity = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
      if (identity.application !== "fireafter-sentinel" || identity.mode !== "production" || identity.releaseId !== target.releaseId) {
        throw new Error("Wrong or unbound build: expected production release identity did not match.");
      }
      return target;
    })();
    return await Promise.race([work, deadline]);
  } catch {
    throw new Error("Release identity verification failed. Check the reviewed receipt, target origin and production build; do not bypass this gate.");
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}
