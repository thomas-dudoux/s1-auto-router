# Paired native Agent pilot protocol

Status: predeclared future work; not executed. Calibration must finish and the candidate must be frozen before outcomes are collected. Six pairs are limited evidence, not a general accuracy guarantee.

## Conditions and arms

Use the actual pre-feature plugin at `3c64fef` as baseline, including its ordinary Agent description and state, and the frozen candidate plugin/config as candidate. Baseline rules under the new metadata-generating description are not an equivalent baseline. Use identical Parent Model/Effort, agent definitions, tool permissions, Ceiling, original task prompts, daemon hardware/model and freshly copied starting artifacts in both arms. Alternate baseline/candidate order. Record commits, tree/config hashes, hardware, loaded S1 model and runtime versions before runs.

The original Parent input asks it to delegate the task through native Agent and then verify the returned work. Do not supply metadata or explicit child Model/Effort hints. The candidate Parent must generate its own tags from the advertised Agent description. Inspect original Agent input in the transcript for presence, format and truthful unresolved-decision descriptions; extracted state alone cannot establish compliance. Keep prompts/transcripts in private pilot artifacts, not additional production logging.

Before execution, create the six tiny starting artifacts and version their exact fixtures and independent completion checks. Record their hashes and checks before either arm starts. These task definitions are distinct from calibration wording examples; disclose shared task categories and any concrete overlap. No unused general runner is needed.

| Task | Starting artifact and assignment | Predeclared success check |
| --- | --- | --- |
| Bounded implementation | One pure helper module; add `clamp(value, min, max)` using the prescribed min/max algorithm, rejecting nonfinite inputs and reversed bounds. | Independent assertions cover below/within/above bounds, equal bounds, negative/fractional inputs and invalid arguments. No unrelated diff. |
| Open implementation/investigation | A mini cache/store/reader system where replacing the backing object leaves a reader closure with stale values. Ask the child to diagnose and repair why a write is not reflected in reads, without prescribing the mechanism or approach. | Identify the seeded stale-reference cause and affected call path; provide a reproducer that fails against the original and passes after the repair. Independent repeated-write/read behavior checks pass. No invented defects. |
| Costly prescribed change | An authorization module with a fixed role/resource/tenant matrix and a seeded permissive unknown-role fallback. Repair it using the supplied deny-by-default rule. | Full independent allow/deny truth table passes, including unknown role, missing permission and tenant mismatch. No newly permitted combinations. |
| Scouting | A mini repository with direct and aliased callers plus default/file/environment configuration precedence. Find callers and explain precedence. | Report the exact seeded caller set, source locations and precedence order; no edits or unsupported callers. |
| Review | A small diff introducing a boundary off-by-one and a swallowed persistence failure. Review behavior with concrete failure scenarios. | Find both seeded defects with accurate reproducing conditions and locations; do not count unsupported findings as success. |
| Synthesis | Two notes with complementary facts and one explicit unresolved conflict. Merge them with source references. | Include all predeclared facts, retain the unresolved disagreement and correctly attribute each fact; do not invent a resolution. |

Both bounded and open tasks require implementation, with settled versus unresolved approaches. Let the Parent choose metadata without manually supplying role or Solution Space hints; audit whether it generates comparable Work Roles and disclose if the same-role comparison was not achieved. Work Role does not restrict Model eligibility. Child task completion, rather than a preferred routing label or a plausible response, determines success.

## Execution and evidence

On an authenticated deployment machine, inspect local `claude --help` and use its supported print/plugin, Parent model/effort, transcript, hook-event, budget and permission options. Do not disable hooks with bare/safe mode. Verify the plugin actually loaded, the native Agent hook ran and expected tools/agent definitions were available. Denied tools, absent routing or invalid initial conditions are failed/ineligible runs with an explicit reason, not cheap successes.

For every arm/case retain the starting/check identities, transcript, diff/artifacts, declared completion result, original Parent Agent input and compliance review. Record actual effective child Model/Effort with transcript/settings provenance; raw Routing proposals do not establish effective settings because Explicit values, Ceiling and Abstain may affect them. Report unavailable effective Effort as unmeasured.

Capture all Routing records, loaded S1 identity, request durations, budget timeouts, fail-open/Abstain reasons and hook/overall wall durations. Request latency alone cannot establish the complete Routing budget; the native hook's bounded race and append duration need correct attribution.

Record Parent and every child's token usage/cost, including failed runs, plus CLI totals. Verify whether the CLI total/model-usage values already include children before aggregation; avoid double counting. Distinguish billed costs from list-price estimates, name rates used for estimates, and count Parent metadata overhead. S1 request timing is separate from monetary spend. Missing cost or effective-setting evidence makes the gate inconclusive.

## Promotion decision

Promote only if observed candidate task success is maintained versus baseline, aggregate Parent-plus-all-child cost is lower, and existing Routing budget is respected. Report failures, limitations and all six paired results, including unsuccessful runs. If evidence is missing, gate fails, or calibration was not frozen first, keep defaults unchanged and report negative/inconclusive findings. Run relevant plugin checks, Ruff and ty at the end of implementation independently of this gate.
