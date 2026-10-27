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
