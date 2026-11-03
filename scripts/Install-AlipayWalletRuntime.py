"""Install the reviewed official wallet CLI without global npm/PATH changes.

Downloads public release bytes only. Does not execute the CLI, apply for a
wallet, bind an account, install PayGuard services, or perform a payment.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import urllib.request
import zipfile

URL = 'https://mdn.alipayobjects.com/aipay_assets/afts/file/bplFQ7Rb4uQAAAAAgKAAAAgAeoh5AQJr'
SHA256 = '42f89cd380d9ab808b29d0a0975a1efb77cb5b07da6becf1a6f246449ab808b8'
BINARY_SHA256 = '8e44c598f4eaca2241d0dd58972b28014cfd37e3511863ceff0eac6431e6b1dd'
FILES = {
    'alipay-bot', 'version.json',
    'dist/native/blueshield/linux-amd64/blueshield.node',
    'dist/native/blueshield/linux-amd64/nearx_bs.jpg',
    'dist/native/blueshield/linux-amd64/libblueshield.so',
    'dist/native/apguard/linux-amd64/libapguard.so',
}

def plain_path(path: Path) -> Path:
    if not path.is_absolute() or path == Path(path.anchor):
        raise ValueError('Choose an absolute, task-owned installation directory, not a drive root')
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError('Refusing a symlink in the installation path')
    return path.resolve()

def install(directory: Path, owner: str | None) -> dict:
    directory = plain_path(directory)
    marker = None
    if owner:
        if not 1 <= len(owner) <= 100 or any(ord(c) < 32 for c in owner):
            raise ValueError('Invalid Tada owner id')
        if os.name != 'posix' or os.getuid() == 0:
            raise ValueError('Provision the wallet as its dedicated non-root Linux service account')
        import pwd
        home = plain_path(Path.home())
        if home != Path(pwd.getpwuid(os.getuid()).pw_dir).resolve():
            raise ValueError('HOME must be the real OS account home, not an emulated user profile')
        home_stat = home.stat()
        if home_stat.st_uid != os.getuid() or stat.S_IMODE(home_stat.st_mode) & 0o077:
            raise ValueError('The real service account home must be owned by that account with mode 0700')
        marker = home / '.tada-alipay-owner'
        if marker.is_symlink():
            raise ValueError('Refusing a symlink owner marker')
        if marker.exists():
            marker_stat = marker.stat()
            if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_uid != os.getuid() or stat.S_IMODE(marker_stat.st_mode) & 0o077:
                raise ValueError('Owner marker must be a private regular file owned by this service account')
            if marker.read_text(encoding='utf-8').strip() != owner:
                raise ValueError('This OS wallet profile already belongs to another Tada account')
        if not marker.exists() and (home / '.alipay-bot-cli').exists():
            raise ValueError('Existing CLI state must not be adopted or reassigned to a Tada account')
    with urllib.request.urlopen(URL, timeout=30) as response:
        archive = response.read(15_000_001)
    if len(archive) > 15_000_000 or hashlib.sha256(archive).hexdigest() != SHA256:
        raise ValueError('Official release integrity verification failed')
    verified = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        if sum(info.file_size for info in bundle.infolist()) > 32_000_000:
            raise ValueError('Unexpected expanded release size')
        for name in sorted(FILES):
            data = bundle.read(name)
            if name == 'alipay-bot' and hashlib.sha256(data).hexdigest() != BINARY_SHA256:
                raise ValueError('Executable checksum mismatch')
            target = plain_path(directory / name)
            if not target.is_relative_to(directory):
                raise ValueError('Archive path escapes the installation directory')
            if target.exists() and target.read_bytes() != data:
                raise ValueError('Refusing to overwrite an unknown or active runtime: ' + str(target))
            verified[name] = (target, data)
        version = json.loads(verified['version.json'][1])
        if version.get('version') != '0.4.9' or version.get('target') != 'linux-amd64':
            raise ValueError('Unexpected official CLI platform/version')
        for name, (target, data) in verified.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                with target.open('xb') as stream:
                    stream.write(data)
            if os.name == 'posix':
                target.chmod(0o555 if name == 'alipay-bot' else 0o444)
    if marker is not None and not marker.exists():
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(owner + '\n')
    return {'version': '0.4.9', 'platform': 'linux-amd64', 'binary': str(directory / 'alipay-bot'),
            'binary_sha256': BINARY_SHA256, 'owner_provisioned': marker is not None,
            'files': len(verified), 'wallet_activated': False}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--owner-id', help='Authenticated Tada user id; requires a fresh dedicated OS account')
    options = parser.parse_args()
    print(json.dumps(install(options.directory, options.owner_id), ensure_ascii=False, indent=2))
