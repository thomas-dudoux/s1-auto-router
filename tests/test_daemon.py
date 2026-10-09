import http.client
import json
import socket
import tempfile
import threading
from pathlib import Path

import pytest

from s1.client import post
from s1.daemon import serve
from s1.runtime import S1


class CharTok:
    def encode(self, text, add_special_tokens=False):
        return [ord(c) for c in text]


def scripted_score(items):
    # option A gets logit 1, every other option 0
    return [[[1.0] + [0.0] * (n - 1) for n in it["nopts"]] for it in items]


@pytest.fixture
def sock():
    """A daemon over a fake S1 on a real temporary unix socket (under /tmp: sun_path is about 100 bytes)."""
    path = str(Path(tempfile.mkdtemp(dir="/tmp")) / "s1.sock")
    server = serve(S1(CharTok(), scripted_score, {}, name="decider-fake"), path)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield path
    server.shutdown()
    server.server_close()


QUESTIONS = [
    {"id": "M1", "type": "choice", "text": "What kind of work?",
     "options": [{"id": "locate", "description": "find code"}, {"id": "design", "description": "design a module"}]},
    {"id": "M2", "type": "yesno", "text": "Does it span many files?", "options": []},
    {"id": "E1", "type": "score", "text": "How open?",
     "options": [{"id": "clear", "description": "fully specified"}, {"id": "very_open", "description": "open-ended"}]},
]


def test_answers_every_question_type_with_the_loaded_model_id(sock):
    status, body = post(sock, "/v1/answer", {"version": 1, "state": {"description": "find X"}, "questions": QUESTIONS})
    assert status == 200
    assert body["version"] == 1
    assert body["model"] == "decider-fake"
    answers = body["answers"]
    assert set(answers) == {"M1", "M2", "E1"}
    assert set(answers["M1"]["probs"]) == {"locate", "design"}
    assert set(answers["M2"]["probs"]) == {"yes", "no"}
    assert set(answers["E1"]["probs"]) == {"clear", "very_open"}
    for a in answers.values():
        assert sum(a["probs"].values()) == pytest.approx(1)
        assert a["confidence"] == pytest.approx(max(a["probs"].values()))


def post_raw(path, url, raw):
    conn = http.client.HTTPConnection("s1")
    conn.sock = socket.socket(socket.AF_UNIX)
    conn.sock.connect(path)
    conn.request("POST", url, raw)
    res = conn.getresponse()
    return res.status, json.loads(res.read())


@pytest.mark.parametrize("raw, message", [
    ("not json", "Expecting value"),
    ("[1, 2]", "JSON object"),
    (json.dumps({"version": 2, "state": {}, "questions": QUESTIONS}), "unsupported version 2"),
    (json.dumps({"state": {}, "questions": QUESTIONS}), "unsupported version None"),
    (json.dumps({"version": 1, "state": "x", "questions": QUESTIONS}), "state"),
    (json.dumps({"version": 1, "state": {}, "questions": []}), "non-empty"),
    (json.dumps({"version": 1, "state": {}, "questions": [{"id": "Q", "type": "rank", "text": "?"}]}), "type"),
    (json.dumps({"version": 1, "state": {}, "questions": [{"id": "Q", "type": "choice", "text": "?", "options": []}]}),
     "at least 2"),
    (json.dumps({"version": 1, "state": {}, "questions": [{"id": "Q", "type": "choice", "text": "?", "options": [
        {"id": str(i), "description": "d"} for i in range(11)]}]}), "at most 10"),
])
def test_a_bad_request_gets_an_error_and_the_daemon_keeps_serving(sock, raw, message):
    status, body = post_raw(sock, "/v1/answer", raw)
    assert status == 400
    assert message in body["error"]

    status, ok = post(sock, "/v1/answer", {"version": 1, "state": {}, "questions": QUESTIONS})
    assert status == 200 and set(ok["answers"]) == {"M1", "M2", "E1"}


def test_an_unknown_endpoint_is_a_404(sock):
    status, body = post_raw(sock, "/v2/answer", "{}")
    assert status == 404 and "error" in body
