"""Verify pinned tar bytes, then extract only into a fresh native runtime cache."""
import hashlib
import json
from pathlib import Path
import tarfile

PINNED = json.loads(Path(__file__).with_name('sentinel-native-artifacts.json').read_text())['artifacts']


def verify_archives(directory, artifacts=PINNED):
    verified = []
    for artifact in artifacts:
        archive = directory / (artifact['service'] + '-runtime.tar')
        if archive.is_symlink() or archive.stat().st_size != artifact['tarBytes']:
            raise ValueError('Runtime archive size/type mismatch')
        with archive.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != artifact['tarSha256']:
            raise ValueError('Runtime archive checksum mismatch')
        with tarfile.open(archive) as tar:
            for member in tar.getmembers():
                # Preflight all members before extraction creates any cache entries.
                tarfile.data_filter(member, '/sentinel-archive-check')
                if member.name.startswith('/') or '..' in Path(member.name).parts or member.isdev():
                    raise ValueError('Unsafe runtime archive member')
        verified.append((artifact, archive))
    return verified


def install_archives(home, verified):
    for artifact, archive in verified:
        target = home / 'cache/stack/slim-services' / artifact['service'] / artifact['version'] / 'linux-amd64' / artifact['archiveSha256']
        target.mkdir(parents=True, exist_ok=False)
        with tarfile.open(archive) as tar:
            tar.extractall(target, filter='data')
