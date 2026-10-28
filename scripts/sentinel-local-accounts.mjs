import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_ORGANIZATION_ID, issueOperatorAccount } from './operator-account.mjs';
import { localEnvironment } from './sentinel-local-app.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function validateAccountTarget(status, manifest, workspace, home) {
  const name = manifest?.stack;
  if (!/^sentinel-judge-[a-z0-9][a-z0-9-]{0,40}$/.test(name ?? '') || status?.identity?.name !== name || path.basename(workspace) !== name) throw Error('Workspace identity mismatch.');
  if (!home.startsWith('/') || home.startsWith('/mnt/') || path.posix.basename(home) !== name || home.includes('/../')) throw Error('Expected isolated Linux native home.');
  localEnvironment(status, 'http://127.0.0.1:55461', 3043, {});
  if (manifest.ports?.api !== 55461 || manifest.ports?.database !== 55462) throw Error('Wrong prepared target.');
}

export function parseAccountOptions(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--workspace', '--home', '--wsl'].includes(key) || result[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Explicit workspace and native home required; optional --wsl DISTRO.');
    result[key] = args[i + 1];
  }
  if (!result['--workspace'] || !result['--home']) throw Error('Missing workspace or home.');
  return result;
}

export async function openLocalWorkspace(options) {
  const workspace = await realpath(path.resolve(options['--workspace']));
  const output = await realpath(path.join(root, 'output'));
  if (path.dirname(workspace) !== output) throw Error('Workspace must be a direct child of this checkout output directory.');
  const statusPath = path.join(workspace, 'status.private.json');
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(workspace, 'workspace.json'), 'utf8'));
  const home = options['--home'];
  validateAccountTarget(status, manifest, workspace, home);
  const linuxPath = file => process.platform === 'win32' ? execFileSync('wsl.exe', ['-d', options['--wsl'], '--exec', 'wslpath', '-a', file], { encoding: 'utf8', windowsHide: true }).trim() : file;
  if (process.platform === 'win32' && !options['--wsl']) throw Error('Explicit WSL distribution required on Windows.');
  const sqlArgs = [linuxPath(path.join(root, 'scripts/sentinel-local-sql.py')), '--status', linuxPath(statusPath), '--home', home];
  const sql = input => execFileSync(process.platform === 'win32' ? 'wsl.exe' : 'python3', process.platform === 'win32' ? ['-d', options['--wsl'], '--exec', 'python3', ...sqlArgs] : sqlArgs, { input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(manifest.migrations.length));
  assert.equal(sql("select to_regprocedure('sentinel_local_runtime.bridge_verified_claim_role()') is not null;"), 't');
  return { workspace, status, manifest, sql };
}

async function main() {
  const { workspace, status, manifest, sql } = await openLocalWorkspace(parseAccountOptions(process.argv.slice(2)));
  const env = status.env;
  const client = key => createClient(env.API_URL, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30000) }) } });
  const admin = client(env.SERVICE_ROLE_KEY), operator = client(env.ANON_KEY);
  const settings = await fetch(env.API_URL + '/auth/v1/settings', { headers: { apikey: env.ANON_KEY }, signal: AbortSignal.timeout(10000) });
  assert.equal(settings.status, 200); assert.equal((await settings.json()).disable_signup, true);
  const privateFile = path.join(workspace, 'portable-accounts.private.json');
  let accounts;
  try { accounts = JSON.parse(await readFile(privateFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const prefix = 'sentinel-' + randomUUID();
    const password = () => randomBytes(30).toString('base64url') + '!Aa7';
    accounts = { stack: manifest.stack, org: DEFAULT_ORGANIZATION_ID, operator: { email: prefix + '-operator@example.com', password: password() }, users: ['incident_commander', 'analyst', 'viewer'].map(role => ({ role, email: prefix + '-' + role + '@example.com', password: password(), attemptId: randomUUID() })) };
    await writeFile(privateFile, JSON.stringify(accounts, null, 2), { flag: 'wx', mode: 0o600 });
  }
  if (accounts.stack !== manifest.stack || accounts.org !== DEFAULT_ORGANIZATION_ID || accounts.users.map(u => u.role).join(',') !== 'incident_commander,analyst,viewer') throw Error('Existing account file does not match this workspace.');
  const save = () => writeFile(privateFile, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  const lit = value => "'" + String(value).replaceAll("'", "''") + "'";
  if (!accounts.operator.userId) {
    const created = await admin.auth.admin.createUser({ ...accounts.operator, email_confirm: true });
    if (created.error) throw created.error;
    accounts.operator.userId = created.data.user.id; await save();
  }
  const hash = createHash('sha256').update(accounts.operator.email.toLowerCase()).digest('hex');
  sql(`insert into public.operator_account_issuance_operators(user_id,email_hash,label) values(${lit(accounts.operator.userId)},${lit(hash)},'Sentinel isolated judge bootstrap') on conflict(user_id) do nothing;`);
  const signed = await operator.auth.signInWithPassword(accounts.operator); if (signed.error) throw signed.error;
  const receipts = [];
  try {
    for (const user of accounts.users) {
      if (!user.userId) {
        const issued = await issueOperatorAccount({ supabase: admin, operatorClient: operator, verificationClient: client(env.ANON_KEY), attemptId: user.attemptId, email: user.email, password: user.password, role: { incident_commander: 'responder', analyst: 'reviewer', viewer: 'viewer' }[user.role], operatorUserId: accounts.operator.userId, confirmation: 'ISSUE', organizationId: accounts.org, organizationName: 'Sentinel isolated synthetic operations' });
        user.userId = issued.userId ?? issued.account?.id ?? issued.user?.id; await save();
      }
      const session = client(env.ANON_KEY);
      try {
        const signed = await session.auth.signInWithPassword(user); if (signed.error) throw signed.error;
        const membership = await session.from('organization_members').select('role').eq('organization_id', accounts.org).eq('user_id', signed.data.user.id).single();
        if (membership.error) throw membership.error;
        assert.equal(membership.data.role, user.role);
        receipts.push({ role: user.role, signIn: 'PASS', membership: 'PASS' });
      } finally { await session.auth.signOut({ scope: 'local' }); }
    }
  } finally { await operator.auth.signOut({ scope: 'local' }); }
  await writeFile(path.join(workspace, 'portable-account-results.json'), JSON.stringify({ stack: manifest.stack, receipts, providerCalls: 0 }, null, 2));
  console.log(JSON.stringify({ status: 'LOCAL_ACCOUNTS_VERIFIED', roles: receipts.length, providerCalls: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Account setup stopped. Private checkpoints preserved; inspect the explicit local target before retrying.'); process.exitCode = 1; });
