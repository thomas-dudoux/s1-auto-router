# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Project status

`s1-auto-router` is a Claude Code plugin (mod) that routes the Model and Effort of every `Agent` spawn using a local System One model (Decider 2B/4B, MLX). It has two parts: a TypeScript mod (a `tool.call` hook on `Agent`, in `hooks/`), and a Python S1 daemon on a unix socket (`s1/`).

Mod layout: `hooks/register.ts` holds the hooks and every function that touches `$` (the validator never follows `$` across an import). The other modules are pure: `s1-client.ts` (v1 request, response validation, 5 s budget), `state.ts`, `agent-definition.ts` (Explicit values from frontmatter), `tree.ts` (Routing Config types, Decision Tree evaluator), `default-config.ts` (bundled Routing Config), `vendor/js-yaml.mjs`.

- Spec: `.scratch/*/spec.md`. Tickets: `.scratch/*/issues/`, numbered in dependency order.
- Terms: `GLOSSARY.md` (Spawn, Routing, Explicit value, Ceiling, Abstain, Routing Config…). Use them.
- Architecture: `docs/adr/*.md`.

## Development agent and worktrees

Use omp for development. `.omp/` contains the native MCP configuration and skill links into `.agents/skills/`. `AGENTS.md` is the shared context file.

The product remains a Claude Code plugin: `.claude-plugin/`, the `claude plugin` validation commands, and `.claude/` paths used by the router are product interfaces, not development-agent configuration.

`orca.yaml` prepares each worktree's own Python environment before starting its agent. In Orca's repository settings, set **When to run → Run by default** and **Command Source → orca.yaml only**; approve the hook trust prompt when shown. Keep `.venv` out of Worktree Shared Paths.

The omp configuration is versioned; `.worktreeinclude` copies ignored `.scratch/` state and the local `orca.yaml` from the primary checkout. New worktrees need a start-from revision containing the omp configuration and a primary checkout containing `orca.yaml`.

Headroom's proxy is managed separately from omp. Configure `providers.openai.baseUrl` and `providers.openai-codex.baseUrl` in the active omp user/profile `models.yml` as `http://127.0.0.1:8787/v1`. This affects other projects using that user/profile; `.omp/mcp.json` exposes Headroom tools but does not route inference.

To start the existing local deployment, run `uvx --python 3.13 --from 'headroom-ai[mcp,proxy]==0.40.0' headroom install start --profile init-s1-auto-router-fb154248`. omp does not start or restart the proxy; the configured providers require it to be running.

## Python environment

Managed by uv: Python 3.13 in `.venv/`, deps `decider-ai[metal]` and `mlx-lm` in `pyproject.toml`.

- `uv sync --locked --group dev`: install the runtime and development dependencies, including Serena's local `ty` executable.
- `uv run hf download midium-ai/decider-2b-dwq-4bit`: download the model (~1.06 GB, into `~/.cache/huggingface`).
- The `decider-ai` package is imported as `decider`. It cannot load the MLX DWQ checkpoint, so `s1/runtime.py` runs the forward pass on `mlx-lm` and reuses decider's torch-free prompt helpers (`decider.prompt`, `decider.systemone`). Never import `decider.infer`, because it loads torch.

Commands:

- `uv run pytest`: run the Python tests (no model needed).
- `S1_MODEL=2B|4B uv run python -m s1.daemon`: run the S1 daemon in the foreground (HTTP/1.1 `POST /v1/answer` on the unix socket `~/.cache/s1-auto-router/s1.sock`, default model 2B).
- `uv run python -m s1.client [socket]`: send a sample v1 request to the running daemon and print the answers (manual check).
- `uv run python -m s1.bench [2B|4B] [repeats]`: measure S1 latency and RAM on the real model (6 default questions, 4k-char state).

## Plugin commands

The repo root is the plugin (`.claude-plugin/plugin.json`, `hooks/hooks.json`).

- `claude plugin validate .`: check the manifest and hooks module.
- `claude plugin test .`: run the mod's `*.test.ts` tests (no real I/O: answer `fs`, `http.fetch`, `process.run` events in the test). `tests/router.test.ts` has a `world()` helper: fake S1 at `http.fetch`, fake files at `fs.read`, env, mock clock.
- `claude -p --plugin-dir . "..." < /dev/null`: load the mod headless. Debug logs (`--debug-file`) contain settings secrets: never keep or commit them.

## Conventions

- Commit messages follow the Conventional Commits spec. The `conventional-commit` skill is installed for this: it lives in `.agents/skills/conventional-commit/`, `.omp/skills/conventional-commit` symlinks to it.

## Agent skills

`skills-lock.json` pins all installed skills.

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
