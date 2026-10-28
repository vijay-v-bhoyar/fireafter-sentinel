import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('native_start', Path(__file__).with_name('sentinel-native-start.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StartBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sentinel-native-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.workspace = self.base / 'workspace' / 'sentinel-judge-test'
        (self.workspace / 'supabase/migrations').mkdir(parents=True)
        self.home = self.base / 'data' / 'sentinel-judge-test'
        self.home.parent.mkdir()
        self.cli = self.base / 'cli'
        self.cli.write_text('not executable')
        self.manifest = {'stack': self.workspace.name, 'status': 'FILES_PREPARED_NOT_STARTED',
                         'ports': {'api': 55461, 'database': 55462, 'shadow': 55460, 'app': 3043}, 'migrations': []}
        (self.workspace / 'workspace.json').write_text(json.dumps(self.manifest))
        (self.workspace / 'supabase/config.toml').write_text('''project_id="sentinel-judge-test"
[api]
port=55461
[db]
port=55462
shadow_port=55460
[auth]
enable_signup=false
site_url="http://127.0.0.1:3043"
''')
        self.args = ['start', '--workspace', str(self.workspace), '--cli', str(self.cli), '--home', str(self.home)]

    def test_existing_home_never_invokes_cli(self):
        self.home.mkdir()
        with patch('sys.argv', self.args), patch.object(module.subprocess, 'run') as run:
            with self.assertRaises(ValueError): module.main()
            run.assert_not_called()

    def test_changed_migration_inventory_never_invokes_cli(self):
        (self.workspace / 'supabase/migrations/unexpected.sql').write_text('select 1')
        with patch('sys.argv', self.args), patch.object(module.subprocess, 'run') as run:
            with self.assertRaises(ValueError): module.main()
            run.assert_not_called()

    def test_wrong_cli_version_does_not_create_home(self):
        with patch('sys.argv', self.args), patch.object(module.subprocess, 'run', return_value=SimpleNamespace(stdout='other')):
            with self.assertRaises(ValueError): module.main()
        self.assertFalse(self.home.exists())

    def test_failed_start_is_not_retried_and_has_no_inherited_provider_credentials(self):
        results = [SimpleNamespace(stdout='2.121.0\n'), SimpleNamespace(returncode=1)]
        with patch('sys.argv', self.args), patch.object(module.socket, 'socket'), patch.dict(module.os.environ, {'SUPABASE_ACCESS_TOKEN':'never-copy', 'SENTINEL_NEBIUS_API_KEY':'never-copy'}), patch.object(module.subprocess, 'run', side_effect=results) as run:
            with self.assertRaises(RuntimeError): module.main()
            self.assertEqual(run.call_count, 2)
            env = run.call_args.kwargs['env']
            self.assertNotIn('SUPABASE_ACCESS_TOKEN', env)
            self.assertNotIn('SENTINEL_NEBIUS_API_KEY', env)
            self.assertIn('--runtime', run.call_args.args[0])
            self.assertIn('native', run.call_args.args[0])
            self.assertEqual(env['SUPABASE_HOME'], str(self.home))


if __name__ == '__main__':
    unittest.main()
