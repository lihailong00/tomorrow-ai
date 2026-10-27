import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("tada_initialize", Path(__file__).with_name("initialize.py"))
initialize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(initialize)


class InitializationTests(unittest.TestCase):
    def test_fresh_instance_and_restart_keep_secrets_without_printing(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(initialize.os, "chown", create=True):
            data, secrets = Path(folder) / "data", Path(folder) / "secrets"
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                initialize.initialize(data, secrets)
                first = (data / "runtime.env").read_bytes()
                database_secret = (secrets / "postgres-password").read_bytes()
                initialize.initialize(data, secrets)
            self.assertEqual(first, (data / "runtime.env").read_bytes())
            self.assertEqual(database_secret, (secrets / "postgres-password").read_bytes())
            self.assertNotIn(database_secret.decode().strip(), output.getvalue())
            self.assertNotIn("AGENT_SERVICE_TOKEN=", output.getvalue())
            self.assertTrue((data / "uploads").is_dir())

    def test_lost_database_secret_volume_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(initialize.os, "chown", create=True), contextlib.redirect_stdout(io.StringIO()):
            data, secrets = Path(folder) / "data", Path(folder) / "secrets"
            initialize.initialize(data, secrets)
            runtime = (data / "runtime.env").read_bytes()
            secret = secrets / "postgres-password"
            secret.chmod(0o600)
            secret.unlink()
            with self.assertRaises(SystemExit):
                initialize.initialize(data, secrets)
            self.assertEqual(runtime, (data / "runtime.env").read_bytes())

    def test_lost_runtime_keeps_existing_secret_and_config_without_generating_keys(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(initialize.os, "chown", create=True), contextlib.redirect_stdout(io.StringIO()):
            data, secrets = Path(folder) / "data", Path(folder) / "secrets"
            initialize.initialize(data, secrets)
            runtime = (data / "runtime.env").read_bytes()
            database_secret = (secrets / "postgres-password").read_bytes()
            master = data / "config" / "master.key"
            master.write_bytes(b"existing-config-master-key")
            (data / "runtime.env").unlink()
            with patch.object(initialize.secrets, "token_hex") as generate:
                with self.assertRaisesRegex(SystemExit, r"runtime\.env.*恢复原始"):
                    initialize.initialize(data, secrets)
                generate.assert_not_called()
            self.assertFalse((data / "runtime.env").exists())
            self.assertEqual(database_secret, (secrets / "postgres-password").read_bytes())
            self.assertEqual(b"existing-config-master-key", master.read_bytes())
            # Restoring the original runtime makes the same instance restartable.
            (data / "runtime.env").write_bytes(runtime)
            initialize.initialize(data, secrets)
            self.assertEqual(runtime, (data / "runtime.env").read_bytes())

    def test_retained_secret_alone_is_not_a_fresh_install(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(initialize.os, "chown", create=True):
            data, secrets = Path(folder) / "data", Path(folder) / "secrets"
            secrets.mkdir()
            password = secrets / "postgres-password"
            password.write_text("a" * 64 + "\n")
            with patch.object(initialize.secrets, "token_hex") as generate:
                with self.assertRaisesRegex(SystemExit, "runtime.env"):
                    initialize.initialize(data, secrets)
                generate.assert_not_called()
            self.assertFalse((data / "runtime.env").exists())
            self.assertEqual("a" * 64 + "\n", password.read_text())

    def test_retained_data_without_either_secret_fails_before_writing(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(initialize.os, "chown", create=True):
            data, secrets = Path(folder) / "data", Path(folder) / "secrets"
            config = data / "config"
            config.mkdir(parents=True)
            (config / "master.key").write_bytes(b"restored-config")
            with patch.object(initialize.secrets, "token_hex") as generate:
                with self.assertRaisesRegex(SystemExit, "runtime.env"):
                    initialize.initialize(data, secrets)
                generate.assert_not_called()
            self.assertFalse((data / "runtime.env").exists())
            self.assertFalse((secrets / "postgres-password").exists())
            self.assertEqual(b"restored-config", (config / "master.key").read_bytes())

    def test_duplicate_runtime_and_bad_key_rejected(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(initialize.os, "chown", create=True), contextlib.redirect_stdout(io.StringIO()):
            data, secrets = Path(folder) / "data", Path(folder) / "secrets"
            initialize.initialize(data, secrets)
            runtime = data / "runtime.env"
            runtime.write_text(runtime.read_text() + "AGENT_SERVICE_TOKEN=bad\n")
            with self.assertRaises(SystemExit):
                initialize.initialize(data, secrets)


if __name__ == "__main__":
    unittest.main()
