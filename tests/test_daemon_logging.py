import contextlib
import fcntl
import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

from s1.client import post

ROOT = Path(__file__).resolve().parent.parent
FAKE_RUNTIME = r'''
import os
import subprocess
import sys
import time
import types
from pathlib import Path

if os.environ.get("FAKE_LAUNCH_PIDFILE") and "--managed" not in sys.argv:
    original_popen = subprocess.Popen

    def record_launch(*args, **kwargs):
        process = original_popen(*args, **kwargs)
        Path(os.environ["FAKE_LAUNCH_PIDFILE"]).write_text(str(process.pid))
        return process

    subprocess.Popen = record_launch

if os.environ.get("FAKE_THREAD_FAILURE"):
    import threading
    original_start = threading.Thread.start
    attempts = 0

    def fail_once(self):
        global attempts
        attempts += 1
        if attempts == int(os.environ["FAKE_THREAD_FAILURE"]):
            threading.Thread.start = original_start
            raise RuntimeError("can't start new thread")
        return original_start(self)

    threading.Thread.start = fail_once

runtime = types.ModuleType("s1.runtime")
loads = 0

class FakeS1:
    def __init__(self, count):
        self.name = "fake-model-" + str(count)

    def answer(self, state, questions):
        for _ in range(state.get("repeat", 1)):
            os.write(1, state.get("stdout", "").encode("latin-1"))
            os.write(2, state.get("stderr", "").encode("latin-1"))
        return {"test": {"model": self.name}}


def load(model):
    global loads
    loads += 1
    os.write(1, b"native-stdout:\xff\x00\n")
    os.write(2, b"native-stderr:\x80\n")
    print("python-stdout", flush=True)
    print("python-stderr", file=sys.stderr, flush=True)
    subprocess.run([sys.executable, "-S", "-c",
                    "import os; os.write(1, b'child-stdout\\n'); os.write(2, b'child-stderr\\n')"], check=True)
    if os.environ.get("FAKE_HOLD_CHILD"):
        child = subprocess.Popen([sys.executable, "-S", "-c", "import time; time.sleep(30)"])
        (Path.home() / "child.pid").write_text(str(child.pid))
    time.sleep(float(os.environ.get("FAKE_LOAD_DELAY", "0")))
    if os.environ.get("FAKE_LOAD_FAILURE"):
        raise RuntimeError("fake model startup failed")
    return FakeS1(loads)

runtime.load = load
sys.modules["s1.runtime"] = runtime
'''


@pytest.fixture
def daemon_home():
    # macOS unix socket paths are short; pytest's usual tmp_path can exceed sun_path.
    with tempfile.TemporaryDirectory(prefix="s1-log-", dir="/tmp") as directory:
        home = Path(directory)
        fake = home / "fake"
        fake.mkdir()
        (fake / "sitecustomize.py").write_text(FAKE_RUNTIME)
        config = home / ".config/s1-auto-router/logging.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"max_bytes": 4096, "backup_count": 3}))
        yield home
        child_pid = home / "child.pid"
        if child_pid.exists():
            with contextlib.suppress(ProcessLookupError):
                os.kill(int(child_pid.read_text()), signal.SIGTERM)


def _environment(home, extra=None):
    return {**os.environ, "HOME": str(home), "PYTHONPATH": os.pathsep.join((str(home / "fake"), str(ROOT))),
            **(extra or {})}


def _socket(home):
    return str(home / ".cache/s1-auto-router/s1.sock")


def _log(home):
    return home / ".cache/s1-auto-router/daemon.log"


def _logs(home):
    path = _log(home)
    return [item for item in path.parent.glob("daemon.log*")
            if item.name == "daemon.log" or item.name.removeprefix("daemon.log.").isdigit()]


def _log_bytes(home):
    chunks = []
    for path in sorted(_logs(home), reverse=True):
        with contextlib.suppress(FileNotFoundError, IsADirectoryError):
            chunks.append(path.read_bytes())
    return b"".join(chunks)


def _wait_until(condition, *, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = condition()
        if result:
            return result
        time.sleep(0.02)
    raise AssertionError("daemon did not reach the expected state")


def _health(home):
    try:
        status, body = post(_socket(home), "/v1/health", {}, timeout=0.5)
        return body if status == 200 else None
    except (OSError, ValueError, http.client.HTTPException):
        return None


def _answer(home, **state):
    status, body = post(_socket(home), "/v1/answer", {
        "version": 1, "state": state,
        "questions": [{"id": "test", "type": "yesno", "text": "Emit output?"}],
    }, timeout=5)
    assert status == 200
    return body


def _shutdown(home, process):
    if process.poll() is None:
        post(_socket(home), "/v1/shutdown", {}, timeout=2)
    process.wait(timeout=3)


@contextlib.contextmanager
def _launch(home, *, managed=True, extra=None):
    args = [sys.executable, "-u", "-m", "s1.daemon"]
    if managed:
        args.append("--managed")
    process = subprocess.Popen(args, cwd=ROOT, env=_environment(home, extra),
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        yield process
    finally:
        if process.poll() is None:
            with contextlib.suppress(OSError, ValueError, http.client.HTTPException):
                post(_socket(home), "/v1/shutdown", {}, timeout=1)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
        process.communicate(timeout=3)


def test_managed_entry_captures_python_native_and_inherited_child_bytes(daemon_home):
    with _launch(daemon_home) as process:
        _wait_until(lambda: _health(daemon_home))
        _shutdown(daemon_home, process)
        output = _log_bytes(daemon_home)
        for expected in (b"native-stdout:\xff\x00", b"native-stderr:\x80", b"python-stdout", b"python-stderr",
                         b"child-stdout", b"child-stderr"):
            assert expected in output
        assert process.communicate(timeout=1) == (b"", b"")


def test_live_rotation_preserves_health_and_the_loaded_model(daemon_home):
    config = daemon_home / ".config/s1-auto-router/logging.json"
    config.write_text(json.dumps({"max_bytes": 256, "backup_count": 3}))
    with _launch(daemon_home) as process:
        health = _wait_until(lambda: _health(daemon_home))
        for index in range(8):
            marker = f"tail-{index}\n"
            answer = _answer(daemon_home, stdout="\xff\x00" * 400 + marker)
            assert answer["model"] == "fake-model-1"
            _wait_until(lambda marker=marker: marker.encode() in _log_bytes(daemon_home))
            for path in _logs(daemon_home):
                try:
                    metadata = path.stat()
                except FileNotFoundError:
                    continue  # the writer can rename an archive between listing and stat
                assert metadata.st_size <= 256
                assert metadata.st_mode & 0o777 == 0o600
            assert _health(daemon_home) == health
        _shutdown(daemon_home, process)
        assert {path.name for path in _logs(daemon_home)} == {
            "daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.3",
        }


def test_foreground_entry_keeps_inherited_stdout_and_stderr(daemon_home):
    with _launch(daemon_home, managed=False) as process:
        _wait_until(lambda: _health(daemon_home))
        _shutdown(daemon_home, process)
        stdout, stderr = process.communicate(timeout=1)
        assert b"native-stdout:\xff\x00" in stdout and b"child-stdout" in stdout
        assert b"python-stdout" in stdout
        assert b"native-stderr:\x80" in stderr and b"child-stderr" in stderr
        assert b"python-stderr" in stderr
        assert not _log(daemon_home).exists()


def test_startup_contender_neither_loads_nor_installs_capture(daemon_home):
    with _launch(daemon_home, extra={"FAKE_LOAD_DELAY": "0.5"}) as winner:
        _wait_until(lambda: b"native-stdout" in _log_bytes(daemon_home))
        with _launch(daemon_home) as contender:
            assert contender.wait(timeout=2) == 0
        _wait_until(lambda: _health(daemon_home))
        _shutdown(daemon_home, winner)
        assert _log_bytes(daemon_home).count(b"native-stdout") == 1

@pytest.mark.parametrize("failure_at", ["1", "2"])
def test_logging_thread_creation_failure_still_serves_requests(daemon_home, failure_at):
    with _launch(daemon_home, extra={"FAKE_THREAD_FAILURE": failure_at}) as process:
        health = _wait_until(lambda: _health(daemon_home))
        assert _answer(daemon_home)["model"] == health["model"]
        _shutdown(daemon_home, process)
        assert process.returncode == 0



def test_managed_startup_failure_captures_traceback_and_releases_singleton(daemon_home):
    with _launch(daemon_home, extra={"FAKE_LOAD_FAILURE": "1"}) as failed:
        assert failed.wait(timeout=3) != 0
    output = _log_bytes(daemon_home)
    assert b"Traceback (most recent call last)" in output
    assert b"RuntimeError: fake model startup failed" in output
    with _launch(daemon_home):
        assert _wait_until(lambda: _health(daemon_home))["model"] == "fake-model-1"


def test_storage_failure_does_not_block_output_and_logging_can_recover(daemon_home):
    log = _log(daemon_home)
    log.mkdir(parents=True)
    with _launch(daemon_home):
        health = _wait_until(lambda: _health(daemon_home))
        _answer(daemon_home, stdout="x" * 65536, stderr="y" * 65536, repeat=64)
        assert _health(daemon_home) == health
        log.rmdir()

        def recovered():
            _answer(daemon_home, stdout="storage-recovered\n")
            return b"storage-recovered" in _log_bytes(daemon_home)

        _wait_until(recovered)
        assert _health(daemon_home) == health


@pytest.mark.parametrize("blocked_storage", [False, True])
def test_shutdown_is_bounded_with_inherited_pipe_and_blocked_storage(daemon_home, blocked_storage):
    log = _log(daemon_home)
    log.parent.mkdir(parents=True)
    with (log.parent / "daemon.log.lock").open("wb") as lock:
        if blocked_storage:
            fcntl.flock(lock, fcntl.LOCK_EX)
        with _launch(daemon_home, extra={"FAKE_HOLD_CHILD": "1"}) as process:
            health = _wait_until(lambda: _health(daemon_home))
            _answer(daemon_home, stdout="x" * 65536, stderr="y" * 65536, repeat=64)
            assert _health(daemon_home) == health
            started = time.monotonic()
            _shutdown(daemon_home, process)
            assert time.monotonic() - started < 2.5
            assert not Path(_socket(daemon_home)).exists()


def test_setup_start_runs_detached_with_managed_capture(daemon_home):
    pid_file = daemon_home / "launched.pid"
    try:
        result = subprocess.run([sys.executable, "-m", "s1.setup", "start"], cwd=ROOT,
                                env=_environment(daemon_home, {"FAKE_LAUNCH_PIDFILE": str(pid_file)}),
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=3, check=True)
        assert result.stdout == result.stderr == b""
        health = _wait_until(lambda: _health(daemon_home))
        assert os.getsid(health["pid"]) == health["pid"]
        _wait_until(lambda: b"child-stdout" in _log_bytes(daemon_home))
    finally:
        if pid_file.exists():
            _terminate_detached(int(pid_file.read_text()))


def _terminate_detached(pid):
    with contextlib.suppress(ProcessLookupError):
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            os.kill(pid, 0)
            time.sleep(0.02)
        os.kill(pid, signal.SIGKILL)


@pytest.mark.parametrize("configuration", ["invalid", "unreadable"])
def test_managed_invalid_policy_warns_into_log_and_uses_defaults(daemon_home, configuration):
    config = daemon_home / ".config/s1-auto-router/logging.json"
    if configuration == "invalid":
        config.write_text("{")
    else:
        config.unlink()
        config.mkdir()
    with _launch(daemon_home) as process:
        _wait_until(lambda: _health(daemon_home))
        _shutdown(daemon_home, process)
        assert b"using default logging policy" in _log_bytes(daemon_home)


def test_managed_policy_changes_take_effect_only_on_next_start(daemon_home):
    config = daemon_home / ".config/s1-auto-router/logging.json"
    config.write_text(json.dumps({"max_bytes": 256, "backup_count": 3}))
    with _launch(daemon_home) as first:
        original = _wait_until(lambda: _health(daemon_home))
        _wait_until(lambda: b"native-stdout" in _log_bytes(daemon_home))
        config.write_text(json.dumps({"max_bytes": 64, "backup_count": 0}))
        _answer(daemon_home, stdout="x" * 600 + "before-restart\n")
        _wait_until(lambda: b"before-restart" in _log_bytes(daemon_home))
        assert _health(daemon_home) == original
        _shutdown(daemon_home, first)
        assert len(_logs(daemon_home)) == 4
        assert any(path.stat().st_size > 64 for path in _logs(daemon_home))
    with _launch(daemon_home) as restarted:
        current = _wait_until(lambda: _health(daemon_home))
        assert current["pid"] != original["pid"]
        _shutdown(daemon_home, restarted)
        assert [path.name for path in _logs(daemon_home)] == ["daemon.log"]
        assert _log(daemon_home).stat().st_size <= 64
