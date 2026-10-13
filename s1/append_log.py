"""Append one complete decision record using the current private logging policy."""

import sys
from pathlib import Path

from s1.log_retention import RotatingLog, load_policy


def _read_record(max_bytes: int) -> bytes:
    chunks = []
    remaining = max_bytes + 1
    while remaining:
        chunk = sys.stdin.buffer.read(min(64 * 1024, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def main() -> int:
    try:
        policy = load_policy()
        data = _read_record(policy.max_bytes)
        RotatingLog(Path(sys.argv[1]), policy).append(data, record=True)
    except (OSError, ValueError) as exc:
        print(f"s1-auto-router: decision log append failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
