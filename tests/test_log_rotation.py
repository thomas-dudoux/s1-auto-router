import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def append(home, record):
    return subprocess.run(
        [sys.executable, "-m", "s1.append_log", str(home / ".cache/s1-auto-router/decisions.jsonl")],
        input=json.dumps(record, ensure_ascii=False).encode() + b"\n", capture_output=True,
        cwd=ROOT, env={**os.environ, "HOME": str(home)}, timeout=5,
    )


def test_decision_rotation_retains_recent_complete_records(tmp_path):
    config = tmp_path / ".config/s1-auto-router/logging.json"
    config.parent.mkdir(parents=True)
    config.write_text('{"max_bytes": 18, "backup_count": 2}')
    for n in range(5):
        result = append(tmp_path, {"n": n})
        assert result.returncode == 0, result.stderr
    log = tmp_path / ".cache/s1-auto-router/decisions.jsonl"
    assert log.read_bytes() == b'{"n": 4}\n'
    assert Path(str(log) + ".1").read_bytes() == b'{"n": 2}\n{"n": 3}\n'
    assert Path(str(log) + ".2").read_bytes() == b'{"n": 0}\n{"n": 1}\n'
    assert not Path(str(log) + ".3").exists()


def configure(home, max_bytes, backup_count):
    config = home / ".config/s1-auto-router/logging.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps({"max_bytes": max_bytes, "backup_count": backup_count}))
    return config


def decision_path(home):
    return home / ".cache/s1-auto-router/decisions.jsonl"


def archive(log, number):
    return log.with_name(f"{log.name}.{number}")


def retained_records(log):
    archives = sorted(
        (path for path in log.parent.glob(log.name + ".*") if path.suffix[1:].isdigit()),
        key=lambda path: int(path.suffix[1:]),
        reverse=True,
    )
    return [
        json.loads(line)
        for path in [*archives, log]
        for line in path.read_bytes().splitlines()
    ]


def test_retention_evicts_oldest_generations(tmp_path):
    configure(tmp_path, 18, 2)
    for n in range(9):
        assert append(tmp_path, {"n": n}).returncode == 0
    log = decision_path(tmp_path)
    assert retained_records(log) == [{"n": n} for n in range(4, 9)]
    assert archive(log, 1).read_bytes() == b'{"n": 6}\n{"n": 7}\n'
    assert archive(log, 2).read_bytes() == b'{"n": 4}\n{"n": 5}\n'
    assert not archive(log, 3).exists()
    assert all(path.stat().st_size <= 18 for path in [log, archive(log, 1), archive(log, 2)])


def test_utf8_limits_count_bytes_and_allow_exact_limit(tmp_path):
    record = {"text": "é"}
    encoded = json.dumps(record, ensure_ascii=False).encode() + b"\n"
    configure(tmp_path, len(encoded), 1)
    assert append(tmp_path, record).returncode == 0
    assert append(tmp_path, record).returncode == 0
    log = decision_path(tmp_path)
    assert log.read_bytes() == encoded
    assert archive(log, 1).read_bytes() == encoded
    configure(tmp_path, len(encoded) - 1, 1)
    result = append(tmp_path, record)
    assert result.returncode != 0
    assert b"exceeds max_bytes" in result.stderr
    assert not log.exists()
    assert not archive(log, 1).exists()


def test_oversized_decision_is_dropped_without_partial_json(tmp_path):
    configure(tmp_path, 18, 2)
    assert append(tmp_path, {"n": 1}).returncode == 0
    log = decision_path(tmp_path)
    before = log.read_bytes()
    result = append(tmp_path, {"message": "x" * 100})
    assert result.returncode != 0
    assert b"exceeds max_bytes" in result.stderr
    assert log.read_bytes() == before
    assert not archive(log, 1).exists()
    assert append(tmp_path, {"n": 2}).returncode == 0
    assert retained_records(log) == [{"n": 1}, {"n": 2}]


def test_oversized_legacy_files_and_excess_archives_are_removed(tmp_path):
    configure(tmp_path, 18, 2)
    log = decision_path(tmp_path)
    log.parent.mkdir(parents=True)
    for path in [log, archive(log, 1)]:
        with path.open("wb") as stream:
            stream.truncate(1024 * 1024 * 1024)
    archive(log, 2).write_bytes(b'{"n": 0}\n')
    archive(log, 3).write_bytes(b"old")
    archive(log, 99).write_bytes(b"old")
    unrelated = [
        log.with_name(log.name + ".notes"),
        log.with_name(log.name + ".1.gz"),
        log.with_name("another.jsonl.99"),
    ]
    for path in unrelated:
        path.write_bytes(b"keep")
    assert append(tmp_path, {"n": 1}).returncode == 0
    assert log.stat().st_size <= 18
    assert log.read_bytes() == b'{"n": 1}\n'
    assert not archive(log, 1).exists()
    assert archive(log, 2).read_bytes() == b'{"n": 0}\n'
    assert not archive(log, 3).exists()
    assert not archive(log, 99).exists()
    assert all(path.read_bytes() == b"keep" for path in unrelated)


def test_zero_archives_keeps_only_current_complete_records(tmp_path):
    configure(tmp_path, 18, 2)
    for n in range(5):
        assert append(tmp_path, {"n": n}).returncode == 0
    configure(tmp_path, 18, 0)
    for n in range(5, 9):
        assert append(tmp_path, {"n": n}).returncode == 0
    log = decision_path(tmp_path)
    assert log.read_bytes() == b'{"n": 8}\n'
    assert list(log.parent.glob(log.name + ".[0-9]*")) == []


def test_configuration_changes_apply_on_next_decision(tmp_path):
    configure(tmp_path, 18, 3)
    for n in range(7):
        assert append(tmp_path, {"n": n}).returncode == 0
    log = decision_path(tmp_path)
    assert archive(log, 3).exists()
    configure(tmp_path, 9, 1)
    assert append(tmp_path, {"n": 7}).returncode == 0
    assert log.read_bytes() == b'{"n": 7}\n'
    assert archive(log, 1).read_bytes() == b'{"n": 6}\n'
    assert not archive(log, 2).exists()
    assert not archive(log, 3).exists()


@pytest.mark.parametrize("contents", [
    b"{", b"[]", b"null", b'{"unknown": 1}',
    b'{"max_bytes": true}', b'{"max_bytes": 0}', b'{"max_bytes": -1}',
    b'{"max_bytes": 1.5}', b'{"max_bytes": "18"}',
    b'{"backup_count": false}', b'{"backup_count": -1}', b'{"backup_count": 1.5}',
    b"\\xff", b" " * (64 * 1024 + 1),
    pytest.param(b'{"max_bytes": ' + b"[" * 10000 + b"0" + b"]" * 10000 + b"}", id="nested-json"),
])
def test_invalid_configuration_warns_and_uses_defaults(tmp_path, contents):
    config = configure(tmp_path, 1, 0)
    config.write_bytes(contents)
    result = append(tmp_path, {"message": "longer than the rejected one-byte policy"})
    assert result.returncode == 0, result.stderr
    assert b"using default logging policy" in result.stderr
    assert json.loads(decision_path(tmp_path).read_bytes())["message"].startswith("longer")


def test_missing_configuration_defaults_without_warning(tmp_path):
    result = append(tmp_path, {"n": 1})
    assert result.returncode == 0
    assert result.stderr == b""
    assert decision_path(tmp_path).read_bytes() == b'{"n": 1}\n'


def test_unreadable_configuration_warns_and_uses_defaults(tmp_path):
    config = configure(tmp_path, 1, 0)
    config.unlink()
    config.mkdir()
    result = append(tmp_path, {"n": 1})
    assert result.returncode == 0
    assert b"using default logging policy" in result.stderr
    assert decision_path(tmp_path).read_bytes() == b'{"n": 1}\n'


def test_optional_config_fields_default_and_large_backup_count_is_safe(tmp_path):
    config = configure(tmp_path, 9, 1)
    config.write_text('{"max_bytes": 9}')
    for n in range(5):
        assert append(tmp_path, {"n": n}).returncode == 0
    log = decision_path(tmp_path)
    assert retained_records(log) == [{"n": n} for n in range(1, 5)]
    config.write_text(json.dumps({"backup_count": 10**30}))
    assert append(tmp_path, {"message": "more than nine bytes"}).returncode == 0
    assert json.loads(log.read_bytes().splitlines()[-1]) == {"message": "more than nine bytes"}


def test_concurrent_decision_processes_do_not_interleave_or_lose_records(tmp_path):
    records = [{"n": f"{n:03}", "pad": "x" * 30} for n in range(32)]
    limit = len(json.dumps(records[0]).encode()) + 1
    configure(tmp_path, limit, len(records) - 1)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda record: append(tmp_path, record), records))
    assert all(result.returncode == 0 for result in results)
    log = decision_path(tmp_path)
    retained = retained_records(log)
    assert sorted(retained, key=lambda record: record["n"]) == records
    files = [log, *(archive(log, n) for n in range(1, len(records)))]
    assert all(path.stat().st_size == limit for path in files)
    assert not archive(log, len(records)).exists()


def test_all_retained_files_and_stable_lock_are_private(tmp_path):
    configure(tmp_path, 18, 2)
    log = decision_path(tmp_path)
    log.parent.mkdir(parents=True)
    log.write_bytes(b'{"n": 0}\n')
    archive(log, 1).write_bytes(b'{"n": 9}\n')
    lock = log.with_name(log.name + ".lock")
    lock.write_bytes(b"")
    for path in [log, archive(log, 1), lock]:
        path.chmod(0o666)
    inode = lock.stat().st_ino
    for n in range(1, 6):
        assert append(tmp_path, {"n": n}).returncode == 0
    assert lock.stat().st_ino == inode
    for path in [log, archive(log, 1), archive(log, 2), lock]:
        assert path.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize("suffix", ["", ".1", ".9", ".lock"])
def test_owned_symlinks_are_rejected_without_touching_targets(tmp_path, suffix):
    configure(tmp_path, 9, 1)
    log = decision_path(tmp_path)
    log.parent.mkdir(parents=True)
    target = tmp_path / "do-not-touch"
    target.write_bytes(b"outside data")
    target.chmod(0o644)
    link = log.with_name(log.name + suffix)
    link.symlink_to(target)
    result = append(tmp_path, {"n": 1})
    assert result.returncode != 0
    assert b"decision log append failed" in result.stderr
    assert link.is_symlink()
    assert target.read_bytes() == b"outside data"
    assert target.stat().st_mode & 0o777 == 0o644


def test_unrelated_archive_symlink_is_untouched(tmp_path):
    configure(tmp_path, 9, 1)
    log = decision_path(tmp_path)
    log.parent.mkdir(parents=True)
    target = tmp_path / "outside"
    target.write_bytes(b"keep")
    link = log.with_name(log.name + ".1.gz")
    link.symlink_to(target)
    for n in range(3):
        assert append(tmp_path, {"n": n}).returncode == 0
    assert link.is_symlink()
    assert target.read_bytes() == b"keep"


def test_large_positive_max_bytes_does_not_overflow_stdin_read(tmp_path):
    configure(tmp_path, 10**30, 1)
    result = append(tmp_path, {"n": 1})
    assert result.returncode == 0, result.stderr
    assert result.stderr == b""
    assert decision_path(tmp_path).read_bytes() == b'{"n": 1}\n'

