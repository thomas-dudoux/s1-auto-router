"""Explicit setup and an offline launcher. Called by /s1-setup and the mod, respectively."""
import http.client
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from s1.client import post
from s1.daemon import SOCKET, daemon_lock

CACHE = Path(SOCKET).parent
READY = CACHE / "ready.json"
ROOT = Path(__file__).resolve().parent.parent


def health():
    try:
        status, body = post(SOCKET, "/v1/health", {}, timeout=1)
        return body if status == 200 and isinstance(body, dict) and body.get("version") == 1 and body.get("model") else None
    except (OSError, ValueError, http.client.HTTPException):
        return None


def start():
    """Return immediately. The child owns the shared lock before it loads a model, without downloading."""
    if health():
        return
    CACHE.mkdir(mode=0o700, parents=True, exist_ok=True)
    log = os.open(CACHE / "daemon.log", os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    with os.fdopen(log, "ab") as out:
        subprocess.Popen([sys.executable, "-m", "s1.daemon"], cwd=ROOT,
                         env={**os.environ, "HF_HUB_OFFLINE": "1"}, start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)


def stop():
    """Ask the shared daemon to stop; never kill an unverified PID from a stale file."""
    if not health():
        try:
            lock = daemon_lock(SOCKET)
        except BlockingIOError as error:
            raise RuntimeError("S1 is starting or an older daemon is running; wait for startup or stop the old daemon manually, then retry") from error
        try:
            Path(SOCKET).unlink(missing_ok=True)
        finally:
            lock.close()
        return
    status, body = post(SOCKET, "/v1/shutdown", {}, timeout=30)
    if status != 200:
        raise RuntimeError(f"S1 refused shutdown: {body}")
    deadline = time.monotonic() + 30
    while Path(SOCKET).exists():
        if time.monotonic() >= deadline:
            raise TimeoutError("S1 did not shut down in 30 seconds")
        time.sleep(0.1)


def setup(restart=False):
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError

    from s1.runtime import MODELS

    model = os.environ.get("S1_MODEL", "2B")
    if model not in MODELS:
        raise ValueError("S1_MODEL must be 2B or 4B")
    try:
        snapshot_download(MODELS[model], local_files_only=True)
    except LocalEntryNotFoundError:
        snapshot_download(MODELS[model])  # only explicit setup can download weights
    if restart:
        stop()
    start()
    deadline = time.monotonic() + 120
    while not health():
        if time.monotonic() >= deadline:
            raise TimeoutError(f"S1 did not become ready; inspect {CACHE / 'daemon.log'}")
        time.sleep(0.2)
    status, body = post(SOCKET, "/v1/answer", {
        "version": 1, "state": {"description": "Find a file"},
        "questions": [{"id": "smoke", "type": "yesno", "text": "Is this a lookup task?", "options": []}],
    })
    if status != 200 or set(body.get("answers", {}).get("smoke", {}).get("probs", {})) != {"yes", "no"}:
        raise RuntimeError(f"S1 smoke request failed: {body}")
    if not READY.exists():
        READY.write_text(json.dumps({"version": 1}) + "\n")
        READY.chmod(0o600)
    print(f"S1 ready: {body['model']}; smoke request passed. Use /s1-setup --restart to apply model or code changes.")


def main():
    args = sys.argv[1:]
    if args == ["start"]:
        start()
    elif args in ([], ["--restart"]):
        setup(restart=bool(args))
    else:
        raise ValueError("usage: python -m s1.setup [--restart|start]")


if __name__ == "__main__":
    main()
