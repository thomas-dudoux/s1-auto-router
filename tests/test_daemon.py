import http.client
import json
import socket
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from s1 import daemon, setup
from s1.client import post
from s1.daemon import daemon_lock, serve
from s1.runtime import S1


class CharTok:
    def encode(self, text, add_special_tokens=False):
        return [ord(c) for c in text]


def scripted_score(items):
    # option A gets logit 1, every other option 0
    return [[[1.0] + [0.0] * (n - 1) for n in it["nopts"]] for it in items]


@pytest.fixture
def inference_events():
    return threading.Event(), threading.Event()


@pytest.fixture
def sock(request, inference_events):
    """A daemon over a fake S1 on a real temporary unix socket (under /tmp: sun_path is about 100 bytes)."""
    path = str(Path(tempfile.mkdtemp(dir="/tmp")) / "s1.sock")
    failure = getattr(request, "param", None)

    def score(items):
        nonlocal failure
        if failure == "slow":
            entered, release = inference_events
            entered.set()
            assert release.wait(timeout=10)
            return scripted_score(items)
        if failure is not None:
            error, failure = failure, None
            raise error
        return scripted_score(items)

    server = serve(S1(CharTok(), score, {}, name="decider-fake"), path)

    def run():
        with server:
            server.serve_forever()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    yield path
    server.shutdown()
    thread.join(timeout=5)


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
    (json.dumps({"version": 1, "state": {}, "questions": [1]}), "string id and text"),
    (json.dumps({"version": 1, "state": {}, "questions": [{"id": 1, "type": "yesno", "text": "?"}]}), "string id and text"),
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


@pytest.mark.parametrize("options", [None, [{"id": "A"}], [{"id": 1, "description": "x"}]])
def test_malformed_options_are_still_rejected(sock, options):
    question = {"id": "Q", "type": "choice", "text": "?", "options": options}
    status, body = post(sock, "/v1/answer", {"version": 1, "state": {}, "questions": [question]})
    assert status == 400
    assert "options must be a list" in body["error"]


@pytest.mark.parametrize("sock, status, error", [
    (TypeError("inference failed"), 500, "TypeError: inference failed"),
    (RuntimeError("inference failed"), 500, "RuntimeError: inference failed"),
    (ValueError("too many options"), 400, "too many options"),
], indirect=["sock"])
def test_inference_errors_preserve_the_contract_and_the_daemon_keeps_serving(sock, status, error):
    request = {"version": 1, "state": {}, "questions": QUESTIONS}
    actual_status, body = post(sock, "/v1/answer", request)
    assert actual_status == status
    assert body == {"version": 1, "error": error}
    actual_status, body = post(sock, "/v1/answer", request)
    assert actual_status == 200 and set(body["answers"]) == {"M1", "M2", "E1"}


@pytest.mark.parametrize("sock", ["slow"], indirect=True)
def test_stop_waits_for_busy_inference_and_removes_the_socket(monkeypatch, sock, inference_events):
    entered, release = inference_events
    monkeypatch.setattr(setup, "SOCKET", sock)
    with ThreadPoolExecutor(max_workers=1) as pool:
        answer = pool.submit(post, sock, "/v1/answer", {"version": 1, "state": {}, "questions": QUESTIONS})
        assert entered.wait(timeout=5)
        timer = threading.Timer(2, release.set)
        timer.start()
        try:
            setup.stop()
            assert answer.result(timeout=5)[0] == 200
            assert not Path(sock).exists()
        finally:
            release.set()
            timer.cancel()


def test_stop_preserves_an_incompatible_daemon(monkeypatch, sock):
    monkeypatch.setattr(setup, "SOCKET", sock)
    monkeypatch.setattr(daemon, "VERSION", 2)
    with pytest.raises(RuntimeError, match="older daemon"):
        setup.stop()
    status, body = post(sock, "/v1/health", {})
    assert status == 200 and body["version"] == 2
    assert Path(sock).exists()


def test_stop_preserves_an_unverified_startup_owner(monkeypatch, tmp_path):
    path = str(tmp_path / "s1.sock")
    monkeypatch.setattr(setup, "SOCKET", path)
    with daemon_lock(path):
        with pytest.raises(RuntimeError, match="starting"):
            setup.stop()
        with pytest.raises(BlockingIOError):
            daemon_lock(path)
