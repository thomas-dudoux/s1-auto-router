"""Latency and RAM of the S1 runtime: the 6 default Routing Questions on a realistic Spawn state, independent and packed.

    uv run python -m s1.bench [2B|4B] [repeats]
"""
import json
from pathlib import Path
import resource
import statistics
import sys
import time

import yaml

T0 = time.perf_counter()
from s1.runtime import load  # noqa: E402  (the import is part of the cold load)

QUESTIONS = [{"id": qid, **question} for qid, question in yaml.safe_load(
    (Path(__file__).resolve().parents[1] / "hooks/default-config.yaml").read_text()
)["questions"].items()]

PROMPT = """Implement ticket 02 of the s1-auto-router spec. The repository is a Claude Code plugin that routes the Model and \
Effort of every Agent spawn using a local System One model. Read the ticket, the spec and the ADR, then build the Python \
runtime that loads the Decider checkpoint and returns per-option probabilities for choice, yes/no and score questions. \
Check first whether decider-ai loads the MLX DWQ checkpoint; if it does not, implement the plain mlx-lm path with the \
trained Context / Question / Options / Answer layout and a softmax over the option-letter logits at the per-type \
temperatures from decider_config.json. Measure cold load, per-request latency for the six default questions on a 4k \
character prompt, independent and packed, and the peak RAM. Record the numbers in the ticket under Answer. Write tests \
for the probability and prompt-layout code, keep the inference code importable, commit with Conventional Commits. """
STATE = {"description": "Implement ticket 02 decider spike", "subagent_type": "general-purpose",
         "agent_description": "General-purpose agent for multi-step tasks", "agent_tools": ["*"], "isolation": "worktree",
         "background": True, "prompt": (PROMPT * 8)[:4000]}


def timed(fn, repeats):
    ms = []
    for _ in range(repeats):
        t = time.perf_counter(); fn(); ms.append((time.perf_counter() - t) * 1000)
    return f"median {statistics.median(ms):.0f} ms, min {min(ms):.0f}, max {max(ms):.0f} (n={repeats})"


def main(model="2B", repeats=10):
    import mlx.core as mx

    s1 = load(model)
    first = s1.answer(STATE, QUESTIONS)
    cold = time.perf_counter() - T0
    print(f"model {s1.name}, state prompt {len(STATE['prompt'])} chars, cold load + first request {cold:.1f} s")
    print("independent:", timed(lambda: s1.answer(STATE, QUESTIONS), repeats))
    print("packed:     ", timed(lambda: s1.answer(STATE, QUESTIONS, packed=True), repeats))
    one_by_one = {k: v for q in QUESTIONS for k, v in s1.answer(STATE, [q]).items()}
    drift = max(abs(p - one_by_one[q]["probs"][o]) for q, a in first.items() for o, p in a["probs"].items())
    print(f"max |p(batched) - p(one question alone)| = {drift:.4f}  (right-padding check)")
    print("answers (independent):", json.dumps({q: {o: round(p, 3) for o, p in a["probs"].items()} for q, a in first.items()}))
    packed = s1.answer(STATE, QUESTIONS, packed=True)
    print("answers (packed):     ", json.dumps({q: {o: round(p, 3) for o, p in a["probs"].items()} for q, a in packed.items()}))
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**30  # bytes on macOS
    print(f"peak RSS {rss:.2f} GB, peak MLX memory {mx.get_peak_memory() / 2**30:.2f} GB")


if __name__ == "__main__":
    main(*(sys.argv[1:2] or ["2B"]), *[int(a) for a in sys.argv[2:3]])
