"""Archive integrity and extraction boundaries for the isolated judge runtime."""
import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from sentinel_native_artifacts import verify_archives, install_archives


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sentinel-artifact-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def archive(self, name='bin/runtime', link=None):
        archive = self.root / 'auth-runtime.tar'
        with tarfile.open(archive, 'w') as tar:
            entry = tarfile.TarInfo(name)
            if link:
                entry.type = tarfile.SYMTYPE
                entry.linkname = link
                tar.addfile(entry)
            else:
                entry.size = 4
                tar.addfile(entry, io.BytesIO(b'test'))
        return {'service': 'auth', 'version': 'test', 'archiveSha256': 'pinned',
                'tarBytes': archive.stat().st_size,
                'tarSha256': hashlib.sha256(archive.read_bytes()).hexdigest()}

    def test_valid_install_and_existing_cache_refusal(self):
        artifact = self.archive()
        verified = verify_archives(self.root, [artifact])
        home = self.root / 'fresh-home'
        install_archives(home, verified)
        target = home / 'cache/stack/slim-services/auth/test/linux-amd64/pinned/bin/runtime'
        self.assertEqual(target.read_bytes(), b'test')
        with self.assertRaises(FileExistsError):
            install_archives(home, verified)
        self.assertEqual(target.read_bytes(), b'test')

    def test_checksum_and_size_mismatch(self):
        artifact = self.archive()
        with self.assertRaisesRegex(ValueError, 'checksum'):
            verify_archives(self.root, [dict(artifact, tarSha256='0' * 64)])
        with self.assertRaisesRegex(ValueError, 'size'):
            verify_archives(self.root, [dict(artifact, tarBytes=1)])

    def test_parent_and_absolute_members_rejected(self):
        for name in ('../outside', '/absolute'):
            with self.subTest(name=name):
                artifact = self.archive(name)
                with self.assertRaises((ValueError, tarfile.FilterError)):
                    verify_archives(self.root, [artifact])

    def test_escaping_symlink_rejected(self):
        artifact = self.archive('escape', '../../outside')
        with self.assertRaises(tarfile.FilterError):
            verify_archives(self.root, [artifact])


if __name__ == '__main__':
    unittest.main()
