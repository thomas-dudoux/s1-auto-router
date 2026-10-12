# Solution Space calibration, 2026-10-12

Status: infrastructure-blocked. Candidate rules remain experimental and are not frozen or promoted. The deployment socket is absent and the existing MLX environment cannot access a Metal device. No S1 answers, classification quality, latency percentiles, task outcomes or monetary savings were measured.

## Reproduce on deployment hardware

Use the existing prepared daemon; this client does not install, download or start models. Run from the repo with Node 24+:

```sh
node eval/run.mjs --check
node eval/run.mjs "$HOME/.cache/s1-auto-router/s1.sock" hooks/solution-space-candidate.json eval/solution-space-observations.json .scratch/solution-space-routing/calibration-candidate.json
node eval/run.mjs "$HOME/.cache/s1-auto-router/s1.sock" hooks/solution-space-candidate.json eval/fixtures.json .scratch/solution-space-routing/historical-candidate.json
node eval/run.mjs "$HOME/.cache/s1-auto-router/s1.sock" hooks/default-config.yaml eval/fixtures.json .scratch/solution-space-routing/historical-default.json
node eval/run.mjs "$HOME/.cache/s1-auto-router/s1.sock" hooks/solution-space-candidate.json
```

The first corpus has eight manually authored, unlabeled observations: bounded implementation, open implementation, costly prescribed work, cross-component work, substantial verification, a long assignment, malformed metadata and untagged fallback. It tests classification behavior; it does not test whether a real Parent produces useful metadata. Do not invent expected Model/Effort labels or call these observations accuracy measurements. The 24 approved historical labels are unchanged. Historical disagreements are supplementary evidence, not the candidate promotion gate.

The last command, without an explicit corpus, also collects the original 2000/4000-character timing probes and writes the default `.scratch/s1-eval-results.json`; preserve it under a named copy immediately.

Results include the production state, typed answers, confidence, raw tree-derived outputs or Abstains, request latency, configuration and fingerprints. There is no Parent Ceiling here: applied native Agent outputs require the later pilot. Request duration is not total hook duration, and local S1 time is not billed model cost. The default historical command without an explicit corpus retains the existing 2000/4000-character timing probes; the separate observations include a long assignment through production state construction instead. Explicit report names avoid overwriting another arm's evidence.

Compare observations across runs, inspect whether unresolved decisions, interactions, risk and verification are classified plausibly, and tune wording only when real evidence supports it. Freeze the candidate identity only after calibration; keep wording-tuning cases separate from the [paired outcome pilot](solution-space-pilot.md), with disclosed overlap. Passing offline self-checks cannot replace calibration.

## Attempt and conditions

On 2026-10-12 at 16:17 UTC, the candidate observations command failed during warmup with `connect ENOENT /Users/thomas.dudoux/.cache/s1-auto-router/s1.sock`. Its private report is `.scratch/solution-space-routing/calibration-blocked.json`. It records `infrastructure-blocked`, empty answers/records and null loaded model, summary and latency. This is infrastructure evidence, not a classification failure or measured native Agent fail-open count.

The prepared baseline plugin is commit `3c64fef`. Candidate production code is `a8139a530ed84db980c46f85340e58254e62609b`, tree `f1a390ed40ad489d1aa47c21308389ec1b8a819b`. The attempted client was a working-tree preparation of the eval tool; the private report records tracked changes and the runner fingerprint. Canonical parsed candidate config SHA256 is `1470c0fc47a9362bb7bb027081902fe7e51c38fecbcefe31dcd37ba9a09b01d6`; canonical observation corpus SHA256 is `a9549ed6045fc35d653d227c1f33f5cc0a0a2724ba97d1a53fabb4ad6e059330`. Approved fixture file SHA256 remains `6ed0f28b05bb301f0eb88669ea0380087eca3f4980736bb0f2c87abd315b3baa`.

Actual eval runtime: Node `v26.11.1`, Darwin `25.6.0`, arm64, Apple M4, 17,179,869,184 bytes memory (16 GiB), from Node OS data; system profiler independently reports Apple M4, 16 GB, Mac16,12. Hardware presence does not imply MLX device access in this session.

The primary workspace's existing `.venv/bin/python` probe importing `mlx.core` failed with `ImportError: [metal::load_device] No Metal device available`. No model was loaded. The existing cache contains `midium-ai/decider-2b-dwq-4bit`, revision `e4a8b7aa25d4306a8213a16ffe138d38ad38f325`, Decider version `2b-v11`, `isolated_levels=true`, choice temperature 1.164 and score temperature 1.124. These are cached conditions, not evidence that inference ran. E1's candidate change from score to choice requires real calibration under those different temperatures.

A Claude Code `2.1.296` headless probe returned `Not logged in · Please run /login`, zero tokens, zero API duration and $0; no Agent Spawn was attempted. Authentication and Metal access must be available in the execution environment before completing tickets 03/04. No credentials, installation or approval escalation was attempted.

## Evidence still required

- Real daemon answers and loaded model identity for each historical/calibration run, including Abstain and budget counts and warm request p50/p95.
- Classification/truncation review and any justified wording updates, followed by an immutable candidate identity.
- The real paired Parent/native Agent task-outcome and cost pilot. No completion or cost claims can be inferred from this preparation.
