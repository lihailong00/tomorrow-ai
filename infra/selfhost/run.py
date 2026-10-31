#!/usr/bin/env python3
"""Small PID1 supervisor; all private services stay on container loopback."""
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ALLOWED_GENERATED = {"DATABASE_URL", "AGENT_SERVICE_TOKEN", "CONNECTOR_ENCRYPTION_KEY"}


def main():
    environment = dict(os.environ)
    for line in Path("/data/runtime.env").read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if not separator or name not in ALLOWED_GENERATED or not value or any(c in value for c in "\r\n\x00"):
            raise SystemExit("实例运行配置无效")
        environment.setdefault(name, value)
    children = []
    stopping = False

    def stop(_signal=None, _frame=None):
        nonlocal stopping
        stopping = True
        for child in children:
            if child.poll() is None:
                child.send_signal(signal.SIGINT)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        children.append(subprocess.Popen(["/usr/local/bin/node", "/opt/tada/agent/dist/server.js"], env=environment))
        # API has its own retry/readiness handling. API schema/config must be ready
        # before the worker starts reading durable work and settings.
        children.append(subprocess.Popen(["/usr/local/bin/tomorrow-api"], env=environment))
        import urllib.request
        ready = False
        for _ in range(120):
            if stopping or any(child.poll() is not None for child in children):
                break
            try:
                with urllib.request.urlopen("http://127.0.0.1:8080/v1/health", timeout=1) as response:
                    ready = response.status == 200
            except Exception:
                pass
            if ready:
                break
            time.sleep(0.5)
        if not ready:
            return 1
        children.append(subprocess.Popen(["/usr/local/bin/tomorrow-worker"], env=environment))
        while not stopping:
            if any(child.poll() is not None for child in children):
                return 1
            time.sleep(0.25)
        return 0
    finally:
        stop()
        deadline = time.monotonic() + 25
        for child in children:
            try:
                child.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()
        for child in children:
            child.wait()


if __name__ == "__main__":
    sys.exit(main())
