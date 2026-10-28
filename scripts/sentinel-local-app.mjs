import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRelease } from './local-release.mjs';
import { requireSupabaseTarget, requireAppTarget } from '../src/lib/sentinel/target-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const protectedDatabase = 'https://jrddupkptuybyylgilmw.supabase.co';

/** This launcher accepts only an explicitly selected native loopback stack. */
export function localEnvironment(status, apiUrl, port, inherited = process.env) {
  if (status?.runtime !== 'native' || !/^sentinel-[a-z0-9-]+$/.test(status?.identity?.name ?? '')) throw Error('Expected a named Sentinel native stack.');
  const api = new URL(apiUrl);
  if (api.hostname !== '127.0.0.1' || api.protocol !== 'http:' || !api.port || api.username || api.password || api.search || api.hash || api.pathname !== '/') throw Error('Expected an explicit IPv4 loopback API origin.');
  if (status.env?.API_URL !== api.origin || !Number.isInteger(port) || port < 1024 || port > 65535 || port === Number(api.port)) throw Error('Local destination mismatch.');
  for (const key of ['ANON_KEY', 'SERVICE_ROLE_KEY']) {
    const value = status.env[key];
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\s\0]/.test(value)) throw Error('Missing or malformed local credentials.');
  }
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'COMSPEC']) if (inherited[key]) env[key] = inherited[key];
  Object.assign(env, {
    NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
    SENTINEL_ALLOW_LOCAL_DB: 'true', SENTINEL_TARGET_SUPABASE_URL: api.origin,
    SENTINEL_PROTECTED_SUPABASE_URLS: protectedDatabase,
    NEXT_PUBLIC_SUPABASE_URL: api.origin, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.env.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.env.SERVICE_ROLE_KEY,
    SENTINEL_TARGET_APP_URL: `http://127.0.0.1:${port}`,
    SENTINEL_PROTECTED_APP_URLS: 'https://fireafter-app.vercel.app',
    SENTINEL_MONITOR_ENABLED: 'false', SENTINEL_NEBIUS_API_KEY: '', SENTINEL_TAVILY_API_KEY: '',
    WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: 'true',
    WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: '30', WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`,
    WORKFLOW_LOCAL_DATA_DIR: path.join(root, 'output', status.identity.name, 'workflow-data'),
  });
  requireSupabaseTarget(api.origin, env);
  requireAppTarget(env.SENTINEL_TARGET_APP_URL, env);
  return env;
}

export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--check' && options.check === undefined) { options.check = true; continue; }
    if (!['--status', '--api-url', '--port'].includes(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Usage: --status FILE --api-url http://127.0.0.1:PORT --port PORT [--check]');
    options[key] = args[++i];
  }
  if (!options['--status'] || !options['--api-url'] || !/^\d+$/.test(options['--port'] ?? '')) throw Error('Explicit status, API origin and app port are required.');
  return { status: options['--status'], apiUrl: options['--api-url'], port: Number(options['--port']), check: options.check === true };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).name !== 'fireafter-sentinel') throw Error('Wrong repository.');
  const status = JSON.parse(await readFile(path.resolve(options.status), 'utf8'));
  const env = localEnvironment(status, options.apiUrl, options.port);
  if (options.check) { console.log(JSON.stringify({ status: 'CONFIG_VALID', networkCalls: 0, databaseChanges: 0, providersEnabled: false })); return; }
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(options.port, '127.0.0.1', resolve); });
  await new Promise(resolve => reservation.close(resolve));
  const { workspace } = await snapshotRelease(root);
  const child = spawn(process.execPath, [path.join(workspace, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(options.port)], { cwd: workspace, env, windowsHide: true, stdio: 'inherit' });
  const stop = () => child.kill();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  child.once('error', () => { console.error('Local app failed to start.'); process.exitCode = 1; });
  child.once('exit', code => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.exitCode = code ?? 1; });
  console.log(JSON.stringify({ status: 'STARTING', url: env.SENTINEL_TARGET_APP_URL, pid: child.pid, providersEnabled: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Sentinel local launch failed. Check arguments, local stack identity, credentials and port availability. No configuration values were printed.'); process.exitCode = 1; });
}
