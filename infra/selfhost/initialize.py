#!/usr/bin/env python3
"""Generate only instance-local secrets, persist once, and never print values."""
import os
import secrets
from pathlib import Path


def private_write(path, value, mode=0o600):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())


def initialize(data, secret_dir):
    data.mkdir(mode=0o750, parents=True, exist_ok=True)
    secret_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    if data.is_symlink() or secret_dir.is_symlink():
        raise SystemExit("数据目录不能是符号链接")
    os.chmod(secret_dir, 0o755)
    password_file = secret_dir / "postgres-password"
    runtime = data / "runtime.env"
    if password_file.is_symlink():
        raise SystemExit("数据库密钥文件无效")
    if runtime.is_symlink():
        raise SystemExit("实例配置文件无效")
    # A retained password or any instance data means this is recovery, not a
    # first install. Replacing runtime.env would silently strand ciphertext
    # encrypted with the original CONNECTOR_ENCRYPTION_KEY.
    if not runtime.exists() and (password_file.exists() or any(data.iterdir())):
        raise SystemExit(
            "实例运行配置 /data/runtime.env 缺失，但检测到已有实例数据或数据库密钥。"
            "请保持服务停止，并从原私有卷或加密备份的 recovery/*.env 恢复原始 runtime.env；"
            "不能为已有数据生成替代密钥。"
        )
    if not password_file.exists():
        if runtime.exists():
            raise SystemExit("数据库密钥卷缺失，请恢复原有私有卷")
        private_write(password_file, secrets.token_hex(32) + "\n", 0o444)
    password = password_file.read_text().strip()
    if len(password) != 64 or any(c not in "0123456789abcdef" for c in password):
        raise SystemExit("数据库密钥文件无效")
    if not runtime.exists():
        private_write(runtime, "\n".join([
            f"DATABASE_URL=postgresql://tomorrow:{password}@postgres:5432/tomorrow",
            f"AGENT_SERVICE_TOKEN={secrets.token_hex(32)}",
            f"CONNECTOR_ENCRYPTION_KEY={secrets.token_hex(32)}",
            "",
        ]))
    values = {}
    for line in runtime.read_text().splitlines():
        name, separator, value = line.partition("=")
        if not separator or name in values:
            raise SystemExit("实例配置文件无效")
        values[name] = value
    expected_database = f"postgresql://tomorrow:{password}@postgres:5432/tomorrow"
    if values.get("DATABASE_URL") != expected_database or set(values) != {"DATABASE_URL", "AGENT_SERVICE_TOKEN", "CONNECTOR_ENCRYPTION_KEY"}:
        raise SystemExit("实例配置与数据库密钥不一致，请恢复原有私有卷")
    for name in ("AGENT_SERVICE_TOKEN", "CONNECTOR_ENCRYPTION_KEY"):
        if len(values[name]) != 64 or any(c not in "0123456789abcdef" for c in values[name]):
            raise SystemExit("实例内部密钥无效")
    for name in ("config", "uploads", "backups"):
        path = data / name
        path.mkdir(mode=0o700, exist_ok=True)
        if path.is_symlink():
            raise SystemExit("实例目录无效")
        os.chmod(path, 0o700)
        os.chown(path, 10001, 10001)
    os.chmod(data, 0o750)
    os.chown(data, 10001, 10001)
    os.chmod(runtime, 0o600)
    os.chown(runtime, 10001, 10001)
    print("实例本地密钥已准备；首次安装凭证将在 API 启动后保存在 /data/config/setup-token。")


def main():
    initialize(Path("/data"), Path("/secrets"))


if __name__ == "__main__":
    main()
