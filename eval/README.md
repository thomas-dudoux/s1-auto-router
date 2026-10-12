# Real-model Routing eval

Run from the repo with Node 24+ and an already prepared S1 daemon:

```sh
node eval/run.mjs --check
node eval/run.mjs [socket] [config.yaml|json]
node eval/run.mjs [socket] [config.yaml|json] [cases.json] [report.json]
```

The socket defaults to `~/.cache/s1-auto-router/s1.sock`. `/s1-setup` prepares and starts S1; the eval never installs dependencies, downloads weights, or starts another model. An optional config is read through the real Routing Config parser. Constant trees with no questions run without a daemon. The script imports the actual default config, state builder, versioned request/response client, and Decision Tree walker. There is no Parent Ceiling in this measurement.

Every case prints its expected and actual Model/Effort, disagreements, Abstains, and request latency. A request over the five-second Routing budget is counted as fail-open. Latency p50/p95 use nearest ranks after one warmup. Cached answers replay confidence and Effort score thresholds without further inference. Raw answers, config, and measurements are saved privately to `.scratch/s1-eval-results.json`; this file is overwritten on each run.

An optional corpus can contain unlabeled cases without `expected`; their confident outputs count as `unlabeled`, never correct/wrong. Named private reports persist config/corpus/code identities, hardware and loaded model. Connection/infrastructure failures produce a report with the error and unavailable measurements rather than fabricated classification counts. With an explicit corpus, only its cases run; the default invocation retains the separate long-state probes. See the [Solution Space calibration report](solution-space-calibration.md) and [predeclared paired pilot](solution-space-pilot.md).

`fixtures.json` preserves all 24 user-approved labels unchanged. It covers every M1 kind and E1 level. `long-state.json` is the existing `s1.bench.STATE`, exported without loading a model. Its repeated implementation prompt measures 2000/4000-character latency with one warmup and five samples each. It is an unlabeled benchmark, separate from the accuracy fixtures.

## Experimental Solution Space rules

For an opt-in Claude Code session, select the candidate through the existing config setting:

```sh
S1_ROUTER_CONFIG="$PWD/hooks/solution-space-candidate.json" claude --plugin-dir .
```

Unset `S1_ROUTER_CONFIG` to return to ordinary config selection. The candidate uses Parent `solution_space` as the primary account of unresolved approach decisions and retains the assignment for interactions, mistake cost, workload and verification. `work_role` describes work without restricting model eligibility. Bounded low-risk implementation can select Haiku; open, costly or interaction-heavy implementation retains stronger options. Model and Effort have separate trees and confidence paths.

The candidate is experimental; shipped defaults remain unchanged. E1 is a choice question so Model can branch on openness; Effort still uses its probability-weighted answer and separately adds workload, verification and mistake cost. This question-type and wording change needs real S1 calibration. Controlled native Agent tests establish rule behavior, not classification accuracy, subagent success or cost savings. Use the existing eval with the candidate config for calibration, preserve the approved labels as historical references, and complete the paired Parent/subagent pilot before promoting defaults.

`solution-space-candidate.ts` is the configuration data used by the native Agent tests; its selectable JSON copy is checked by `node eval/run.mjs --check`. After changing candidate data, regenerate that copy with Node 24+:

```sh
node --input-type=module -e 'import { writeFileSync } from "node:fs"; import { SOLUTION_SPACE_CONFIG } from "./hooks/solution-space-candidate.ts"; writeFileSync("hooks/solution-space-candidate.json", JSON.stringify(SOLUTION_SPACE_CONFIG, null, 2) + "\n")'
node eval/run.mjs --check
```

## Measured tuning, 2026-10-09

Apple M4, 16 GB, cached `decider-2b-v11` via the real daemon's unix socket; Hub offline mode; Node 26.11.0. One isolated daemon served all requests and was stopped afterward. No 4B download or environment installation was performed.

| Config | Model correct / wrong / Abstain | Effort correct / wrong / Abstain | Case p50 / p95, ms |
| --- | --- | --- | --- |
| Original defaults | 13 / 1 / 10 | 4 / 5 / 15 | 1037 / 1053 |
| E3 verification clarification | 13 / 1 / 10 | 8 / 4 / 12 | 1040 / 1101 |
| E3 plus M2 interactions clarification | 16 / 0 / 8 | 8 / 4 / 12 | 1128 / 1181 |
| Final: also clarify E1 approach discovery | 16 / 0 / 8 | 8 / 2 / 14 | 1264 / 1416 |

All four configurations had zero five-second fail-opens. Only question wording changed:

- M2 asks about interactions across multiple files/components/systems. The vague “many files” wording understated cross-component tasks.
- E3 distinguishes explicit verification from a simple lookup, typo fix, or short summary. The original “verified or exact” wording raised Effort on routine lookups.
- E1 asks how much of the approach the agent must discover or decide, even when the desired result is clear. It reduces confident Effort errors, trading two formerly wrong decisions for two Abstains at equal correct count.

Keep confidence **0.6**, Effort thresholds **0 / 1 / 2.5**, and `prompt_max_chars` **4000**. Final-answer confidence replay:

| Confidence | Model correct / wrong / Abstain | Effort correct / wrong / Abstain |
| --- | --- | --- |
| 0.4 | 18 / 5 / 1 | 15 / 4 / 5 |
| 0.5 | 18 / 5 / 1 | 11 / 4 / 9 |
| 0.6 | 16 / 0 / 8 | 8 / 2 / 14 |
| 0.7 | 6 / 0 / 18 | 5 / 1 / 18 |
| 0.8 | 2 / 0 / 22 | 4 / 0 / 20 |

Lowering confidence admits five Model errors. Raising it discards many correct decisions. Replaying the Effort high cutoff at 2, 2.5, and 3 changes no applied decisions at confidence 0.6: uncertainty, rather than that cutoff, controls these cases. There is no measured reason to change the thresholds.

| Long prompt | Original p50 / p95, ms | Final p50 / p95, ms | Final result |
| --- | --- | --- | --- |
| 2000 chars | 1540 / 1554 | 2049 / 2203 | opus / Effort Abstain |
| 4000 chars | 2120 / 2140 | 2870 / 3061 | opus / Effort Abstain |

4000 remains within the budget. The labeled prompts are only 83–245 characters, so their accuracy cannot establish that dropping longer context is safe. Earlier wording candidates changed their Effort outcome between 2000 and 4000 characters; latency alone is insufficient evidence to reduce the limit. This repeated long prompt is a timing probe, not evidence of real long-task accuracy. Machine load and run order affect latency; these numbers do not establish a causal timing regression from wording.

The final two wrong Effort decisions are `permission-fix` and `changelog`, both low versus expected medium. Eight Model outputs and fourteen Effort outputs still Abstain, including many high Effort labels. This small set has no holdout: it supports a conservative wording improvement, not a general accuracy guarantee or perfect default routing.

To reproduce the original configuration and compare on the same daemon:

```sh
git show 0dcfc05:hooks/default-config.yaml > /tmp/s1-eval-baseline.yaml
node eval/run.mjs [socket] /tmp/s1-eval-baseline.yaml
node eval/run.mjs [socket]
```

For an isolated offline developer run, use the existing Python environment and cached model with an explicit temporary socket passed to `serve`; preserve host environment paths. Never call `s1.bench.main` or `s1.runtime.load` in the eval client while the daemon already holds the model. `s1/bench.py` M2/E1/E3 wording is synchronized with the tuned defaults.
