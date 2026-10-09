# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

`s1-auto-router` is a Claude Code plugin (mod) that routes the Model and Effort of every `Agent` spawn using a local System One model (Decider 2B/4B, MLX). It has two parts: a TypeScript mod handling `agent.spawn`, and a Python S1 daemon on a unix socket. Design and decisions are settled; no source code exists yet.

- Spec: `.scratch/*/spec.md`. Tickets: `.scratch/*/issues/`, numbered in dependency order.
- Terms: `GLOSSARY.md` (Spawn, Routing, Explicit value, Ceiling, Abstain, Routing Config…). Use them.
- Architecture: `docs/adr/*.md`.

## Python environment

Managed by uv: Python 3.13 in `.venv/`, deps `decider-ai[metal]` and `mlx-lm` in `pyproject.toml`.

- `uv sync`: install the dependencies.
- `uv run hf download midium-ai/decider-2b-dwq-4bit`: download the model (~1.06 GB, into `~/.cache/huggingface`).
- The `decider-ai` package is imported as `decider`.

There are no build, lint or test commands yet. Add them here as the tickets land.

## Conventions

- Commit messages follow the Conventional Commits spec. The `conventional-commit` skill is installed for this: it lives in `.agents/skills/conventional-commit/`, `.claude/skills/conventional-commit` symlinks to it.

## Agent skills

`skills-lock.json` pins all installed skills.

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
