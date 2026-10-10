"""Report Ruff and ty failures to Codex after Python files change."""

import fcntl
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def fingerprint(root: Path) -> str:
    files = (
        subprocess.run(
            [
                "git",
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
                "--",
                "*.py",
                "*.pyi",
                "pyproject.toml",
                "uv.lock",
            ],
            cwd=root,
            capture_output=True,
            check=True,
            timeout=5,
        )
        .stdout.decode()
        .split("\0")
    )
    digest = hashlib.sha256()
    for name in sorted(set(files) - {""}):
        path = Path(name)
        if path.parts[0] in {".agents", ".claude", ".scratch", ".codex"}:
            continue
        digest.update(name.encode() + b"\0")
        file = root / path
        digest.update(b"file\0" + file.read_bytes() if file.is_file() else b"missing\0")
        digest.update(b"\0")
    return digest.hexdigest()


def run_checks(root: Path) -> list[str]:
    failures = []
    for args in [
        ("ruff", "check", ".", "--output-format", "concise"),
        ("ty", "check", "--output-format", "concise"),
    ]:
        try:
            result = subprocess.run(
                ["uv", "run", "--no-sync", *args],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            failures.append(f"{' '.join(args)}: {error}")
            continue
        if result.returncode:
            failures.append(
                f"{' '.join(args)} (exit {result.returncode}):\n{result.stdout}{result.stderr}"
            )
    return failures


def check(root: Path, event: dict) -> list[str]:
    session = hashlib.sha256(
        str(event.get("session_id", "default")).encode()
    ).hexdigest()
    cache = root / ".codex" / ".python-checks"
    cache.mkdir(parents=True, exist_ok=True)
    with (cache / session).open("a+") as state:
        # Parallel tool calls share one snapshot, so only one checks each revision.
        fcntl.flock(state, fcntl.LOCK_EX)
        current = fingerprint(root)
        state.seek(0)
        if state.read() == current:
            return []
        failures = (
            [] if event.get("hook_event_name") == "SessionStart" else run_checks(root)
        )
        state.seek(0)
        state.truncate()
        state.write(current)
        return failures


def main():
    event = {}
    try:
        value = json.load(sys.stdin)
        if not isinstance(value, dict):
            raise ValueError("hook input must be a JSON object")
        event = value
        failures = check(ROOT, event)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        failures = [f"Python quality hook failed: {error}"]
    if failures:
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": event.get("hook_event_name", "PostToolUse"),
                        "additionalContext": "Python checks failed; fix these before finishing:\n\n"
                        + "\n\n".join(failures),
                    },
                }
            )
        )


if __name__ == "__main__":
    main()
