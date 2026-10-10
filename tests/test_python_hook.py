import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.check_python import check


@pytest.fixture
def project(tmp_path):
    subprocess.run(["git", "init", "--quiet", str(tmp_path)], check=True)
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'test'\n")
    (tmp_path / "example.py").write_text("value = 1\n")
    subprocess.run(["git", "add", "example.py"], cwd=tmp_path, check=True)
    return tmp_path


@pytest.mark.parametrize(
    "tool", ["apply_patch", "Bash", "mcp__serena__replace_symbol_body"]
)
def test_checks_edits_from_any_tool_but_skips_reads(project, monkeypatch, tool):
    calls = []

    def run_checks(root):
        calls.append(root)
        return ["lint failure", "type failure"]

    monkeypatch.setattr("scripts.check_python.run_checks", run_checks)
    assert check(project, {"hook_event_name": "SessionStart"}) == []
    assert check(project, {"tool_name": "Read"}) == []
    (project / "example.py").write_text("value = 2\n")
    assert check(project, {"tool_name": tool}) == ["lint failure", "type failure"]
    assert check(project, {"tool_name": "Read"}) == []
    assert calls == [project]


@pytest.mark.parametrize("change", ["create", "delete", "config", "lock"])
def test_detects_new_deleted_and_configuration_files(project, monkeypatch, change):
    monkeypatch.setattr("scripts.check_python.run_checks", lambda root: ["checked"])
    check(project, {"hook_event_name": "SessionStart"})
    if change == "create":
        (project / "new.py").write_text("value = 3\n")
    elif change == "delete":
        (project / "example.py").unlink()
    elif change == "config":
        (project / "pyproject.toml").write_text("[tool.ruff]\nline-length = 100\n")
    else:
        (project / "uv.lock").write_text("version = 1\n")
    assert check(project, {}) == ["checked"]


def test_cli_reports_both_checks_as_codex_context(project, tmp_path):
    tools = tmp_path / "bin"
    tools.mkdir()
    uv = tools / "uv"
    uv.write_text(
        f"#!{sys.executable}\n"
        "import sys\n"
        "print('lint failure' if 'ruff' in sys.argv else 'type failure')\n"
        "sys.exit(1)\n"
    )
    uv.chmod(0o755)
    scripts = project / "scripts"
    scripts.mkdir()
    script = scripts / "check_python.py"
    script.write_text(
        (Path(__file__).parents[1] / "scripts/check_python.py").read_text()
    )
    result = subprocess.run(
        [sys.executable, str(script)],
        input=json.dumps(
            {"hook_event_name": "PostToolUse", "tool_name": "apply_patch"}
        ),
        capture_output=True,
        text=True,
        check=True,
        cwd=tools,
        env={**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}"},
    )
    output = json.loads(result.stdout)["hookSpecificOutput"]
    assert output["hookEventName"] == "PostToolUse"
    assert "lint failure" in output["additionalContext"]
    assert "type failure" in output["additionalContext"]


def test_skill_and_non_python_edits_do_not_trigger_checks(project, monkeypatch):
    monkeypatch.setattr("scripts.check_python.run_checks", lambda root: ["unexpected"])
    check(project, {"hook_event_name": "SessionStart"})
    (project / "README.md").write_text("Updated docs\n")
    skills = project / ".agents"
    skills.mkdir()
    (skills / "external.py").write_text("external = 1\n")
    assert check(project, {}) == []
