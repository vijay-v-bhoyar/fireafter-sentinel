import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRelease } from "./build-release.mjs";
import { captureInputs, createRelease, sealRelease, verifyRelease, withReleasePublisher } from "./release-artifact.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "fireafter-lifecycle-test-"));
  for (const dir of ["src", ".next/server", ".next/static"]) await mkdir(path.join(root, dir), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "src/app.ts",
    ".next/BUILD_ID", ".next/server/route.js", ".next/static/client.js"]) await writeFile(path.join(root, name), "fixture-content");
  return root;
}

for (const scenario of ["source-drift", "cancel-after-temporary-write", "cancel-after-rename",
  "source-drift-after-write", "output-drift-after-rename", "partial-write-error", "rename-error"]) {
  test(`receipt publication fails closed at ${scenario}`, async () => {
    const root = await fixture();
    // Instrument actual filesystem operations in a separate process, not production handlers.
    const code = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const root = ${JSON.stringify(root)};
      const scenario = ${JSON.stringify(scenario)};
      const controller = new AbortController();
      let injected = false;
      const originalRead = fs.readFile, originalWrite = fs.writeFile, originalRename = fs.rename;
      fs.readFile = async (...args) => {
        const value = await originalRead(...args);
        if (!injected && scenario === 'source-drift' && String(args[0]).endsWith('client.js')) {
          injected = true; await originalWrite(path.join(root,'src/app.ts'),'concurrent source change');
        }
        return value;
      };
      fs.writeFile = async (...args) => {
        if (String(args[0]).endsWith('.tmp') && scenario === 'partial-write-error') {
          await originalWrite(args[0], String(args[1]).slice(0, 8), args[2]);
          injected = true; throw new Error('Injected failure after eight actual bytes');
        }
        const value = await originalWrite(...args);
        if (scenario === 'cancel-after-temporary-write' && String(args[0]).endsWith('.tmp')) {
          injected = true; controller.abort();
        }
        if (String(args[0]).endsWith('.tmp') && scenario === 'source-drift-after-write') {
          injected = true; await originalWrite(path.join(root,'src/app.ts'),'changed during write');
        }
        return value;
      };
      fs.rename = async (...args) => {
        if (scenario === 'rename-error') { injected = true; throw new Error('Injected rename failure'); }
        const value = await originalRename(...args);
        if (scenario === 'cancel-after-rename') { injected = true; controller.abort(); }
        if (scenario === 'output-drift-after-rename') {
          injected = true; await originalWrite(path.join(root,'.next/static/client.js'),'changed after rename');
        }
        return value;
      };
      syncBuiltinESMExports();
      const { captureInputs, createRelease, sealRelease } = await import(${JSON.stringify(new URL("./release-artifact.mjs", import.meta.url).href)});
      const release = createRelease(await captureInputs(root));
      let failed = false;
      try { await sealRelease(root, release, controller.signal); } catch { failed = true; }
      assert.equal(injected,true,'Fault must occur at the actual seal boundary');
      assert.equal(failed,true,'Changed/canceled seal must not return success');
      await assert.rejects(fs.access(path.join(root,'.next/fireafter-release.json')), error => error.code === 'ENOENT');
      assert.equal((await fs.readdir(path.join(root,'.next'))).some(name => name.endsWith('.tmp')),false);
      await assert.rejects(fs.access(path.join(root,'.fireafter-release.lock')), error => error.code === 'ENOENT');
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test("a nonzero compiler process removes the prior receipt and issues no replacement", async () => {
  const root = await fixture();
  const compiler = path.join(root, "node_modules/next/dist/bin");
  await mkdir(compiler, { recursive: true });
  // Explicit process fixture; real Next compilation is checked by the separate probe.
  await writeFile(path.join(compiler, "next"), "require('fs').writeFileSync('.next/fixture-compiler-started','yes');process.exit(17);");
  await writeFile(path.join(root, ".next/fireafter-release.json"), "prior fixture receipt");
  await assert.rejects(buildRelease(root, {}, ["--webpack"]), /17/);
  assert.equal(await readFile(path.join(root, ".next/fixture-compiler-started"), "utf8"), "yes");
  await assert.rejects(access(path.join(root, ".next/fireafter-release.json")), error => error.code === "ENOENT");
  assert.equal((await readdir(path.join(root, ".next"))).some(name => name.endsWith(".tmp")), false);
  await assert.rejects(access(path.join(root, ".fireafter-release.lock")), error => error.code === "ENOENT");
});

test("builds and seals exclude another process without deleting its receipt or lock", async () => {
  const root = await fixture();
  const target = path.join(root, ".next/fireafter-release.json");
  await writeFile(target, "existing receipt");
  await withReleasePublisher(root, async () => {
    const lock = await readFile(path.join(root, ".fireafter-release.lock"), "utf8");
    await assert.rejects(buildRelease(root, {}, ["--webpack"]), /workspace is locked/);
    const code = `import assert from 'node:assert/strict';
      import { captureInputs, createRelease, sealRelease } from ${JSON.stringify(new URL("./release-artifact.mjs", import.meta.url).href)};
      const root=${JSON.stringify(root)};
      await assert.rejects(sealRelease(root,createRelease(await captureInputs(root))),/workspace is locked/);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(await readFile(target, "utf8"), "existing receipt");
    assert.equal(await readFile(path.join(root, ".fireafter-release.lock"), "utf8"), lock);
  });
  await assert.rejects(access(path.join(root, ".fireafter-release.lock")), error => error.code === "ENOENT");
  const receipt = await sealRelease(root, createRelease(await captureInputs(root)));
  await verifyRelease(root, receipt);
  assert.equal(JSON.parse(await readFile(target, "utf8")).releaseId, receipt.releaseId);
});

test("an existing nonce temporary file is not owned or removed by a rejected seal", async () => {
  const root = await fixture();
  const release = createRelease(await captureInputs(root));
  const temporary = path.join(root, `.next/fireafter-release.json.${release.nonce}.tmp`);
  await writeFile(temporary, "unowned temporary file");
  await assert.rejects(sealRelease(root, release), error => error.code === "EEXIST");
  assert.equal(await readFile(temporary, "utf8"), "unowned temporary file");
  await assert.rejects(access(path.join(root, ".fireafter-release.lock")), error => error.code === "ENOENT");
});

test("a pre-canceled seal does not replace existing evidence or acquire a workspace lock", async () => {
  const root = await fixture();
  const target = path.join(root, ".next/fireafter-release.json");
  await writeFile(target, "existing evidence");
  await assert.rejects(sealRelease(root, createRelease(await captureInputs(root)), AbortSignal.abort()));
  assert.equal(await readFile(target, "utf8"), "existing evidence");
  await assert.rejects(access(path.join(root, ".fireafter-release.lock")), error => error.code === "ENOENT");
});
