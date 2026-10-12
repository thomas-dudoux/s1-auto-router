# Routing with Work Role and Solution Space

The agreed interview decisions have been synthesized into a [ready-for-agent spec](../../.scratch/solution-space-routing/spec.md) in the local issue tracker. Definitions live in [GLOSSARY.md](../../GLOSSARY.md).

## Agreed direction

- Work Roles inform Routing; they do not impose model eligibility restrictions or fix a Model/Effort pair.
- Assess improvement by successful task completion and cost, rather than agreement with the existing expected labels alone.
- Consider Solution Space separately from workload and mistake cost.
- The Parent authors Solution Space for each Spawn, using context it has beyond the subagent's task description.
- Solution Space informs both Model and Effort.
- If the Parent omits Solution Space, Routing infers from the ordinary task as a compatibility fallback.
- Keep separate Model and Effort Decision Trees, with Solution Space available to both.
- Keep the native Agent tool. The Parent structures its prompt using a `<metadata>` section for routing information and a `<prompt>` section for the assignment, with Solution Space inside `<solution-space>`.
- The Parent also authors the Work Role per Spawn, using `<work-role>` inside metadata. Routing infers either missing field from the task.
- Work Role is short text, with suggested names such as `scout`, `implementer`, `architect`, `reviewer` and `synthesizer`; it is not a closed enumeration.
- The Parent's Solution Space is the primary description of unresolved decisions. S1 also considers the complete assignment for scope, mistake cost and verification needs.
- Read one leading metadata block and recognise supported fields. Infer missing or invalid fields from the assignment; malformed metadata never blocks a Spawn. Preserve the original Agent prompt for the subagent.
- Fully specified, low-risk implementation can qualify for Haiku, including new features, when little understanding of cross-component interactions is needed. Solution Space distinguishes bounded implementation from open design work.
- Compare the current router and the proposed router on a small paired suite where the Parent generates metadata and subagents complete real assignments. Measure metadata compliance, task success, total cost including Parent overhead, and routing latency.
- Keep the proposed routing experimental until the pilot shows maintained task success and lower cost within the existing Routing budget. A small pilot is initial evidence, not a general accuracy guarantee.

Existing Explicit values, the Ceiling, independent Abstain behavior and fail-open guarantees continue to apply. This change introduces no model eligibility allowlist, separate delegation tool or joint Model/Effort selector.

## Current limitation

The default Model tree already permits Haiku for mechanical edits. Its `design` answer groups new-feature implementation with architecture and permits only Sonnet or Opus. A fully specified small feature can therefore be excluded from Haiku by work kind alone.

## Comparison with OMP

OMP's [task interface](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md) uses a caller-authored `solutionSpace` description for automatic Effort classification. A nonblank description replaces the task text as the classifier input; absent descriptions fall back to the task. It does not select the Model.

OMP's [model roles](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md) are aliases to configured model selectors, rather than per-model work eligibility lists.

## Chosen prompt structure

```xml
<metadata>
  <work-role>implementer</work-role>
  <solution-space>
    Follow the existing pagination pattern.
    Only empty-page behavior remains undecided.
  </solution-space>
</metadata>

<prompt>
  Implement pagination and test the empty-page case.
</prompt>
```

## Integration facts

The [documented mods SDK](https://code.claude.com/docs/en/plugins/mods/reference) permits changing the Agent tool description with `tool.describe`, but does not expose native tool input-schema extension. The chosen transport is structured sections in the existing Agent prompt. The current Routing state includes the first 4,000 prompt characters by default, so placement or extraction matters. Parent compliance and hint accuracy have not been tested.

A separate tool with a custom input schema can be [registered](https://code.claude.com/docs/en/plugins/mods/api#add-a-tool) and forward to native Agent. This is not native schema extension. The [official declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts) document background execution and a different result record for plugin-raised Agent calls; a wrapper would need compatibility testing before replacing ordinary delegation.

The decision to keep native Agent is recorded in [ADR-0002](../adr/0002-native-agent-routing-metadata.md).

## Implementation and validation scope

- Guide the Parent through the Agent tool description to produce the chosen structure.
- Extract supported metadata into Routing state while keeping the original Agent prompt intact and preserving compatibility with untagged calls.
- Update the Routing Questions and separate Decision Trees so both outputs use Solution Space. Keep shipped YAML and TypeScript defaults consistent; evaluate candidate rules before promoting them.
- Check normal, missing, malformed and conflicting descriptions, plus existing routing guarantees. The existing label fixtures remain a comparison reference; task outcomes and cost determine whether the proposed routing improves on the baseline.
- Exercise actual Parent-generated metadata in the paired pilot; hand-authored hints alone cannot establish Parent compliance or hint accuracy.

No routing changes or outcome experiments have been made for this design.
