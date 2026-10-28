import { readFile, writeFile, mkdir, readdir, lstat, realpath, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Prepare files only: never start, connect to, reset or alter a database. */
export async function prepareWorkspace(repo, name) {
  if (!/^sentinel-judge-[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw Error('Use a new sentinel-judge-NAME identity.');
  const base = await realpath(repo);
  if (JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8')).name !== 'fireafter-sentinel') throw Error('Wrong repository.');
  const source = path.join(base, 'supabase', 'migrations');
  if (await realpath(source) !== source) throw Error('Migration directory must not be redirected.');
  const files = (await readdir(source)).sort();
  if (!files.length || files.some(file => !/^(?:\d{14}|0001)_[a-z0-9_]+\.sql$/.test(file))) throw Error('Unexpected migration inventory.');
  const inputs = [];
  for (const file of files) {
    const filename = path.join(source, file);
    if (!(await lstat(filename)).isFile()) throw Error('Migrations must be regular files.');
    inputs.push({ file, bytes: await readFile(filename) });
  }
  const output = path.join(base, 'output');
  await mkdir(output, { recursive: true });
  if (await realpath(output) !== output) throw Error('Output directory must not be redirected.');
  const target = path.join(output, name);
  await mkdir(target); // Exclusive: an existing workspace is never reused or overwritten.
  await mkdir(path.join(target, 'supabase', 'migrations'), { recursive: true });
  const config = `project_id = "${name}"
[experimental]
stack = true
[api]
enabled = true
port = 55461
schemas = ["public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000
[db]
port = 55462
shadow_port = 55460
major_version = 17
health_timeout = "4m"
[db.seed]
enabled = false
[auth]
enabled = true
site_url = "http://127.0.0.1:3043"
additional_redirect_urls = ["http://127.0.0.1:3043/auth/callback"]
enable_signup = false
[auth.email]
enable_signup = true
enable_confirmations = false
[realtime]
enabled = false
[storage]
enabled = false
[studio]
enabled = false
[analytics]
enabled = false
[edge_runtime]
enabled = false
`;
  await writeFile(path.join(target, 'supabase', 'config.toml'), config, { flag: 'wx' });
  for (const { file, bytes } of inputs) await writeFile(path.join(target, 'supabase', 'migrations', file), bytes, { flag: 'wx' });
  await copyFile(path.join(base, 'scripts', 'sentinel-native-claims.sql'), path.join(target, 'local-legacy-claims.sql'));
  const manifest = { status: 'FILES_PREPARED_NOT_STARTED', stack: name, ports: { api: 55461, database: 55462, shadow: 55460, app: 3043 }, migrations: inputs.map(({ file, bytes }) => ({ file, sha256: digest(bytes) })), providerCalls: 0, databaseChanges: 0, credentialsCopied: false };
  await writeFile(path.join(target, 'workspace.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { target, ...manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--name') throw Error('Usage: --name sentinel-judge-NAME');
    const result = await prepareWorkspace(root, process.argv[3]);
    console.log(JSON.stringify({ status: result.status, target: result.target, migrations: result.migrations.length, ports: result.ports, databaseChanges: 0, credentialsCopied: false }));
  } catch { console.error('Workspace preparation failed; use a new identity in the Sentinel checkout. Existing files are preserved.'); process.exitCode = 1; }
}
