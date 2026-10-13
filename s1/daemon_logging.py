"""Bounded, best-effort capture of managed daemon stdout and stderr."""
from __future__ import annotations

import contextlib
import os
import queue
import select
import sys
import threading
import time
import traceback
from pathlib import Path

from s1.log_retention import RotatingLog, load_policy

_CHUNK_BYTES = 64 * 1024
_QUEUE_CHUNKS = 32
_SHUTDOWN_SECONDS = 1.0


def _flush_streams():
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(OSError, ValueError):
            stream.flush()


class _Capture:
    def __init__(self, path: Path):
        self.path = path
        self.pending: queue.Queue[bytes] = queue.Queue(maxsize=_QUEUE_CHUNKS)
        self.reader_done = threading.Event()
        self.read_deadline: float | None = None
        self.saved: list[int] = []
        self.read_fd = -1
        self.reader = threading.Thread(target=self._read, name="s1-log-reader", daemon=True)
        self.writer = threading.Thread(target=self._write, name="s1-log-writer", daemon=True)

    def open(self):
        _flush_streams()
        self.read_fd, write_fd = os.pipe()
        try:
            os.set_blocking(self.read_fd, False)
            for fd in (1, 2):
                self.saved.append(os.dup(fd))
            self.reader.start()
            for fd in (1, 2):
                os.dup2(write_fd, fd)
            self.writer.start()
        except BaseException:
            self.close()
            raise
        finally:
            os.close(write_fd)

    def _read(self):
        try:
            while self.read_deadline is None or time.monotonic() < self.read_deadline:
                readable, _, _ = select.select([self.read_fd], [], [], 0.05)
                if not readable:
                    if self.read_deadline is not None:
                        break
                    continue
                try:
                    data = os.read(self.read_fd, _CHUNK_BYTES)
                except BlockingIOError:
                    continue
                if not data:
                    break
                # A stalled disk or rotation lock must never backpressure model output.
                with contextlib.suppress(queue.Full):
                    self.pending.put_nowait(data)
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                os.close(self.read_fd)
            self.reader_done.set()

    def _write(self):
        try:
            log = RotatingLog(self.path, load_policy())
        except Exception:
            return
        while True:
            try:
                data = self.pending.get(timeout=0.05)
            except queue.Empty:
                if self.reader_done.is_set():
                    return
                continue
            # Never report storage failures through the very pipe we are draining.
            with contextlib.suppress(Exception):
                log.append(data)

    def close(self):
        _flush_streams()
        for fd, saved in zip((1, 2), self.saved, strict=False):
            with contextlib.suppress(OSError):
                os.dup2(saved, fd)
            os.close(saved)
        self.saved.clear()
        deadline = time.monotonic() + _SHUTDOWN_SECONDS
        self.read_deadline = deadline
        if self.reader.ident is None:
            if self.read_fd >= 0:
                os.close(self.read_fd)
            self.reader_done.set()
        else:
            self.reader.join(timeout=max(0, deadline - time.monotonic()))
        if self.writer.ident is not None:
            self.writer.join(timeout=max(0, deadline - time.monotonic()))
        # A blocked filesystem call cannot be cancelled safely; the daemon thread
        # ends with this process instead of holding daemon shutdown hostage.


@contextlib.contextmanager
def capture(path: Path):
    """Capture raw fd output without making logging a prerequisite for serving."""
    output = _Capture(path)
    try:
        output.open()
    except (OSError, RuntimeError):
        output = None
    try:
        yield
    except BaseException:
        if output is not None:
            with contextlib.suppress(OSError, ValueError):
                traceback.print_exc()
        raise
    finally:
        if output is not None:
            output.close()
