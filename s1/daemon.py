"""S1 daemon: HTTP on a unix socket, `POST /v1/answer` (state and typed questions in, per-option probabilities out).

    S1_MODEL=2B|4B uv run python -m s1.daemon

It knows nothing about Routing (ADR 0001). One request at a time; the model is loaded once at start.
"""
from __future__ import annotations

import fcntl
import http.server
import json
import os
import signal
import socket
import socketserver
import threading
import time
from pathlib import Path

SOCKET = str(Path.home() / ".cache/s1-auto-router/s1.sock")
VERSION = 1
TYPES = {"choice", "yesno", "score"}


def _check(req):
    """Raise ValueError or TypeError with a message unless req is a valid v1 request."""
    if not isinstance(req, dict):
        raise TypeError("request must be a JSON object")
    if req.get("version") != VERSION:
        raise ValueError(f"unsupported version {req.get('version')!r}, this daemon speaks {VERSION}")
    if not isinstance(req.get("state"), dict):
        raise TypeError("state must be a JSON object")
    qs = req.get("questions")
    if not isinstance(qs, list) or not qs:
        raise ValueError("questions must be a non-empty list")
    ids = set()
    for q in qs:
        if not isinstance(q, dict) or not isinstance(q.get("id"), str) or not isinstance(q.get("text"), str):
            raise TypeError(f"each question needs a string id and text: {q!r}")
        if q["id"] in ids:
            raise ValueError(f"duplicate question id {q['id']!r}")
        ids.add(q["id"])
        if q.get("type") not in TYPES:
            raise ValueError(f"question {q['id']}: type must be one of {sorted(TYPES)}")
        opts = q.get("options", [])
        if not isinstance(opts, list) or not all(
                isinstance(o, dict) and isinstance(o.get("id"), str) and isinstance(o.get("description"), str) for o in opts):
            raise ValueError(f"question {q['id']}: options must be a list of {{id, description}} strings")
        if q["type"] != "yesno" and len(opts) < 2:
            raise ValueError(f"question {q['id']}: a {q['type']} question needs at least 2 options")


class Handler(http.server.BaseHTTPRequestHandler):
    server: Server
    # HTTP/1.0 (the default): the connection closes after each response, so one client cannot hold the single-threaded server

    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def do_POST(self):
        self.server.last_activity = time.monotonic()
        if self.path == "/v1/health":
            return self._send(200, {"version": VERSION, "model": self.server.s1.name, "pid": os.getpid()})
        if self.path == "/v1/shutdown":
            self._send(200, {"version": VERSION})
            self.server.stop()
            return
        if self.path != "/v1/answer":
            return self._send(404, {"version": VERSION, "error": f"no such endpoint {self.path}"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            _check(req)
        except (ValueError, TypeError) as e:
            return self._send(400, {"version": VERSION, "error": str(e)})
        try:
            answers = self.server.s1.answer(req["state"], req["questions"])
        except ValueError as e:  # runtime limits (e.g. too many options)
            return self._send(400, {"version": VERSION, "error": str(e)})
        except Exception as e:
            return self._send(500, {"version": VERSION, "error": f"{type(e).__name__}: {e}"})
        self._send(200, {"version": VERSION, "model": self.server.s1.name, "answers": answers})

    def _send(self, status, body):
        out = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
        self.server.last_activity = time.monotonic()

    def address_string(self):  # a unix-socket peer has no (host, port)
        return "uds"


def daemon_lock(path):
    """Own this daemon before loading weights; never unlink another live server's socket."""
    cache = Path(path).parent
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = os.fdopen(os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if os.path.exists(path):
            with socket.socket(socket.AF_UNIX) as probe:
                probe.settimeout(1)
                try:
                    probe.connect(path)
                except (ConnectionRefusedError, FileNotFoundError):
                    pass
                else:
                    raise BlockingIOError("S1 is already running")
        return lock
    except BaseException:
        lock.close()
        raise


class Server(socketserver.UnixStreamServer):
    server_address: str

    def __init__(self, s1, path: str, lock, idle_seconds):
        self.lock = lock
        self.s1 = s1
        self.idle_seconds = idle_seconds
        self.last_activity = time.monotonic()
        self.stopping = False
        super().__init__(path, Handler)
        os.chmod(path, 0o600)

    def stop(self):
        if not self.stopping:
            self.stopping = True
            # shutdown waits for serve_forever, so it must run outside the request/signal thread.
            threading.Thread(target=self.shutdown, daemon=True).start()

    def service_actions(self):
        if time.monotonic() - self.last_activity >= self.idle_seconds:
            self.stop()

    def server_close(self):
        super().server_close()
        Path(self.server_address).unlink(missing_ok=True)
        self.lock.close()


def serve(s1, path: str = SOCKET, *, lock=None, idle_seconds=30 * 60):
    """Bind one daemon to path, replacing only a stale socket; close releases the lock and removes the socket."""
    lock = lock or daemon_lock(path)
    try:
        Path(path).unlink(missing_ok=True)
        return Server(s1, path, lock, idle_seconds)
    except BaseException:
        lock.close()
        raise


def main():
    from s1.runtime import load

    try:
        lock = daemon_lock(SOCKET)
    except BlockingIOError:
        return  # a concurrent session won the lock
    try:
        s1 = load(os.environ.get("S1_MODEL", "2B"))
        server = serve(s1, lock=lock)
    except BaseException:
        lock.close()
        raise
    signal.signal(signal.SIGTERM, lambda *_: server.stop())
    signal.signal(signal.SIGINT, lambda *_: server.stop())
    print(f"S1 daemon: {s1.name} on {SOCKET}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
