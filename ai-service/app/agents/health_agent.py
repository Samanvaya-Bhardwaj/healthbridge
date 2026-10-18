"""General health information from the library (ADR-0040): generate ─► validate.

The article was chosen by code (its match words); this agent only writes a short summary of
it for the person's message. A sentence survives only if it:
  - cites passages that were provided, and has numbers only as they do;
  - uses mostly words of the passages it cites (lightly stemmed; plain connecting words
    such as "may help" or "symptoms" don't count);
  - has no diagnostic or prescribing wording (as for record answers);
  - names no medicine, dose or form of medicine;
  - says nothing about how serious or urgent it is, or that a doctor isn't needed;
  - repeats no detail from the person's message that the article doesn't contain (for
    example a medicine they took).
Nothing survives → no summary; the article's own lists are still shown.
"""

import re
from typing import Any, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph

from app.agents.assist_agent import _call
from app.agents.prompts import ANSWER_SCHEMA, HEALTH_SYSTEM, sources_message
from app.llm.base import LLMError, LLMProvider, StopReason
from app.rag.retrieval import Source, terms
from app.rag.validation import _NUMBER, _UNSAFE, MAX_SENTENCE_CHARS
from app.repositories.ai_store import RunTotals

MAX_SENTENCES = 4
MIN_HEALTH_SUPPORT = 0.75
# Words a plain summary needs that a passage may not contain.
_CONNECTIVES = frozenset(
    """
    you your can may might also often usually common try help helps helpful could some
    many symptoms symptom relief relieve alleviate ease eases reduce reduces lessen provide
    provides improve improves feel feeling better avoid avoiding kind problem problems
    issue issues things such like other well good way ways
    """.split()  # noqa: SIM905
)
# Ordinary words a message and a summary share; anything else from the message that the
# article doesn't contain (a medicine's name, another condition) must not be repeated.
_FUNCTION_WORDS = frozenset(
    """
    but and not nor yet have having has had been being was were will would should must
    take took taken taking feel feels felt feeling get gets got getting keep keeps
    kept since after before because just still nothing anything something everything
    more less very really much little few past last next days day weeks week months
    month times time now today yesterday tomorrow ago already even only than then them
    they this that these those there here what when where which while who why how
    about into over under again ever never always sometimes every each all changes
    change changed better worse same
    """.split()  # noqa: SIM905
)
_MEDICINE = re.compile(
    r"\b(\d+\s?(mg|ml|mcg|g)|tablets?|capsules?|syrups?|injections?|antibiotics?|antacids?|"
    r"painkillers?|drops|ointments?|doses?|dosage|medicines?|medications?|drugs?)\b",
    re.I,
)
_NOT_FOR_SUMMARY = re.compile(
    r"\b(nothing to worry|not serious|no need to (see|visit)|don'?t need (a|to see a)|"
    r"definitely|certainly|surely|you are suffering|it is (probably|likely|definitely)|"
    r"emergency|urgent\w*|serious)\b",
    re.I,
)


class HealthState(TypedDict, total=False):
    run_id: str
    request_id: str | None
    question: str
    sources: list[Source]
    raw: dict[str, Any]
    sentences: list[dict[str, Any]]
    removed: int
    status: str
    error_kind: str | None


def _stem(word: str) -> str:
    """A light stem, so "cutting" matches "cut" and "drinking" matches "drink"."""
    for suffix in ("ing", "ed", "es", "s"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            word = word[: -len(suffix)]
            break
    if len(word) > 3 and word[-1] == word[-2] and word[-1] not in "aeiou":
        word = word[:-1]
    return word


def _stems(text: str) -> set[str]:
    return {_stem(t) for t in terms(text)}


def validate_health(
    raw: list[dict[str, Any]], sources: list[Source], message: str
) -> tuple[list[dict[str, Any]], int]:
    """Returns (kept sentences with their citation labels, removed count)."""
    by_label = {s.label: s for s in sources}
    library = set().union(*(_stems(s.text) for s in sources))
    connectives = {_stem(w) for w in _CONNECTIVES}
    personal = (
        {_stem(t) for t in terms(message) if len(t) >= 4 and t not in _FUNCTION_WORDS}
        - library
        - connectives
    )
    kept: list[dict[str, Any]] = []
    removed = 0
    for sentence in raw:
        text = str(sentence.get("text") or "").strip()
        labels = list(dict.fromkeys(str(c) for c in (sentence.get("citations") or [])))
        cited = [by_label[label] for label in labels if label in by_label]
        words = _stems(text) - connectives
        available = set().union(*(_stems(c.text) for c in cited)) if cited else set()
        valid = (
            bool(text)
            and len(text) <= MAX_SENTENCE_CHARS
            and cited
            and len(cited) == len(labels)
            # Numbers only as the cited passages have them.
            and all(any(n in _NUMBER.findall(c.text) for c in cited) for n in _NUMBER.findall(text))
            # Most of its words come from the passages it cites.
            and bool(words)
            and len(words & available) / len(words) >= MIN_HEALTH_SUPPORT
            and not _UNSAFE.search(text)
            and not _MEDICINE.search(text)
            and not _NOT_FOR_SUMMARY.search(text)
            and not (_stems(text) & personal)
        )
        if not valid or any(k["text"].casefold() == text.casefold() for k in kept):
            removed += 1
            continue
        kept.append({"text": text, "citations": [{"label": c.label} for c in cited]})
    return kept[:MAX_SENTENCES], removed + max(0, len(kept) - MAX_SENTENCES)


def build_health_agent(llm: LLMProvider):
    totals = RunTotals()

    async def node_generate(state: HealthState) -> HealthState:
        try:
            res = await _call(
                llm,
                totals,
                state,  # type: ignore[arg-type]
                "health_info",
                HEALTH_SYSTEM,
                ANSWER_SCHEMA,
                sources_message(state["sources"], state["question"]),
            )
        except LLMError as exc:
            return {"raw": {}, "error_kind": exc.kind.value}
        if res.stop_reason is not StopReason.END or not isinstance(res.json_output, dict):
            return {"raw": {}, "error_kind": "refused"}
        return {"raw": res.json_output}

    async def node_validate(state: HealthState) -> HealthState:
        kept, removed = validate_health(
            state.get("raw", {}).get("sentences") or [], state["sources"], state["question"]
        )
        status = "answered" if kept else ("failed" if state.get("error_kind") else "no_summary")
        return {"sentences": kept, "removed": removed, "status": status}

    graph = StateGraph(HealthState)
    graph.add_node("generate", node_generate)
    graph.add_node("validate", node_validate)
    graph.add_edge(START, "generate")
    graph.add_edge("generate", "validate")
    graph.add_edge("validate", END)
    return graph.compile(checkpointer=InMemorySaver()), totals
