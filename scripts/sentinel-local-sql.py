"""Execute stdin SQL only against an explicitly selected Sentinel judge native DB."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit, unquote


def target(status, home):
    name = status.get('identity', {}).get('name', '')
    if status.get('runtime') != 'native' or not re.fullmatch(r'sentinel-judge-[a-z0-9][a-z0-9-]{0,40}', name):
        raise ValueError('Expected judge native stack')
    if home.name != name or not home.is_absolute() or str(home).startswith('/mnt/'):
        raise ValueError('Wrong native home')
    env = status['env']
    if env['API_URL'] != 'http://127.0.0.1:55461':
        raise ValueError('Wrong API target')
    url = urlsplit(env['DB_URL'])
    if url.scheme not in ('postgres', 'postgresql') or url.hostname != '127.0.0.1' or url.port != 55462 or url.path != '/postgres' or url.query or url.fragment:
        raise ValueError('Wrong database target')
    if not url.username or not url.password:
        raise ValueError('Missing local credentials')
    return url


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--status', type=Path, required=True)
    parser.add_argument('--home', type=Path, required=True)
    args = parser.parse_args()
    status = json.loads(args.status.read_text(encoding='utf-8-sig'))
    url = target(status, args.home)
    binaries = list((args.home / 'cache').glob('**/bin/psql'))
    if len(binaries) != 1 or not binaries[0].resolve().is_relative_to(args.home.resolve()):
        raise ValueError('Expected one owned psql binary')
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG') if key in os.environ}
    env.update(PGPASSWORD=unquote(url.password), PGCONNECT_TIMEOUT='5')
    return subprocess.run([str(binaries[0]), '-h', '127.0.0.1', '-p', '55462', '-U', unquote(url.username),
                           '-d', 'postgres', '-X', '-At', '-v', 'ON_ERROR_STOP=1'], input=sys.stdin.buffer.read(), env=env).returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(f'Local SQL stopped ({type(error).__name__}); verify the explicit judge target.', file=sys.stderr)
        sys.exit(1)
