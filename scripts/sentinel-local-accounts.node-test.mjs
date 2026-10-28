import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAccountTarget, parseAccountOptions } from './sentinel-local-accounts.mjs';
const name = 'sentinel-judge-test';
const status = () => ({ runtime: 'native', identity: { name }, env: { API_URL: 'http://127.0.0.1:55461', ANON_KEY: 'synthetic', SERVICE_ROLE_KEY: 'synthetic' } });
const manifest = () => ({ stack: name, ports: { api: 55461, database: 55462 } });
test('accepts explicit matching judge target only', () => {
  assert.doesNotThrow(() => validateAccountTarget(status(), manifest(), '/checkout/output/' + name, '/home/local/' + name));
  for (const api of ['http://127.0.0.1:55341', 'https://jrddupkptuybyylgilmw.supabase.co', 'http://localhost:55461']) {
    const s = status(); s.env.API_URL = api;
    assert.throws(() => validateAccountTarget(s, manifest(), name, '/home/local/' + name));
  }
});
test('rejects wrong workspace, data home and manifest identity', () => {
  for (const home of ['/mnt/c/' + name, '/home/local/sentinel-personas', '/home/../' + name, name]) assert.throws(() => validateAccountTarget(status(), manifest(), name, home));
  const m = manifest(); m.stack = 'sentinel-personas';
  assert.throws(() => validateAccountTarget(status(), m, name, '/home/local/' + name));
  assert.throws(() => validateAccountTarget(status(), manifest(), 'another-workspace', '/home/local/' + name));
});
test('rejects ambiguous and incomplete command arguments', () => {
  const args = ['--workspace', 'output/' + name, '--home', '/home/local/' + name, '--wsl', 'Ubuntu-24.04'];
  assert.equal(parseAccountOptions(args)['--wsl'], 'Ubuntu-24.04');
  for (const bad of [[], ['--workspace', 'x'], [...args, '--home', 'other'], [...args, '--unknown', 'x']]) assert.throws(() => parseAccountOptions(bad));
});
