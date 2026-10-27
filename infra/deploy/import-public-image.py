"""Import a public Docker Hub image via an explicit local proxy.

Used only when the Docker Desktop daemon cannot reach Docker Hub. No Docker
credentials or user model settings are read. Registry content hashes are checked.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

import requests


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", choices=["rust:1.92.0-bookworm", "node:22.19.0-bookworm-slim"])
    parser.add_argument("--proxy", default="http://127.0.0.1:7897")
    parser.add_argument("--cache", required=True)
    parser.add_argument("--context", default="desktop-linux")
    args = parser.parse_args()
    repo, tag = args.image.split(":", 1)
    repository = f"library/{repo}"
    cache = Path(args.cache).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.trust_env = False
    session.proxies = {"http": args.proxy, "https": args.proxy}
    auth = session.get("https://auth.docker.io/token", params={"service": "registry.docker.io", "scope": f"repository:{repository}:pull"}, timeout=60)
    auth.raise_for_status()
    token = auth.json()["token"]
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": ", ".join([
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
        ]),
    }
    registry = f"https://registry-1.docker.io/v2/{repository}"

    def manifest(ref: str) -> tuple[dict, str]:
        response = session.get(f"{registry}/manifests/{ref}", headers=headers, timeout=90)
        response.raise_for_status()
        actual = "sha256:" + hashlib.sha256(response.content).hexdigest()
        if ref.startswith("sha256:") and actual != ref:
            raise ValueError("Manifest content hash mismatch")
        expected = response.headers.get("Docker-Content-Digest")
        if expected and actual != expected:
            raise ValueError("Registry manifest digest mismatch")
        return response.json(), actual

    metadata, digest = manifest(tag)
    if "manifests" in metadata:
        chosen = next(item for item in metadata["manifests"] if item.get("platform", {}).get("os") == "linux" and item.get("platform", {}).get("architecture") == "amd64")
        metadata, digest = manifest(chosen["digest"])
    print(f"Selected {args.image} linux/amd64 {digest}", flush=True)
    image_dir = cache / repo
    image_dir.mkdir(exist_ok=True)

    def download(descriptor: dict) -> Path:
        blob_digest = descriptor["digest"]
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", blob_digest):
            raise ValueError("Unsupported public image blob digest")
        target = cache / (blob_digest.split(":", 1)[1] + ".blob")
        if target.exists():
            with target.open("rb") as existing:
                if "sha256:" + hashlib.file_digest(existing, "sha256").hexdigest() == blob_digest:
                    return target
        temporary = target.with_suffix(".partial")
        with requests.Session() as stream_session:
            stream_session.trust_env = False
            stream_session.proxies = session.proxies
            with stream_session.get(f"{registry}/blobs/{blob_digest}", headers={"Authorization": f"Bearer {token}"}, stream=True, timeout=(30, 180)) as response:
                response.raise_for_status()
                checksum = hashlib.sha256()
                with temporary.open("wb") as sink:
                    for chunk in response.iter_content(1024 * 1024):
                        checksum.update(chunk)
                        sink.write(chunk)
        if "sha256:" + checksum.hexdigest() != blob_digest:
            raise ValueError("Blob content hash mismatch")
        temporary.replace(target)
        print(f"Downloaded verified public blob {blob_digest[:23]} ({target.stat().st_size} bytes)", flush=True)
        return target

    descriptors = [metadata["config"], *metadata["layers"]]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        paths = list(pool.map(download, descriptors))
    config_bytes = paths[0].read_bytes()
    config_name = metadata["config"]["digest"].split(":", 1)[1] + ".json"
    config = json.loads(config_bytes)
    diff_ids = config["rootfs"]["diff_ids"]
    if len(diff_ids) != len(metadata["layers"]):
        raise ValueError("Image config layer count mismatch")
    archive_path = image_dir / "docker-image.tar"
    layer_names = []
    with tarfile.open(archive_path, "w") as archive:
        info = tarfile.TarInfo(config_name)
        info.size = len(config_bytes)
        archive.addfile(info, io.BytesIO(config_bytes))
        for index, (descriptor, blob_path) in enumerate(zip(metadata["layers"], paths[1:])):
            layer_path = image_dir / f"layer-{index}.tar"
            with blob_path.open("rb") as source:
                gzip_layer = source.read(2) == b"\x1f\x8b"
            with (gzip.open(blob_path, "rb") if gzip_layer else blob_path.open("rb")) as source, layer_path.open("wb") as sink:
                shutil.copyfileobj(source, sink, 1024 * 1024)
            with layer_path.open("rb") as source:
                if "sha256:" + hashlib.file_digest(source, "sha256").hexdigest() != diff_ids[index]:
                    raise ValueError("Uncompressed layer content hash mismatch")
            layer_name = descriptor["digest"].split(":", 1)[1] + "/layer.tar"
            layer_names.append(layer_name)
            archive.add(layer_path, arcname=layer_name, recursive=False)
        manifest_bytes = json.dumps([{"Config": config_name, "RepoTags": [args.image], "Layers": layer_names}]).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(manifest_bytes)
        archive.addfile(info, io.BytesIO(manifest_bytes))
    (image_dir / "source.json").write_text(json.dumps({"image": args.image, "platform": "linux/amd64", "manifest_digest": digest}, indent=2), encoding="utf-8")
    subprocess.run(["docker", "--context", args.context, "load", "--input", str(archive_path)], check=True)
    print(f"Imported {args.image} into Docker context {args.context}", flush=True)


if __name__ == "__main__":
    main()
