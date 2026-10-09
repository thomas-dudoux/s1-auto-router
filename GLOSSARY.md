# s1-auto-router

Automatically picks the Model and Effort of a spawned agent with a small local decision model, so the caller does not have to.

## Language

**Spawn**:
One call to the `Agent` tool that starts a subagent.
_Avoid_: launch, invocation

**Model**:
Which Claude model a spawned agent runs on (haiku, sonnet, opus, fable).
_Avoid_: tier

**Effort**:
How much reasoning a spawned agent applies (low, medium, high, xhigh, max).
_Avoid_: level, reasoning budget

**Routing**:
Choosing the Model and/or Effort of a Spawn that did not already have them.
_Avoid_: auto-config, dispatch

**Explicit value**:
A Model or Effort already fixed for a Spawn, either by the caller's `Agent` call or by the agent definition's frontmatter. Routing never replaces an Explicit value.
_Avoid_: override, user value

**S1**:
The local "System One" decision model (Decider) that answers the Routing Questions. Fast, cheap, calibrated; never generates text.
_Avoid_: classifier, small model, router model

**Routing Question**:
One typed question put to S1 about a Spawn, with a fixed answer type: choice, yes/no, or score.
_Avoid_: prompt, feature

**Decision Tree**:
The deterministic rules that turn S1's answers to the Routing Questions into a Model or an Effort. There is one tree per output.
_Avoid_: policy, scorer

**Parent**:
The session or agent that makes the Spawn; its own Model and Effort are the reference for the Ceiling.
_Avoid_: caller session, main agent

**Ceiling**:
The highest Model and Effort Routing may pick for a Spawn; by default the Parent's own. Can be lifted by configuration.
_Avoid_: cap, limit

**Abstain**:
Routing leaves one output unset because S1's answers it depends on are below the confidence threshold.
_Avoid_: skip, fallback

**Routing Config**:
The user-editable definition of the Routing Questions, both Decision Trees, the Ceiling and the confidence threshold.
_Avoid_: rules file, policy
