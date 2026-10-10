"""S1 runtime: Decider probabilities for typed questions about a state, on plain mlx-lm.

decider-ai cannot load the MLX DWQ checkpoint (its torch/transformers loader rejects the MLX quantization config), so the
forward pass runs on mlx-lm. The prompt layout and the answer bookkeeping are decider-ai's own pure-Python code
(decider.prompt, decider.systemone), so prompts match what the model was trained on.
"""
import math
from types import (
    SimpleNamespace as NS,  # stands in for decider.infer.Example/Q: importing decider.infer loads torch
)

from decider.prompt import LETTERS, build
from decider.systemone import (
    combine_isolated,
    plan_rows,
    render_question,
    render_state,
    row_types,
)

MODELS = {"2B": "midium-ai/decider-2b-dwq-4bit", "4B": "midium-ai/decider-4b-dwq-4bit"}


class _Keep:  # keep option order as given (decider's build shuffles by default)
    def shuffle(self, x): pass
    def sample(self, xs, k): return xs[:k]


def _decider_spec(q):
    """A Routing Question {id, type, text, options} -> decider.systemone question spec."""
    if q["type"] == "yesno":
        return {"type": "noul", "instructions": q["text"]}
    if q["type"] == "choice":
        return {"type": "choice", "instructions": q["text"], "criteria": {o["id"]: o["description"] for o in q["options"]}}
    if q["type"] == "score":
        return {"type": "score", "instructions": q["text"], "criteria": [o["description"] for o in q["options"]]}
    raise ValueError(f"unknown question type {q['type']!r}")


class S1:
    """tok: has encode(text, add_special_tokens=False). score(items) -> per item, one list of option-letter logits per slot."""

    def __init__(self, tok, score, config, name):
        self.tok, self.score, self.name = tok, score, name
        self.T, self.T_by_type = config.get("temperature", 1.0), config.get("temperature_by_type", {})
        self.isolated_levels = bool(config.get("isolated_levels", False))

    def answer(self, state, questions, packed=False):
        """-> {question id: {"probs": {option id: p}, "confidence": top p}}; yes/no answers have options "yes" and "no"."""
        by_id = {q["id"]: q for q in questions}
        rqs = {qid: render_question(_decider_spec(q)) for qid, q in by_id.items()}
        for r in rqs.values():
            # shortcut: only the narrow "(A)".."(J)" rendering, upgrade to decider's wide label table if a question needs >10 options
            if len(r["options"]) > len(LETTERS):
                raise ValueError(f"at most {len(LETTERS)} options per question")
        flat, index = plan_rows(rqs, self.isolated_levels and not packed)
        ctx = render_state(state)
        rows = [flat] if packed else [[r] for r in flat]
        items = [build(NS(context=ctx, qs=[NS(text=r["question"], options=list(r["options"]), gold=0) for r in row]), self.tok, _Keep(),
                       max_options=len(LETTERS), max_ctx_tokens=1 << 30) for row in rows]
        logits = [lg for per_item in self.score(items) for lg in per_item]
        probs = [softmax(lg, self.T_by_type.get(t, self.T)) for lg, t in zip(logits, row_types(rqs, index), strict=True)]
        out = {}
        for qid, kind, s, n in index:
            # isolated score: P(this level fits) per row, renormalised over levels (decider.systemone.combine_isolated)
            p = combine_isolated([probs[s + j][1] for j in range(n)])[0] if kind == "iso" else probs[s]
            ids = ["no", "yes"] if rqs[qid]["type"] == "noul" else [o["id"] for o in by_id[qid]["options"]]
            out[qid] = {"probs": dict(zip(ids, p, strict=True)), "confidence": max(p)}
        return out


def load(model="2B"):
    """Load a Decider ("2B", "4B" or a Hub repo / local path) on mlx-lm -> S1."""
    import json
    from pathlib import Path

    import mlx.core as mx
    from decider.prompt import letter_ids
    from huggingface_hub import snapshot_download
    from mlx_lm import load as mlx_load
    from mlx_lm.models.cache import KVCache

    path = Path(snapshot_download(MODELS.get(model, model)))
    loaded = mlx_load(str(path), return_config=False)
    lm = loaded[0]
    tok = loaded[1]._tokenizer  # the Hugging Face tokenizer decider.prompt expects
    config = json.loads((path / "decider_config.json").read_text())
    letters = mx.array(letter_ids(tok)[:len(LETTERS)])
    text = lm.language_model if hasattr(lm, "language_model") else lm
    head = (lambda h: text.model.embed_tokens.as_linear(h)) if text.args.tie_word_embeddings else text.lm_head

    def score(items):
        # The shared prefix (the state) runs once; its cache is forked to every row (decider's Engine.score_shared).
        # Prefill is compute-bound (about 1 ms per token on an M4), so this is what keeps independent rows cheap.
        p = min(min(it["slots"]) for it in items)
        for i in range(p):
            if any(it["ids"][i] != items[0]["ids"][i] for it in items):
                p = i
                break
        cache = text.make_cache()
        if p:
            text.model(mx.array([items[0]["ids"][:p]]), cache=cache)
            for c in cache:
                if isinstance(c, KVCache):
                    c.keys, c.values = (mx.repeat(a[..., :c.offset, :], len(items), 0) for a in (c.keys, c.values))
                else:
                    c.cache = [mx.repeat(a, len(items), 0) for a in c.cache]
        # the suffixes in one right-padded batch: the model is causal, so padding after a slot cannot change it
        width = max(len(it["ids"]) for it in items) - p
        ids = mx.array([it["ids"][p:] + [0] * (width - len(it["ids"]) + p) for it in items])
        hidden = text.model(ids, cache=cache)
        rows = mx.array([b for b, it in enumerate(items) for _ in it["slots"]])
        cols = mx.array([s - p for it in items for s in it["slots"]])
        lg = head(hidden[rows, cols])[:, letters].astype(mx.float32).tolist()  # project only the slot positions
        out, k = [], 0
        for it in items:
            out.append([lg[k + j][:n] for j, n in enumerate(it["nopts"])])
            k += len(it["slots"])
        return out

    return S1(tok, score, config, name=f"decider-{config.get('version', path.name)}")


def softmax(logits, T):
    m = max(logits)
    e = [math.exp((x - m) / T) for x in logits]
    return [x / sum(e) for x in e]
