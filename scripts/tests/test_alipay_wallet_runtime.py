"""Offline installer integrity/overwrite checks; no wallet commands execute."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('wallet_installer', Path(__file__).resolve().parents[1] / 'Install-AlipayWalletRuntime.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def bundle(self, version='0.4.9'):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            for name in installer.FILES:
                content = json.dumps({'version': version, 'target': 'linux-amd64'}).encode() if name == 'version.json' else b'synthetic-file'
                archive.writestr(name, content)
            archive.writestr('../../never-extract-this', b'not allowed')
        return output.getvalue()

    def test_corrupt_archive_is_rejected_before_creating_any_files(self):
        with tempfile.TemporaryDirectory(prefix='tada-alipay-test-') as directory:
            target = Path(directory) / 'runtime'
            with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(b'corrupt-release')):
                with self.assertRaisesRegex(ValueError, 'integrity'):
                    installer.install(target, None)
            self.assertFalse(target.exists())

    def test_validated_release_never_overwrites_an_existing_unknown_binary(self):
        archive = self.bundle()
        with tempfile.TemporaryDirectory(prefix='tada-alipay-test-') as directory:
            target = Path(directory) / 'runtime'
            target.mkdir()
            (target / 'alipay-bot').write_bytes(b'active-unknown-runtime')
            with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(archive)), patch.object(installer, 'SHA256', hashlib.sha256(archive).hexdigest()), patch.object(installer, 'BINARY_SHA256', hashlib.sha256(b'synthetic-file').hexdigest()):
                with self.assertRaisesRegex(ValueError, 'overwrite'):
                    installer.install(target, None)
            self.assertEqual((target / 'alipay-bot').read_bytes(), b'active-unknown-runtime')
            self.assertEqual(len(list(target.iterdir())), 1)

    def test_only_pinned_platform_and_whitelisted_files_can_be_installed(self):
        for version in ['0.4.9', '999.0']:
            archive = self.bundle(version)
            with tempfile.TemporaryDirectory(prefix='tada-alipay-test-') as directory:
                target = Path(directory) / 'runtime'
                with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(archive)), patch.object(installer, 'SHA256', hashlib.sha256(archive).hexdigest()), patch.object(installer, 'BINARY_SHA256', hashlib.sha256(b'synthetic-file').hexdigest()):
                    if version != '0.4.9':
                        with self.assertRaisesRegex(ValueError, 'platform/version'):
                            installer.install(target, None)
                        self.assertFalse(target.exists())
                    else:
                        result = installer.install(target, None)
                        self.assertFalse(result['wallet_activated'])
                        self.assertEqual(result['files'], 6)
                        self.assertEqual({str(path.relative_to(target)).replace('\\', '/') for path in target.rglob('*') if path.is_file()}, installer.FILES)
                self.assertFalse((Path(directory) / 'never-extract-this').exists())

    def test_drive_root_is_rejected_without_network_access(self):
        with patch.object(installer.urllib.request, 'urlopen') as network:
            with self.assertRaises(ValueError):
                installer.install(Path(Path.cwd().anchor), None)
            network.assert_not_called()


if __name__ == '__main__':
    unittest.main()
