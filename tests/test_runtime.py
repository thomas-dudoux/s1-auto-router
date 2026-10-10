import math

import pytest

from s1.runtime import S1


class CharTok:
    """One token per character: decode(encode(s)) == s, so prompts can be read back as text."""

    def encode(self, text, add_special_tokens=False):
        return [ord(c) for c in text]

    def decode(self, ids):
        return "".join(chr(i) for i in ids)


TOK = CharTok()
CONFIG = {"temperature": 1.0, "temperature_by_type": {"choice": 1.0, "noul": 2.0, "score": 1.0}}
YESNO = {"id": "M2", "type": "yesno", "text": "Does it span many files?"}
CHOICE = {"id": "M1", "type": "choice", "text": "What kind of work?",
          "options": [{"id": "locate", "description": "find code"}, {"id": "design", "description": "design a module"}]}
SCORE = {"id": "E1", "type": "score", "text": "How open are the instructions?",
         "options": [{"id": "clear", "description": "fully specified"}, {"id": "very_open", "description": "open-ended"}]}


def recording_s1(logits_per_row):
    """An S1 whose forward pass records the prompts and returns scripted option logits, one list per row."""
    seen = []

    def score(items):
        seen.extend(items)
        rows = iter(logits_per_row)
        return [[next(rows) for _ in it["slots"]] for it in items]

    return S1(TOK, score, CONFIG, name="fake"), seen


def test_independent_prompt_uses_the_trained_plain_layout():
    s1, seen = recording_s1([[0.0, 0.0]])
    s1.answer({"description": "find X"}, [YESNO])
    (item,) = seen
    assert TOK.decode(item["ids"]) == (
        'Context:\n{"description": "find X"}\n\nQuestion: Does it span many files?\nOptions:\n(A) no\n(B) yes\nAnswer: ('
    )
    assert item["slots"] == [len(item["ids"]) - 1]


def test_packed_prompt_puts_every_question_behind_one_state():
    s1, seen = recording_s1([[0.0, 0.0], [0.0, 0.0]])
    s1.answer("ctx", [YESNO, CHOICE], packed=True)
    (item,) = seen
    assert TOK.decode(item["ids"]) == (
        "Context:\nctx"
        "\n\nQuestion 1: Does it span many files?\nOptions:\n(A) no\n(B) yes\nAnswer 1: ("
        "\n\nQuestion 2: What kind of work?\nOptions:\n(A) locate: find code\n(B) design: design a module\nAnswer 2: ("
    )
    assert len(item["slots"]) == 2


def test_answers_are_softmaxed_per_option_id_at_each_type_temperature():
    # yes/no at T=2: logits (0, 2 ln 3) -> (0, ln 3) -> no 1/4, yes 3/4. choice at T=1: (0, ln 4) -> 1/5, 4/5.
    s1, _ = recording_s1([[0.0, 2 * math.log(3)], [0.0, math.log(4)]])
    answers = s1.answer("ctx", [YESNO, CHOICE])
    assert answers["M2"]["probs"] == pytest.approx({"no": 0.25, "yes": 0.75})
    assert answers["M2"]["confidence"] == pytest.approx(0.75)
    assert answers["M1"]["probs"] == pytest.approx({"locate": 0.2, "design": 0.8})
    assert answers["M1"]["confidence"] == pytest.approx(0.8)


def test_packed_answers_read_one_slot_per_question():
    s1, _ = recording_s1([[0.0, 2 * math.log(3)], [0.0, math.log(4)]])
    answers = s1.answer("ctx", [YESNO, CHOICE], packed=True)
    assert answers["M2"]["probs"] == pytest.approx({"no": 0.25, "yes": 0.75})
    assert answers["M1"]["probs"] == pytest.approx({"locate": 0.2, "design": 0.8})


def test_isolated_score_levels_are_asked_one_by_one_and_renormalised():
    # each level is its own yes/no row at the score temperature (1): P(fits) 3/4 and 1/4, summing to 1.
    s1, seen = recording_s1([[0.0, math.log(3)], [0.0, -math.log(3)]])
    s1.isolated_levels = True
    answers = s1.answer("ctx", [SCORE])
    assert len(seen) == 2
    assert "Proposed answer: fully specified\nDoes the proposed answer fit?" in TOK.decode(seen[0]["ids"])
    assert answers["E1"]["probs"] == pytest.approx({"clear": 0.75, "very_open": 0.25})
    assert answers["E1"]["confidence"] == pytest.approx(0.75)


def test_mismatched_model_probabilities_are_rejected():
    s1, _ = recording_s1([[0.0]])
    with pytest.raises(ValueError, match="zip"):
        s1.answer("ctx", [YESNO])
