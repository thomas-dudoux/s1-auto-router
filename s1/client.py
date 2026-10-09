"""Manual check: send a sample v1 request to the running S1 daemon and print the answers.

    uv run python -m s1.client [socket path]
"""
import http.client
import json
import socket
import sys
import time

from s1.daemon import SOCKET


def post(path, url, body, timeout=30):
    """POST a JSON body over the unix socket at path -> (status, decoded JSON)."""
    conn = http.client.HTTPConnection("s1", timeout=timeout)
    conn.sock = socket.socket(socket.AF_UNIX)
    conn.sock.settimeout(timeout)
    conn.sock.connect(path)
    try:
        conn.request("POST", url, json.dumps(body), {"Content-Type": "application/json"})
        res = conn.getresponse()
        return res.status, json.loads(res.read())
    finally:
        conn.close()


def main(path=SOCKET):
    from s1.bench import QUESTIONS

    state = {"description": "Find where the S1 socket path is defined", "subagent_type": "Explore",
             "prompt": "Find the file and line that define the unix socket path of the S1 daemon. Report the path only."}
    t = time.perf_counter()
    status, body = post(path, "/v1/answer", {"version": 1, "state": state, "questions": QUESTIONS})
    print(f"HTTP {status} in {(time.perf_counter() - t) * 1000:.0f} ms, model {body.get('model')}")
    for qid, a in body.get("answers", {}).items():
        print(f"  {qid}: confidence {a['confidence']:.3f}  " + "  ".join(f"{o} {p:.3f}" for o, p in a["probs"].items()))
    if "error" in body:
        print("  error:", body["error"])


if __name__ == "__main__":
    main(*sys.argv[1:2])
