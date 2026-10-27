import hashlib
import base64
import importlib.util
import io
import json
import os
import struct
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

spec = importlib.util.spec_from_file_location("tada_restore", Path(__file__).with_name("restore.py"))
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def record(name, value):
    name = name.encode()
    return struct.pack(">HQ", len(name), len(value)) + name + value


def archive_payload(extra=None):
    entries = {"database.dump": b"fixture-pg-dump", "config/master.key": b"private-recovery-key", "uploads/e84d3e1f-580e-46a0-a815-f13e1ff747d0": b"private-upload"}
    if extra:
        entries.update(extra)
    manifest = {"format": "tada-instance-v1", "files": list(entries), "contains_secrets": True}
    return record("manifest.json", json.dumps(manifest).encode()) + b"".join(record(name, value) for name, value in entries.items())


def encrypt_fixture(plaintext, password="fixture-password-123"):
    salt = bytes(range(16))
    prefix = bytes(range(8))
    header = restore.MAGIC + salt + prefix + restore.ROUNDS.to_bytes(4, "big")
    cipher = AESGCM(hashlib.pbkdf2_hmac("sha256", password.encode(), salt, restore.ROUNDS, 32))
    result = header
    blocks = [plaintext[index:index + restore.CHUNK] for index in range(0, len(plaintext), restore.CHUNK)] + [b""]
    for counter, block in enumerate(blocks):
        kind = 1 if block else 2
        ciphertext = cipher.encrypt(prefix + counter.to_bytes(4, "big"), block, header + counter.to_bytes(4, "big") + bytes([kind]))
        result += struct.pack(">BI", kind, len(ciphertext)) + ciphertext
    return result


def encrypted_config_sql(key=bytes(range(32)), check=True):
    instance = "e84d3e1f-580e-46a0-a815-f13e1ff747d0"
    def encrypt(name, value, nonce):
        aad = ("tada:config:v1\0" + instance + "\0" + name).encode()
        return "v1:" + base64.b64encode(nonce + AESGCM(key).encrypt(nonce, value, aad)).decode()
    key_check = encrypt("__key_check", b"tada:instance-config-key:v1", b"0" * 12) if check else ""
    value = encrypt("MODEL_API_KEY", b"fixture-private-model-key", b"1" * 12)
    return ("COPY public.instance_config_meta (id, instance_id, revision, key_check) FROM stdin;\n"
            + "1\t" + instance + "\t0\t" + key_check + "\n\\.\n"
            + "COPY public.instance_config_values (name, ciphertext) FROM stdin;\n"
            + "MODEL_API_KEY\t" + value + "\n\\.\n")


class RestoreTests(unittest.TestCase):
    def test_missing_corrupt_wrong_or_conflicting_master_rejects_before_database_write(self):
        key = bytes(range(32))
        for candidate in [None, "corrupt", "56" * 32]:
            with self.subTest(candidate_kind="missing" if candidate is None else "invalid"), tempfile.TemporaryDirectory() as folder:
                source, data = Path(folder) / "source", Path(folder) / "data"
                (source / "config").mkdir(parents=True)
                (source / "uploads").mkdir()
                (source / "database.dump").write_bytes(b"fixture")
                if candidate is not None:
                    (source / "config/master.key").write_text(candidate)
                data.mkdir()
                marker = data / "original-marker"
                marker.write_text("unchanged")
                with patch.dict(os.environ, {"TADA_OFFLINE_RESTORE": "1", "TADA_CONFIG_MASTER_KEY": ""}), patch.object(restore, "config_dump_sql", return_value=encrypted_config_sql(key)), patch.object(restore.subprocess, "run") as command:
                    with self.assertRaises(restore.BackupError):
                        restore.apply_restore(source, data)
                    command.assert_not_called()
                self.assertEqual(marker.read_text(), "unchanged")
                self.assertFalse((data / "config").exists())

    def test_file_and_environment_material_restore_to_a_bootable_private_master(self):
        key = bytes(range(32))
        for source_kind in ["file", "environment"]:
            with self.subTest(source_kind=source_kind), tempfile.TemporaryDirectory() as folder:
                source, data = Path(folder) / "source", Path(folder) / "data"
                (source / "config").mkdir(parents=True)
                (source / "uploads").mkdir()
                (source / "database.dump").write_bytes(b"fixture")
                if source_kind == "file":
                    (source / "config/master.key").write_text(key.hex())
                else:
                    (source / "recovery").mkdir()
                    (source / "recovery/effective-secrets.env").write_text("TADA_CONFIG_MASTER_KEY=" + base64.b64encode(key).decode() + "\n")
                data.mkdir()
                with patch.dict(os.environ, {"TADA_OFFLINE_RESTORE": "1", "TADA_CONFIG_MASTER_KEY": "", "DATABASE_URL": "postgresql://owner:fixture@localhost/fixture"}), patch.object(restore, "config_dump_sql", return_value=encrypted_config_sql(key)), patch.object(restore.subprocess, "run") as command:
                    command.return_value.returncode = 0
                    restore.apply_restore(source, data)
                    self.assertEqual(command.call_count, 2)
                self.assertEqual(restore.recovery_key((data / "config/master.key").read_text()), key)
                if os.name != "nt":
                    self.assertEqual((data / "config/master.key").stat().st_mode & 0o777, 0o600)

    def test_legacy_empty_database_needs_no_invented_recovery_key(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"TADA_CONFIG_MASTER_KEY": ""}), patch.object(restore, "config_dump_sql", return_value="-- no encrypted settings tables\n"):
            source = Path(folder)
            restore.validate_config_recovery(source)
            self.assertFalse((source / "config/master.key").exists())

    def test_duplicate_incomplete_and_mismatched_config_data_fail_closed(self):
        sql = encrypted_config_sql()
        for invalid in [sql + sql, encrypted_config_sql(check=False), sql.replace("MODEL_API_KEY\t", "OTHER_KEY\t"), sql.replace("\\.\n", "", 1)]:
            with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"TADA_CONFIG_MASTER_KEY": ""}), patch.object(restore, "config_dump_sql", return_value=invalid):
                source = Path(folder)
                (source / "config").mkdir()
                (source / "config/master.key").write_text(bytes(range(32)).hex())
                with self.assertRaises(restore.BackupError):
                    restore.validate_config_recovery(source)

    def test_target_environment_must_match_archived_master(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"TADA_CONFIG_MASTER_KEY": "56" * 32}), patch.object(restore, "config_dump_sql", return_value=encrypted_config_sql()):
            source = Path(folder)
            (source / "config").mkdir()
            (source / "config/master.key").write_text(bytes(range(32)).hex())
            with self.assertRaises(restore.BackupError):
                restore.validate_config_recovery(source)

    def test_stream_round_trip_and_secret_not_plaintext(self):
        plain = archive_payload()
        encrypted = encrypt_fixture(plain)
        self.assertNotIn(b"private-recovery-key", encrypted)
        output = io.BytesIO()
        self.assertEqual(restore.decrypt(io.BytesIO(encrypted), output, "fixture-password-123"), len(plain))
        self.assertEqual(output.getvalue(), plain)

    def test_wrong_password_tamper_truncate_and_extra_bytes_rejected(self):
        encrypted = encrypt_fixture(archive_payload())
        tampered = bytearray(encrypted)
        tampered[80] ^= 1
        for data, password in [(encrypted, "wrong-password"), (bytes(tampered), "fixture-password-123"), (encrypted[:-21], "fixture-password-123"), (encrypted + b"x", "fixture-password-123")]:
            with self.assertRaises(restore.BackupError):
                restore.decrypt(io.BytesIO(data), io.BytesIO(), password)

    def test_path_traversal_and_unknown_roots_rejected(self):
        for name in ["../secret", "/root/key", "config/../../secret", "config\\key", "C:/key", "a//b", "outside/key", "config/\x00key"]:
            self.assertFalse(restore.safe_name(name), name)

    def test_bad_paths_and_duplicate_records_never_extract(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ["../escape", "config/key/../escape"]:
                with self.assertRaises(restore.BackupError):
                    restore.extract_records(io.BytesIO(archive_payload({name: b"x"})), Path(folder))
                for path in Path(folder).rglob("*"):
                    if path.is_file():
                        path.unlink()
            with self.assertRaises(restore.BackupError):
                restore.extract_records(io.BytesIO(archive_payload() + record("database.dump", b"again")), Path(folder))

    def test_complete_extract_requires_new_output_and_cleans_failed_stage(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "backup.tadabak"
            archive.write_bytes(encrypt_fixture(archive_payload()))
            with self.assertRaises(restore.BackupError):
                restore.extract_backup(archive, root / "bad", "wrong")
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["backup.tadabak"])
            manifest = restore.extract_backup(archive, root / "good", "fixture-password-123")
            self.assertTrue(manifest["contains_secrets"])
            self.assertEqual((root / "good/config/master.key").read_bytes(), b"private-recovery-key")
            with self.assertRaises(restore.BackupError):
                restore.extract_backup(archive, root / "good", "fixture-password-123")

    def test_declared_oversized_file_rejected_before_content_read(self):
        data = struct.pack(">HQ", 13, restore.MAX_BYTES + 1) + b"database.dump"
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(restore.BackupError):
            restore.extract_records(io.BytesIO(data), Path(folder))

    def test_restoration_disabled_without_explicit_offline_flag(self):
        previous = os.environ.pop("TADA_OFFLINE_RESTORE", None)
        try:
            with tempfile.TemporaryDirectory() as folder, self.assertRaises(restore.BackupError):
                restore.apply_restore(Path(folder), Path(folder) / "data")
        finally:
            if previous is not None:
                os.environ["TADA_OFFLINE_RESTORE"] = previous

    def test_database_credentials_are_environment_only(self):
        value = restore.postgres_env("postgresql://owner:private%40password@database:5432/tada")
        self.assertEqual(value["PGPASSWORD"], "private@password")
        self.assertEqual(value["PGHOST"], "database")
        for invalid in ["https://example.com", "postgresql://localhost/tada?sslmode=disable", "", "sqlite:data/x"]:
            with self.assertRaises(restore.BackupError):
                restore.postgres_env(invalid)

    def test_overlapping_paths_rejected_before_database_restore(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"TADA_OFFLINE_RESTORE": "1"}), patch.object(restore.subprocess, "run") as command:
            data = Path(folder) / "data"
            (data / "uploads" / "extracted").mkdir(parents=True)
            (data / "config").mkdir()
            with self.assertRaises(restore.BackupError):
                restore.apply_restore(data / "uploads" / "extracted", data)
            command.assert_not_called()
            with self.assertRaises(restore.BackupError):
                restore.apply_restore(data, data)
            command.assert_not_called()

    def test_other_filesystem_rejected_before_database_restore(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"TADA_OFFLINE_RESTORE": "1"}), patch.object(restore.subprocess, "run") as command:
            data = Path(folder) / "data"
            source = Path(folder) / "extracted"
            (source / "config").mkdir(parents=True)
            (source / "uploads").mkdir()
            data.mkdir()
            original_stat = Path.stat
            def fake_stat(path, *args, **kwargs):
                value = original_stat(path, *args, **kwargs)
                if path == source / "config":
                    fields = list(value)
                    fields[2] += 1
                    return os.stat_result(fields)
                return value
            with patch.object(Path, "stat", fake_stat), self.assertRaises(restore.BackupError):
                restore.apply_restore(source, data)
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
