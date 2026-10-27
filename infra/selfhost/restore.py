#!/usr/bin/env python3
"""Offline TADABAK2 inspection/extraction and explicit PostgreSQL instance restore.

Requires Python cryptography. Secrets are read from getpass/environment, never argv.
The HTTP API intentionally has no restore endpoint.
"""
import argparse
import getpass
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"TADABAK2"
ROUNDS = 600_000
MAX_BYTES = 256 * 1024 * 1024
CHUNK = 1024 * 1024
MAX_FILES = 20_000
SAFE_SQL = b"""BEGIN;
DELETE FROM sessions;
DELETE FROM admin_sessions;
DELETE FROM admin_invites;
UPDATE schedules SET enabled=0;
UPDATE tasks SET status='cancelled', claimed_until=0, error='Restored offline; start a new task to resume' WHERE status IN ('queued','running','waiting_approval');
COMMIT;
"""


class BackupError(Exception):
    pass


def exact(stream, length):
    value = stream.read(length)
    if len(value) != length:
        raise BackupError("备份不完整或口令无效")
    return value


def decrypt(source, target, passphrase):
    header = exact(source, 36)
    if header[:8] != MAGIC or int.from_bytes(header[32:36], "big") != ROUNDS:
        raise BackupError("备份格式不受支持")
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), header[8:24], ROUNDS, 32)
    cipher = AESGCM(key)
    prefix = header[24:32]
    counter = total = 0
    while True:
        kind, size = struct.unpack(">BI", exact(source, 5))
        if kind not in (1, 2) or not 16 <= size <= CHUNK + 16 or (kind == 2 and size != 16):
            raise BackupError("备份记录无效")
        nonce = prefix + counter.to_bytes(4, "big")
        aad = header + counter.to_bytes(4, "big") + bytes([kind])
        try:
            plaintext = cipher.decrypt(nonce, exact(source, size), aad)
        except Exception:
            raise BackupError("备份损坏或口令无效") from None
        if kind == 2:
            if plaintext or source.read(1):
                raise BackupError("备份结束记录无效")
            return total
        if not plaintext:
            raise BackupError("备份记录无效")
        total += len(plaintext)
        if total > MAX_BYTES or counter >= MAX_BYTES:
            raise BackupError("备份超过 256 MiB 限制")
        target.write(plaintext)
        counter += 1


def safe_name(name):
    parts = name.split("/")
    return (bool(name) and len(name.encode("utf-8")) <= 1024 and "\\" not in name
            and ":" not in name and not name.startswith("/") and len(parts) <= 25
            and all(part not in ("", ".", "..") and not any(ord(c) < 32 for c in part) for part in parts)
            and (name in ("manifest.json", "database.dump") or parts[0] in ("uploads", "config", "recovery")))


def extract_records(stream, directory):
    seen = set()
    total = 0
    manifest = None
    while True:
        first = stream.read(1)
        if not first:
            break
        name_size = int.from_bytes(first + exact(stream, 1), "big")
        size = int.from_bytes(exact(stream, 8), "big")
        if name_size > 1024:
            raise BackupError("备份文件名无效")
        try:
            name = exact(stream, name_size).decode("utf-8", errors="strict")
        except UnicodeError:
            raise BackupError("备份文件名无效") from None
        total += 10 + name_size + size
        if not safe_name(name) or name.casefold() in seen or total > MAX_BYTES or len(seen) >= MAX_FILES:
            raise BackupError("备份路径、文件数量或容量不符合限制")
        seen.add(name.casefold())
        if not seen or (len(seen) == 1 and name != "manifest.json"):
            raise BackupError("备份缺少清单")
        target = directory.joinpath(*name.split("/"))
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with target.open("xb") as output:
            os.chmod(target, 0o600)
            remaining = size
            while remaining:
                block = exact(stream, min(CHUNK, remaining))
                output.write(block)
                remaining -= len(block)
        if name == "manifest.json":
            if size > 4 * 1024 * 1024:
                raise BackupError("备份清单过大")
            try:
                manifest = json.loads(target.read_bytes())
            except Exception:
                raise BackupError("备份清单无效") from None
    if not isinstance(manifest, dict) or manifest.get("format") != "tada-instance-v1" or "database.dump" not in seen:
        raise BackupError("备份清单或数据库文件缺失")
    expected = manifest.get("files")
    if not isinstance(expected, list) or not all(isinstance(name, str) for name in expected):
        raise BackupError("备份文件清单无效")
    if set(expected) != {name for name in seen if name != "manifest.json"}:
        raise BackupError("备份文件与清单不一致")
    return manifest


def extract_backup(archive, output, passphrase):
    if output.exists() or output.is_symlink():
        raise BackupError("输出目录必须尚不存在")
    parent = output.parent.resolve(strict=True)
    if parent.is_symlink() or not parent.is_dir():
        raise BackupError("输出目录无效")
    stage = Path(tempfile.mkdtemp(prefix=".tada-restore-", dir=parent))
    os.chmod(stage, 0o700)
    try:
        with archive.open("rb") as source, tempfile.TemporaryFile(dir=stage) as plain:
            decrypt(source, plain, passphrase)
            plain.seek(0)
            content = stage / "content"
            content.mkdir(mode=0o700)
            manifest = extract_records(plain, content)
        content.rename(output)
        return manifest
    finally:
        shutil.rmtree(stage)


def postgres_env(database_url):
    parsed = urlsplit(database_url)
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname or parsed.query or parsed.fragment:
        raise BackupError("DATABASE_URL 必须为无查询参数的 PostgreSQL 地址")
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PGHOST": parsed.hostname,
            "PGPORT": str(parsed.port or 5432), "PGUSER": unquote(parsed.username or "tomorrow"),
            "PGPASSWORD": unquote(parsed.password or ""), "PGDATABASE": unquote(parsed.path.lstrip("/")),
            "PGCONNECT_TIMEOUT": "10", "PGSSLMODE": "prefer"}


def apply_restore(extracted, data_dir):
    if os.environ.get("TADA_OFFLINE_RESTORE") != "1":
        raise BackupError("请先停止 API、Agent 和 Worker，并显式设置 TADA_OFFLINE_RESTORE=1")
    if not data_dir.is_absolute() or data_dir.resolve() == Path(data_dir.anchor) or data_dir.is_symlink():
        raise BackupError("数据目录无效")
    data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    source_root = extracted.resolve(strict=True)
    target_root = data_dir.resolve(strict=True)
    if source_root == target_root:
        raise BackupError("解密目录不能与实例数据目录重合")
    target_device = target_root.stat().st_dev
    for name in ("uploads", "config"):
        if (data_dir / name).is_symlink() or (data_dir / (name + ".pre-restore")).exists():
            raise BackupError("目标包含符号链接或尚未处理的旧恢复目录")
        source = source_root / name
        if not source.exists():
            source.mkdir(mode=0o700)
        if source.is_symlink() or not source.is_dir() or source.stat().st_dev != target_device:
            raise BackupError("解密目录与实例目录必须位于同一文件系统")
    # Complete all predictable path checks before PostgreSQL can be changed.
    # In particular, an output nested inside current uploads/config would move
    # away with the old directory before its new contents can be installed.
    for source in (source_root, source_root / "uploads", source_root / "config"):
        for target in (target_root / "uploads", target_root / "config"):
            if source == target or source.is_relative_to(target) or target.is_relative_to(source_root / "uploads") or target.is_relative_to(source_root / "config"):
                raise BackupError("解密目录与待替换目录不能互相包含")
    if not os.access(target_root, os.W_OK | os.X_OK):
        raise BackupError("实例数据目录不可写")
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        runtime = data_dir / "runtime.env"
        if runtime.is_symlink() or runtime.stat().st_size > 64 * 1024:
            raise BackupError("实例运行配置无效")
        for line in runtime.read_text().splitlines():
            name, separator, value = line.partition("=")
            if separator and name == "DATABASE_URL":
                database_url = value
    environment = postgres_env(database_url)
    # stdin/file descriptors carry data. No database password is passed on argv.
    result = subprocess.run(["pg_restore", "--clean", "--if-exists", "--single-transaction", "--no-owner", "--no-acl", "--dbname", environment["PGDATABASE"], str(extracted / "database.dump")], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=900, check=False)
    if result.returncode:
        raise BackupError("数据库恢复失败；服务须继续保持停止状态")
    result = subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1"], input=SAFE_SQL, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False)
    if result.returncode:
        raise BackupError("数据库已恢复但会话与任务清理失败；服务须继续保持停止状态")
    for name in ("uploads", "config"):
        source = extracted / name
        if not source.exists():
            source.mkdir(mode=0o700)
        target = data_dir / name
        if target.exists():
            target.rename(data_dir / (name + ".pre-restore"))
        source.rename(target)
    # recovery/N.env is left for manual review: old DB hosts and credentials must
    # never replace the target instance's new deployment environment automatically.


def main():
    parser = argparse.ArgumentParser(description="妥啦离线备份恢复；默认只解密到新目录，不修改运行实例")
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--data-dir", type=Path, default=Path("/data"))
    args = parser.parse_args()
    try:
        password = getpass.getpass("备份口令：")
        manifest = extract_backup(args.archive, args.output, password)
        del password
        if args.apply:
            phrase = input("API、Agent、Worker 必须已停止。输入 REPLACE INSTANCE 确认替换：")
            if phrase != "REPLACE INSTANCE":
                raise BackupError("已解密，未替换运行实例")
            apply_restore(args.output, args.data_dir)
        print(json.dumps({"ok": True, "applied": args.apply, "created_at": manifest.get("created_at"), "schedules_enabled": False if args.apply else None, "recovery_env_manual_review": True}, ensure_ascii=False))
    except (BackupError, OSError, subprocess.SubprocessError, ValueError):
        # Never echo exceptions: database URLs, file contents and provider keys
        # can be present in third-party command or parser diagnostics.
        print("恢复未完成。请检查口令、文件完整性、空输出目录、离线状态和数据库工具；不会输出密钥或数据库错误详情。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
