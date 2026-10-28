import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBatch } from './sentinel-local-fixtures.mjs';

test('a fixture batch never overwrites earlier results', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sentinel-fixture-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const first = await createBatch(workspace, 'first');
  const receipt = path.join(first, 'attempt.json');
  await writeFile(receipt, 'retained partial or completed result');
  await assert.rejects(createBatch(workspace, 'first'), { code: 'EEXIST' });
  assert.equal(await readFile(receipt, 'utf8'), 'retained partial or completed result');
  const second = await createBatch(workspace, 'second');
  assert.notEqual(first, second);
  assert.equal(JSON.parse(await readFile(path.join(second, 'attempt.json'), 'utf8')).status, 'PREPARING');
});

test('unsafe batch paths are rejected before filesystem writes', async () => {
  for (const name of ['../owner', '/tmp/owner', 'a/b', 'a\\b', '', '..', 'A', 'x'.repeat(42)]) {
    await assert.rejects(createBatch('nonexistent-unused-workspace', name), /Invalid batch/);
  }
});
