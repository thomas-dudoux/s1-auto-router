"""S1 daemon: HTTP on a unix socket, `POST /v1/answer` (state and typed questions in, per-option probabilities out).

    S1_MODEL=2B|4B uv run python -m s1.daemon

It knows nothing about Routing (ADR 0001). One request at a time; the model is loaded once at start.
"""
import http.server
import json
import os
import socketserver
from pathlib import Path

SOCKET = str(Path.home() / ".cache/s1-auto-router/s1.sock")
VERSION = 1
TYPES = {"choice", "yesno", "score"}


def _check(req):
    """Raise ValueError with a message unless req is a valid v1 request."""
    if not isinstance(req, dict):
        raise ValueError("request must be a JSON object")
    if req.get("version") != VERSION:
        raise ValueError(f"unsupported version {req.get('version')!r}, this daemon speaks {VERSION}")
    if not isinstance(req.get("state"), dict):
        raise ValueError("state must be a JSON object")
    qs = req.get("questions")
    if not isinstance(qs, list) or not qs:
        raise ValueError("questions must be a non-empty list")
    ids = set()
    for q in qs:
        if not isinstance(q, dict) or not isinstance(q.get("id"), str) or not isinstance(q.get("text"), str):
            raise ValueError(f"each question needs a string id and text: {q!r}")
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
    # HTTP/1.0 (the default): the connection closes after each response, so one client cannot hold the single-threaded server

    def do_POST(self):
        if self.path != "/v1/answer":
            return self._send(404, {"version": VERSION, "error": f"no such endpoint {self.path}"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            _check(req)
            answers = self.server.s1.answer(req["state"], req["questions"])
        except ValueError as e:  # includes malformed JSON and runtime limits (e.g. too many options)
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

    def address_string(self):  # a unix-socket peer has no (host, port)
        return "uds"


def serve(s1, path=SOCKET):
    """Bind the daemon for s1 to the unix socket at path (replacing a stale one) -> server; call serve_forever()."""
    Path(path).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.path.exists(path):
        os.unlink(path)
    server = socketserver.UnixStreamServer(path, Handler)
    server.s1 = s1
    return server


def main():
    from s1.runtime import load

    s1 = load(os.environ.get("S1_MODEL", "2B"))
    server = serve(s1)
    print(f"S1 daemon: {s1.name} on {SOCKET}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        os.unlink(SOCKET)


if __name__ == "__main__":
    main()
