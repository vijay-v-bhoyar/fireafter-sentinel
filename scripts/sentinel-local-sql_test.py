import importlib.util
from pathlib import Path, PurePosixPath
import unittest

spec = importlib.util.spec_from_file_location('local_sql', Path(__file__).with_name('sentinel-local-sql.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SQLTargetTests(unittest.TestCase):
    def fixture(self):
        return {'runtime': 'native', 'identity': {'name': 'sentinel-judge-test'}, 'env': {
            'API_URL': 'http://127.0.0.1:55461', 'DB_URL': 'postgresql://postgres:synthetic@127.0.0.1:55462/postgres'}}

    def test_accepts_matching_target(self):
        self.assertEqual(module.target(self.fixture(), PurePosixPath('/home/local/sentinel-judge-test')).port, 55462)

    def test_denies_remote_old_port_and_database_overrides(self):
        for url in ['postgresql://postgres:synthetic@127.0.0.1:55342/postgres', 'postgresql://postgres:synthetic@example.com:55462/postgres', 'postgresql://postgres:synthetic@127.0.0.1:55462/other', 'postgresql://postgres:synthetic@127.0.0.1:55462/postgres?host=example.com']:
            status = self.fixture(); status['env']['DB_URL'] = url
            with self.assertRaises(ValueError): module.target(status, PurePosixPath('/home/local/sentinel-judge-test'))

    def test_denies_owner_identity_and_wrong_home(self):
        status = self.fixture(); status['identity']['name'] = 'sentinel-personas'
        with self.assertRaises(ValueError): module.target(status, PurePosixPath('/home/local/sentinel-personas'))
        with self.assertRaises(ValueError): module.target(self.fixture(), PurePosixPath('/home/local/other'))


if __name__ == '__main__':
    unittest.main()
