"""Start a fresh, isolated Linux native stack from a prepared Sentinel workspace."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tomllib
from sentinel_native_artifacts import verify_archives, install_archives


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--cli', type=Path, required=True)
    parser.add_argument('--home', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path)
    args = parser.parse_args()
    workspace = args.workspace.resolve(strict=True)
    manifest = json.loads((workspace / 'workspace.json').read_text())
    name = manifest['stack']
    if not re.fullmatch(r'sentinel-judge-[a-z0-9][a-z0-9-]{0,40}', name):
        raise ValueError('Invalid stack identity')
    if workspace.name != name or manifest['status'] != 'FILES_PREPARED_NOT_STARTED':
        raise ValueError('Workspace identity mismatch')
    home = args.home.absolute()
    if home.name != name or home.exists() or home.is_symlink() or str(home).startswith('/mnt/'):
        raise ValueError('Select a new Linux-native data directory named after this stack')
    config = tomllib.loads((workspace / 'supabase/config.toml').read_text())
    expected = {'api': 55461, 'database': 55462, 'shadow': 55460, 'app': 3043}
    if manifest['ports'] != expected or config['project_id'] != name:
        raise ValueError('Unexpected ports or project')
    if (config['api']['port'], config['db']['port'], config['db']['shadow_port']) != (55461, 55462, 55460):
        raise ValueError('Unexpected database ports')
    if config['auth']['enable_signup'] or config['auth']['site_url'] != 'http://127.0.0.1:3043':
        raise ValueError('Unexpected Auth configuration')
    migrations = workspace / 'supabase/migrations'
    if sorted(p.name for p in migrations.iterdir()) != sorted(i['file'] for i in manifest['migrations']):
        raise ValueError('Migration inventory mismatch')
    for item in manifest['migrations']:
        if Path(item['file']).name != item['file']:
            raise ValueError('Unsafe migration path')
        file = migrations / item['file']
        if file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Migration content mismatch')
    cli = args.cli.resolve(strict=True)
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG') if key in os.environ}
    env.update(SUPABASE_HOME=str(home), SUPABASE_EXPERIMENTAL_STACK='1', DO_NOT_TRACK='1')
    version = subprocess.run([str(cli), '--version'], env=env, capture_output=True, text=True, check=True)
    if version.stdout.strip() != '2.121.0':
        raise ValueError('This procedure requires the verified Supabase CLI 2.121.0')
    verified = verify_archives(args.artifacts) if args.artifacts else []
    sockets = []
    try:
        for port in expected.values():
            listener = socket.socket()
            sockets.append(listener)
            listener.bind(('127.0.0.1', port))
        home.mkdir(mode=0o700, parents=False)
    finally:
        for listener in sockets:
            listener.close()
    os.umask(0o077)
    if verified:
        install_archives(home, verified)
    with (workspace / 'start-native.private.log').open('x') as log:
        result = subprocess.run([str(cli), 'stack', 'start', '--runtime', 'native', '--stack', name,
            '--exclude', 'realtime,storage,functions,studio,mail,analytics,pooler', '--eager',
            '--preparation', 'on-demand', '--agent', 'yes'], cwd=workspace, env=env, stdout=log, stderr=log)
    if result.returncode:
        raise RuntimeError('Native startup failed; retain private log and inspect before resuming')
    with (workspace / 'status.private.json').open('x') as status, (workspace / 'status.private.log').open('x') as log:
        subprocess.run([str(cli), 'stack', 'status', '--stack', name, '--output-format', 'json'],
            cwd=workspace, env=env, stdout=status, stderr=log, check=True)
    status = json.loads((workspace / 'status.private.json').read_text())
    if status['runtime'] != 'native' or status['identity']['name'] != name or status['env']['API_URL'] != 'http://127.0.0.1:55461':
        raise ValueError('Started stack identity mismatch')
    print(json.dumps({'status': 'NATIVE_STARTED_MIGRATIONS_UNVERIFIED', 'stack': name,
        'api': 'http://127.0.0.1:55461', 'providerCalls': 0}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Native startup stopped ({type(error).__name__}). Inspect the private local log; no automatic reset or retry.', file=sys.stderr)
        sys.exit(1)
