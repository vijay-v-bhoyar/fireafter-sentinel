import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localEnvironment, parseOptions } from './sentinel-local-app.mjs';

const fixture = () => ({ runtime: 'native', identity: { name: 'sentinel-judge-test' }, env: { API_URL: 'http://127.0.0.1:55441', ANON_KEY: 'synthetic-public', SERVICE_ROLE_KEY: 'synthetic-private' } });
test('provider and process injection environment cannot cross into the child', () => {
  const env = localEnvironment(fixture(), 'http://127.0.0.1:55441', 3043, { PATH: 'safe-path', NODE_OPTIONS: '--require bad.js', SENTINEL_NEBIUS_API_KEY: 'never-copy', SENTINEL_TAVILY_API_KEY: 'never-copy', OTHER_SECRET: 'never-copy', SENTINEL_MONITOR_ENABLED: 'true' });
  assert.equal(env.PATH, 'safe-path'); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.OTHER_SECRET, undefined);
  assert.equal(env.SENTINEL_NEBIUS_API_KEY, ''); assert.equal(env.SENTINEL_TAVILY_API_KEY, ''); assert.equal(env.SENTINEL_MONITOR_ENABLED, 'false');
});
test('local recovery preserves one stack-specific world and a bounded lease without inheriting workflow overrides', () => {
  const env=localEnvironment(fixture(),fixture().env.API_URL,3043,{WORKFLOW_TARGET_WORLD:'vercel',WORKFLOW_LOCAL_DATA_DIR:'private-other-world',WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS:'900'});
  assert.equal(env.WORKFLOW_TARGET_WORLD,'local');assert.equal(env.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS,'true');
  assert.equal(env.WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS,'30');assert.equal(env.WORKFLOW_LOCAL_BASE_URL,'http://127.0.0.1:3043');
  assert.ok(env.WORKFLOW_LOCAL_DATA_DIR.endsWith('output'+(process.platform==='win32'?'\\':'/')+'sentinel-judge-test'+(process.platform==='win32'?'\\':'/')+'workflow-data'));
  assert.equal(env.SENTINEL_MONITOR_ENABLED,'false');assert.equal(env.SENTINEL_NEBIUS_API_KEY,'');assert.equal(env.SENTINEL_TAVILY_API_KEY,'');
});
test('remote, protected, deceptive and mismatched API targets fail closed', () => {
  for (const url of ['https://jrddupkptuybyylgilmw.supabase.co','http://localhost:55441','http://127.0.0.1.evil.test:55441','http://user@127.0.0.1:55441','http://127.0.0.1:55441/path','http://127.0.0.1:55442']) assert.throws(() => localEnvironment(fixture(), url, 3043));
  assert.throws(() => localEnvironment(fixture(), fixture().env.API_URL, 3010));
});
test('wrong stack identity and malformed credentials are rejected', () => {
  for (const patch of [{runtime:'docker'}, {identity:{name:'fireafter'}}, {env:{...fixture().env,SERVICE_ROLE_KEY:'secret\nvalue'}}]) assert.throws(() => localEnvironment({...fixture(),...patch}, fixture().env.API_URL, 3043));
  for (const port of [0, 80, 65536, 3023.5, 55441]) assert.throws(() => localEnvironment(fixture(), fixture().env.API_URL, port));
});
test('command requires explicit targets and rejects ambiguous arguments', () => {
  const valid=['--status','status.private.json','--api-url','http://127.0.0.1:55441','--port','3043'];
  assert.equal(parseOptions([...valid,'--check']).check,true);
  for(const args of [[], [...valid,'--unknown'], [...valid,'--port','3044'], [...valid,'--check','--check']]) assert.throws(()=>parseOptions(args));
});
