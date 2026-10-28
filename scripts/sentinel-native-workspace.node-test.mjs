import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareWorkspace } from './sentinel-native-workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'supabase', 'migrations'), { recursive: true });
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fireafter-sentinel' }));
  await writeFile(path.join(root, '.env'), 'PRIVATE_VALUE=must-not-copy');
  await writeFile(path.join(root, 'scripts', 'sentinel-native-claims.sql'), '-- compatibility fixture');
  await writeFile(path.join(root, 'supabase', 'migrations', '20261019000000_initial.sql'), 'select 1;\r\n');
  await writeFile(path.join(root, 'supabase', 'migrations', '0001_fireafter_schema.sql'), '-- inherited baseline\n');
  return root;
}
test('copies exact migration bytes and no credentials into a separately named workspace', async t => {
  const repo = await fixture(t);
  const result = await prepareWorkspace(repo, 'sentinel-judge-test');
  assert.equal(result.migrations.length, 2);
  const bytes = await readFile(path.join(result.target, 'supabase', 'migrations', result.migrations[1].file));
  assert.equal(bytes.toString(), 'select 1;\r\n');
  assert.equal(result.migrations[1].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual((await readdir(result.target)).sort(), ['local-legacy-claims.sql', 'supabase', 'workspace.json']);
  const config = await readFile(path.join(result.target, 'supabase', 'config.toml'), 'utf8');
  assert.match(config, /port = 55461/); assert.match(config, /enable_signup = false/);
  assert.doesNotMatch(config, /55341|3023|must-not-copy/);
  assert.equal(result.status, 'FILES_PREPARED_NOT_STARTED');
});
test('refuses existing workspace without modifying its contents', async t => {
  const repo = await fixture(t);
  const result = await prepareWorkspace(repo, 'sentinel-judge-test');
  const before = await readFile(path.join(result.target, 'workspace.json'));
  await assert.rejects(prepareWorkspace(repo, 'sentinel-judge-test'), { code: 'EEXIST' });
  assert.deepEqual(await readFile(path.join(result.target, 'workspace.json')), before);
});
test('rejects traversal, legacy identities, unexpected source and wrong repository', async t => {
  const repo = await fixture(t);
  for (const name of ['../FireAfter', 'sentinel-personas', 'sentinel-judge-../x', 'sentinel-judge-x/child']) await assert.rejects(prepareWorkspace(repo, name));
  await writeFile(path.join(repo, 'supabase', 'migrations', '.env'), 'never-copy');
  await assert.rejects(prepareWorkspace(repo, 'sentinel-judge-test'), /inventory/);
  await writeFile(path.join(repo, 'package.json'), '{"name":"fireafter"}');
  await assert.rejects(prepareWorkspace(repo, 'sentinel-judge-test'), /Wrong repository/);
});
