"""Private, size-bounded logs shared by decision and managed daemon writers."""
from __future__ import annotations

import fcntl
import json
import os
import stat
import sys
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

_CONFIG_LIMIT = 64 * 1024


@dataclass(frozen=True)
class Policy:
    max_bytes: int = 10 * 1024 * 1024
    backup_count: int = 3

    def __post_init__(self):
        if type(self.max_bytes) is not int or self.max_bytes <= 0:
            raise ValueError("max_bytes must be a positive integer")
        if type(self.backup_count) is not int or self.backup_count < 0:
            raise ValueError("backup_count must be a nonnegative integer")


def _warn(message: str) -> None:
    with suppress(OSError, ValueError):
        print(f"s1-auto-router: {message}", file=sys.stderr)


def _read_config(path: Path) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("logging configuration must be a regular file")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(_CONFIG_LIMIT + 1)
        if len(data) > _CONFIG_LIMIT:
            raise ValueError("logging configuration exceeds 64 KiB")
        return data
    finally:
        os.close(fd)


def load_policy() -> Policy:
    path = Path.home() / ".config/s1-auto-router/logging.json"
    try:
        data = _read_config(path)
    except FileNotFoundError:
        return Policy()
    except (OSError, ValueError) as exc:
        _warn(f"cannot read {path}; using default logging policy: {exc}")
        return Policy()
    try:
        values = json.loads(data)
        if not isinstance(values, dict) or values.keys() - {"max_bytes", "backup_count"}:
            raise ValueError("expected an object containing max_bytes and/or backup_count")
        return Policy(**values)
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        _warn(f"invalid {path}; using default logging policy: {exc}")
        return Policy()


def _open_private(path: Path, *, create: bool = False) -> int:
    flags = os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK
    if create:
        flags |= os.O_CREAT
    fd = os.open(path, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError(f"log path is not a regular file: {path}")
        os.fchmod(fd, 0o600)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _write_all(fd: int, data: memoryview) -> None:
    while data:
        written = os.write(fd, data)
        if written == 0:
            raise OSError("log append made no progress")
        data = data[written:]


class RotatingLog:
    def __init__(self, path: Path, policy: Policy):
        self.path = Path(path)
        self.policy = policy

    def _archive(self, number: int) -> Path:
        return self.path.with_name(f"{self.path.name}.{number}")

    def _retain(self, path: Path, *, discard: bool = False) -> int | None:
        """Inspect and tighten files without opening a symlink target."""
        fd = _open_private(path)
        try:
            size = os.fstat(fd).st_size
            if discard or size > self.policy.max_bytes:
                path.unlink()
                return None
            return size
        finally:
            os.close(fd)

    def _prepare(self) -> tuple[int, list[int]]:
        archives = []
        prefix = self.path.name + "."
        with os.scandir(self.path.parent) as entries:
            for entry in entries:
                if not entry.name.startswith(prefix):
                    continue
                suffix = entry.name[len(prefix):]
                if not suffix.isascii() or not suffix.isdecimal():
                    continue
                number = int(suffix)
                discard = suffix != str(number) or not 1 <= number <= self.policy.backup_count
                path = self.path.parent / entry.name
                size = self._retain(path, discard=discard)
                if size is not None:
                    archives.append(number)
        try:
            size = self._retain(self.path) or 0
        except FileNotFoundError:
            size = 0
        return size, archives

    def _rotate(self, archives: list[int]) -> list[int]:
        if not self.policy.backup_count:
            self.path.unlink(missing_ok=True)
            return []
        retained = []
        for number in sorted(archives, reverse=True):
            source = self._archive(number)
            if number == self.policy.backup_count:
                source.unlink()
            else:
                source.replace(self._archive(number + 1))
                retained.append(number + 1)
        self.path.replace(self._archive(1))
        retained.append(1)
        return retained

    def _append_locked(self, data: bytes, *, record: bool) -> None:
        size, archives = self._prepare()
        if record and len(data) > self.policy.max_bytes:
            raise ValueError(f"decision record exceeds max_bytes ({self.policy.max_bytes})")
        view = memoryview(data)
        while view:
            if size and (size == self.policy.max_bytes or (
                record and size + len(view) > self.policy.max_bytes
            )):
                archives = self._rotate(archives)
                size = 0
            count = min(len(view), self.policy.max_bytes - size)
            fd = _open_private(self.path, create=True)
            try:
                _write_all(fd, view[:count])
            except OSError:
                if record:
                    os.ftruncate(fd, size)
                raise
            finally:
                os.close(fd)
            size += count
            view = view[count:]

    def append(self, data: bytes, *, record: bool = False) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = self.path.with_name(self.path.name + ".lock")
        fd = _open_private(lock, create=True)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            self._append_locked(data, record=record)
        finally:
            os.close(fd)
