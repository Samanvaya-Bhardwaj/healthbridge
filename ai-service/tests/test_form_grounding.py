"""The model's form is checked against the person's own words (ADR-0041).

Each case below comes from running the assistant with llama3.2: the small model took a kind
of doctor for a name, dropped cities and names, chose areas nobody mentioned and called a
described concern "unsupported". The model is scripted here with those same answers.
"""

import asyncio
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.agents.care_assistant import _clock_in
from app.api.assist import _first_chunks
from app.rag.retrieval import Source, any_term_query, dated, overlap, rerank
from app.rag.validation import facts_only, validate_sentences, without_labels
from tests.test_booking_flow import SLOT_A, SLOT_B, TOOLS_B, slots_tool, turn
from tests.test_care_assistant import (
    DERM_IN_TEAM,
    DERM_NEW,
    SPECIALTIES,
    TODAY,
    TOOLS,
    app_with,
    context,
)

MEERA = DERM_NEW


def form(**fields) -> dict:
    """A filled-in form: the required fields, plus what the case is about."""
    return {
        "intent": "find_doctor",
        "specialty": None,
        "specialtyFromConcern": False,
        "dayKind": "none",
        "timeWindow": None,
        **fields,
    }


def run(fields: dict, text: str, state: dict | None = None, tools=TOOLS_B):
    app, _, _ = app_with({"care_assistant_intent": lambda _r: form(**fields)})
    with TestClient(app) as client:
        return turn(client, text, state or {}, tools=tools)


def named_search(args: dict) -> dict:
    found = [{"doctorId": MEERA, "inCareTeam": False}] if args.get("name") == "Meera" else []
    return {"ok": True, "data": {"doctors": found}}


CHOSEN = {
    "intent": "book_appointment",
    "candidateDoctorIds": [DERM_IN_TEAM, DERM_NEW],
    "bookingDoctorId": DERM_NEW,
    "selectedDoctorId": DERM_NEW,
    "slotStarts": [SLOT_A, SLOT_B],
}


def test_a_kind_of_doctor_is_not_a_name_and_a_dropped_city_is_read_back() -> None:
    out, _ = run(
        {
            "intent": "book_appointment",
            "specialty": "Dermatology",
            "specialtyFromConcern": True,
            "doctorName": "a dermatologist",
            "language": "Hindi",
            "areas": ["acne"],
        },
        "a dermatologist in Bangalore who speaks Hindi, online",
    )
    crit = out["state"]["criteria"]
    assert crit["doctorName"] is None
    assert crit["city"] == "Bangalore"
    assert crit["language"] == "Hindi"
    assert crit["consultationMode"] == "online"
    assert crit["areas"] == []  # nobody mentioned acne
    assert out["state"]["specialtyFromConcern"] is False  # it was named, not inferred


def test_a_doctors_name_the_model_missed_is_read_and_the_choice_survives_the_lookup() -> None:
    tools = {**TOOLS_B, "searchDoctors": named_search}
    app, _, _ = app_with(
        {"care_assistant_intent": lambda _r: form(intent="book_appointment", doctorName=None)}
    )
    with TestClient(app) as client:
        out, executed = turn(client, "Book Dr. Meera", {}, tools=tools)
        assert out["state"]["criteria"]["doctorName"] == "Meera"
        assert executed == ["getPatientCareTeam", "searchDoctors", "findAvailableSlots"]
        # The chosen doctor is in the state, so "at 10:30" answers these times.
        assert out["state"]["bookingDoctorId"] == MEERA
        assert out["reply"]["kind"] == "clarify"
        out, _ = turn(client, "at 10:30", out["state"], tools=tools)
    assert out["reply"]["kind"] == "confirm"
    assert out["reply"]["cards"][0]["startsAt"] == SLOT_A


def test_a_named_doctor_with_a_day_goes_straight_to_their_times() -> None:
    tools = {**TOOLS_B, "searchDoctors": named_search}
    out, executed = run(
        {"intent": "book_appointment"}, "book Dr Meera tomorrow at 10:30", tools=tools
    )
    assert executed == ["getPatientCareTeam", "searchDoctors", "findAvailableSlots"]
    assert out["state"]["bookingDoctorId"] == MEERA
    assert out["reply"]["kind"] == "confirm"


@pytest.mark.parametrize("text", ["doctor who speaks Hindi", "a doctor for my skin", "dr for acne"])
def test_words_after_doctor_are_not_a_name(text: str) -> None:
    out, _ = run({"doctorName": "who speaks"}, text)
    assert out["state"]["criteria"]["doctorName"] is None


@pytest.mark.parametrize("text", ["hello", "Hi!", "namaste", "Good morning"])
def test_a_greeting_is_a_greeting_whatever_the_model_calls_it(text: str) -> None:
    out, executed = run({"intent": "book_appointment"}, text)
    assert out["state"]["intent"] == "greeting"
    assert executed == []
    assert out["state"]["criteria"]["timeWindow"] is None


@pytest.mark.parametrize(
    "text", ["what medicines am I on?", "Show my prescriptions", "what tablets do I take"]
)
def test_a_question_about_ones_medicines_finds_them(text: str) -> None:
    out, _ = run({"intent": "unsupported"}, text)
    assert out["state"]["intent"] == "view_medications"


@pytest.mark.parametrize(
    "text",
    ["How are my kidneys?", "Am I anaemic?", "What is my BP?", "how is my liver"],
)
def test_a_question_about_ones_own_health_goes_to_the_records_not_to_a_search(text: str) -> None:
    # llama3.2 sent "How are my kidneys?" to neurologists.
    out, executed = run(
        {"intent": "book_appointment", "specialty": "Neurology", "specialtyFromConcern": True},
        text,
    )
    assert out["state"]["intent"] == "ask_records"
    assert executed == []
    assert out["state"]["criteria"]["specialty"] is None


def test_a_booking_that_mentions_medicine_stays_a_booking() -> None:
    out, _ = run(
        {"intent": "book_appointment", "specialty": "General Medicine"},
        "book a doctor about my medicines",
    )
    assert out["state"]["intent"] == "book_appointment"


def test_a_described_concern_is_a_request_whatever_the_model_calls_it() -> None:
    out, executed = run(
        {"intent": "unsupported", "specialty": "Gastroenterology"}, "I have acidity for 3 days"
    )
    assert out["state"]["intent"] == "find_doctor"
    assert "searchDoctors" in executed


def test_details_the_message_never_gave_are_dropped() -> None:
    out, _ = run(
        {
            "specialty": "Dermatology",
            "city": "Pune",
            "language": "Marathi",
            "consultationMode": "online",
            "timeWindow": "morning",
            "dayKind": "today",
            "doctorName": "Meera",
            "time": "10:00",
            "pickDoctor": 2,
            "showOthers": True,
            "remove": ["specialty"],
        },
        "I need a dermatologist",
    )
    crit = out["state"]["criteria"]
    assert crit["specialty"] == "Dermatology"
    for key in ("city", "language", "consultationMode", "timeWindow", "date", "doctorName"):
        assert crit[key] is None, key
    assert out["state"]["requestedTime"] is None
    assert out["state"]["excludedDoctorIds"] == []


@pytest.mark.parametrize(
    ("text", "date_is_today"),
    [
        ("not today, a dermatologist", False),
        ("a dermatologist, but not tomorrow", False),
        ("a dermatologist today", True),
        ("a dermatologist tonight", True),
    ],
)
def test_negated_days_are_not_days(text: str, date_is_today: bool) -> None:
    out, _ = run({"specialty": "Dermatology", "dayKind": "today"}, text)
    assert (out["state"]["criteria"]["date"] == TODAY.isoformat()) is date_is_today


def test_tonight_is_the_evening_and_the_day_after_tomorrow_has_its_date() -> None:
    out, _ = run({"specialty": "Dermatology"}, "a dermatologist tonight")
    assert out["state"]["criteria"]["timeWindow"] == "evening"
    out, _ = run({"specialty": "Dermatology", "dayKind": "tomorrow"}, "the day after tomorrow")
    assert out["state"]["criteria"]["date"] == (TODAY + timedelta(days=2)).isoformat()


@pytest.mark.parametrize(
    "text",
    [
        "a dermatologist, the rash has been there since morning",
        "a gynaecologist for morning sickness",
        "a skin doctor, it itches every evening",
        "a doctor for my cough at night",
    ],
)
def test_when_a_problem_happens_is_not_when_to_visit(text: str) -> None:
    out, _ = run({"timeWindow": "morning"}, text)
    assert out["state"]["criteria"]["timeWindow"] is None


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("at 4 pm", "16:00"),
        ("4:30pm please", "16:30"),
        ("4.30 pm", "16:30"),
        ("10:30", "10:30"),
        ("17:00", "17:00"),
        ("at 4", "16:00"),
        ("at 11", "11:00"),
        ("12 pm", "12:00"),
        ("12 am", "00:00"),
        ("around noon", "12:00"),
        ("for 3 days", None),
        ("at 2 weeks", None),
        ("my HbA1c is 7.2", None),
    ],
)
def test_clock_times_are_read_by_code(text: str, expected: str | None) -> None:
    assert _clock_in(text) == expected


def test_the_model_cannot_invent_a_clock_time_without_any_in_the_message() -> None:
    out, _ = run({"time": "10:30"}, "that works for me", dict(CHOSEN))
    assert out["state"]["requestedTime"] is None


def test_an_ordinal_picks_a_doctor_from_a_list_and_a_time_once_a_doctor_is_chosen() -> None:
    shown = {"intent": "find_doctor", "candidateDoctorIds": [DERM_IN_TEAM, DERM_NEW]}
    out, _ = run({"intent": "unsupported"}, "the second one", shown)
    assert out["state"]["bookingDoctorId"] == DERM_NEW
    out, executed = run({"intent": "unsupported"}, "the second one", dict(CHOSEN))
    assert executed == []
    assert out["reply"]["kind"] == "confirm"
    assert out["reply"]["cards"][0]["startsAt"] == SLOT_B


def test_a_doctor_with_no_online_times_is_told_as_that() -> None:
    def none(args: dict) -> dict:
        return {"ok": True, "data": {"doctorId": args["doctorId"], "slots": []}}

    out, _ = run({}, "online please", dict(CHOSEN), tools={**TOOLS_B, "findAvailableSlots": none})
    assert "no online times" in out["reply"]["message"]


def test_online_keeps_the_chosen_doctor_and_looks_at_their_times_again() -> None:
    seen: list[dict] = []

    def slots(args: dict) -> dict:
        seen.append(args)
        return slots_tool(args)

    tools = {**TOOLS_B, "findAvailableSlots": slots}
    out, _ = run({}, "online please", dict(CHOSEN), tools=tools)
    assert out["state"]["bookingDoctorId"] == DERM_NEW
    assert seen == [{"doctorId": DERM_NEW, "mode": "online"}]


def test_a_plain_yes_stands_by_the_booking_under_way() -> None:
    state = {**CHOSEN, "chosenStart": SLOT_A}
    out, _ = run({"intent": "greeting"}, "yes", state)
    assert out["reply"]["kind"] == "confirm"


def test_a_day_can_be_let_go() -> None:
    state = {"intent": "find_doctor", "criteria": {"date": "2026-10-12", "timeWindow": "evening"}}
    out, _ = run({}, "any day is fine", state)
    assert out["state"]["criteria"]["date"] is None
    assert out["state"]["criteria"]["timeWindow"] is None


def test_a_question_about_records_leaves_the_search_under_way_alone() -> None:
    state = {
        "intent": "find_doctor",
        "criteria": {"specialty": "Cardiology"},
        "candidateDoctorIds": [DERM_NEW],
    }
    out, _ = run(
        {"intent": "ask_records", "specialty": "Ophthalmology", "areas": ["cataract"]},
        "What did my eye check show?",
        state,
    )
    assert out["state"]["criteria"]["specialty"] == "Cardiology"
    assert out["state"]["candidateDoctorIds"] == [DERM_NEW]


def test_a_clock_time_reaches_the_lookup_and_replaces_the_window() -> None:
    seen: list[dict] = []

    def slots(args: dict) -> dict:
        seen.append(args)
        return slots_tool(args)

    state = {**CHOSEN, "criteria": {"timeWindow": "afternoon"}, "slotStarts": []}
    run({}, "at 11:00", state, tools={**TOOLS_B, "findAvailableSlots": slots})
    assert seen[0] == {"doctorId": DERM_NEW, "time": "11:00"}


def test_the_same_time_on_several_days_asks_which_day() -> None:
    later = "2026-10-13T05:00:00Z"  # also 10:30 India time

    def slots(args: dict) -> dict:
        offered = [{"startsAt": s, "mode": "online"} for s in (SLOT_A, SLOT_B, later)]
        return {"ok": True, "data": {"doctorId": args["doctorId"], "slots": offered}}

    out, _ = run({}, "at 10:30", dict(CHOSEN), tools={**TOOLS_B, "findAvailableSlots": slots})
    assert out["reply"]["kind"] == "clarify"
    assert [c["startsAt"] for c in out["reply"]["cards"]] == [SLOT_A, later]


def test_a_time_not_free_is_said_only_after_looking_it_up() -> None:
    out, executed = run({}, "at 16:00", dict(CHOSEN))
    assert executed == ["findAvailableSlots"]
    assert "16:00 isn't free" in out["reply"]["message"]


def test_the_day_asked_for_reaches_the_search() -> None:
    searches: list[dict] = []

    def search(args: dict) -> dict:
        searches.append(args)
        return TOOLS["searchDoctors"](args)

    tools = {**TOOLS_B, "searchDoctors": search}
    run({"specialty": "Dermatology"}, "a dermatologist on Monday evening", tools=tools)
    assert searches[0]["date"] == context()["weekdays"]["monday"]
    assert searches[0]["timeWindow"] == "evening"


def test_a_tap_on_a_gone_time_says_so_with_fresh_times_to_pick() -> None:
    app, _, _ = app_with()
    with TestClient(app) as client:
        out, executed = turn(
            client,
            "Monday",
            dict(CHOSEN),
            {"kind": "slot", "doctorId": DERM_NEW, "startsAt": "2026-10-20T05:00:00Z"},
        )
    assert executed == ["findAvailableSlots"]
    assert "isn't available any more" in out["reply"]["message"]
    assert [c["startsAt"] for c in out["reply"]["cards"]] == [SLOT_A, SLOT_B]
    assert out["state"]["staleChoice"] is False


def run_rag_validation(text: str, citations: list[str], source: str):
    sources = [Source("S3", "document_chunk", "c1", "d1", source)]
    return validate_sentences([{"text": text, "citations": citations}], sources)


def test_source_labels_leave_the_sentence_and_their_digits_fail_nothing() -> None:
    kept, removed = run_rag_validation(
        "According to S3, the last HbA1c was 6.1%.", ["S3"], "HbA1c 6.1% (ref 4.0-5.6)"
    )
    assert removed == 0
    assert kept[0]["text"] == "The last HbA1c was 6.1%."


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("HbA1c was 6.1% (S3).", "HbA1c was 6.1%."),
        ("HbA1c was 6.1% [S3].", "HbA1c was 6.1%."),
        ("As per S3, it was normal.", "It was normal."),
        ("It was normal, S3.", "It was normal."),
        ("Creatinine is 0.7 from tests S3 and S4.", "Creatinine is 0.7."),
        ("Creatinine is 0.7 from test S3.", "Creatinine is 0.7."),
        ("In S3 and S4, creatinine is 0.7.", "Creatinine is 0.7."),
    ],
)
def test_labels_are_removed_from_the_text(text: str, expected: str) -> None:
    assert without_labels(text, ["S3", "S4"]) == expected


def test_a_guess_at_what_a_result_means_is_not_a_fact() -> None:
    kept, removed = run_rag_validation(
        "Kidney function appears to be normal.", ["S3"], "Kidney function: eGFR normal"
    )
    assert (kept, removed) == ([], 1)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("HbA1c is 6.1 %, indicating prediabetes.", "HbA1c is 6.1 %."),
        ("Glucose is 198, which indicates poor control.", "Glucose is 198."),
        ("HbA1c is 6.1 %, suggesting a problem.", "HbA1c is 6.1 %."),
        ("HbA1c is 6.1 %.", "HbA1c is 6.1 %."),
    ],
)
def test_an_interpretation_added_to_a_fact_goes_and_the_fact_stays(text, expected) -> None:
    assert facts_only(text) == expected


def test_an_interpretation_as_the_main_verb_takes_the_sentence_with_it() -> None:
    # The fact here is the report's general rule, and half of it isn't a sentence.
    kept, removed = run_rag_validation(
        "HbA1c of 6.5% or more is consistent with diabetes mellitus.",
        ["S3"],
        "HbA1c of 6.5% or more is consistent with diabetes mellitus.",
    )
    assert (kept, removed) == ([], 1)


def test_a_sentence_that_is_only_an_interpretation_goes() -> None:
    kept, removed = run_rag_validation(
        "These results indicate poor control.", ["S3"], "These results are poor"
    )
    assert (kept, removed) == ([], 1)


def test_latest_reads_from_the_top_by_the_date_on_the_document() -> None:
    def chunk(document: str, text: str) -> Source:
        return Source("S1", "document_chunk", document, document, text)

    # Uploaded in another order, and the best text match is the oldest.
    found = [chunk("june", "HbA1c HbA1c 6.1"), chunk("october", "HbA1c 6.4"), chunk("x", "HbA1c")]
    dates = {"june": "2026-06-10", "october": "2026-10-02"}
    ranked = rerank("last HbA1c", dated(found, dates))
    assert [s.document_id for s in ranked] == ["october", "june", "x"]
    assert ranked[0].label == "S1"
    assert ranked[0].text.startswith("Document date: 2026-10-02.")
    # A sentence may quote the date it was given.
    assert validate_sentences(
        [{"text": "On 2026-10-02 HbA1c was 6.4.", "citations": ["S1"]}], ranked
    ) == (
        [
            {
                "text": "On 2026-10-02 HbA1c was 6.4.",
                "citations": [
                    {
                        "label": "S1",
                        "type": "document_chunk",
                        "id": "october",
                        "documentId": "october",
                    }
                ],
            }
        ],
        0,
    )


def test_a_value_says_which_report_it_came_from() -> None:
    def chunk(document: str, text: str, day: str | None) -> Source:
        return Source("S1", "document_chunk", document, document, text, date=day)

    sources = rerank(
        "HbA1c",
        [chunk("a", "HbA1c 6.4", "2026-10-02"), chunk("b", "HbA1c 6.1", "2026-06-10")],
    )
    kept, _ = validate_sentences(
        [
            {"text": "HbA1c: 6.4", "citations": ["S1"]},
            {"text": "HbA1c: 6.1.", "citations": ["S2"]},
            {"text": "HbA1c was 6.4 and then 6.1.", "citations": ["S1", "S2"]},
        ],
        sources,
    )
    assert [k["text"] for k in kept] == [
        "HbA1c: 6.4 (report dated 2026-10-02).",
        "HbA1c: 6.1 (report dated 2026-06-10).",
        "HbA1c was 6.4 and then 6.1.",  # two dates: not for code to choose between
    ]


def test_a_medical_word_that_looks_like_a_label_stays() -> None:
    text = "The MRI showed a disc bulge at L5."
    assert without_labels(text, ["S1"]) == text


def test_retrieval_needs_any_term_not_every_term() -> None:
    assert any_term_query("What was my last HbA1c?") == "'hba1c' | 'last'"
    assert any_term_query("HbA1c hba1c 7.2") == "'7.2' | 'hba1c'"
    assert any_term_query("is it?") == ""


@pytest.mark.parametrize(
    ("question", "report"),
    [
        ("How are my kidneys?", "Serum creatinine 0.9 mg/dL, kidney function normal"),
        ("How are my kidneys?", "eGFR 96"),
        ("What is my BP?", "Blood pressure 128/82 mmHg"),
        ("Am I anaemic?", "Haemoglobin 12.1 g/dL"),
        ("Is my sugar under control?", "Fasting glucose 118 mg/dL"),
        ("How is my thyroid?", "TSH 2.4 mIU/L"),
        ("Any problem with my eyes?", "Fundus: no microaneurysms"),
    ],
)
def test_everyday_words_find_what_a_report_calls_them(question: str, report: str) -> None:
    assert overlap(question, Source("S1", "document_chunk", "c", "d", report)) > 0


def test_an_unrelated_report_is_still_not_relevant() -> None:
    assert (
        overlap("How are my kidneys?", Source("S1", "document_chunk", "c", "d", "Chest clear")) == 0
    )


def test_a_doctor_brief_reads_the_newest_documents_not_the_oldest() -> None:
    newest_first = [f"doc-{n:02d}" for n in range(14, 0, -1)]

    class Conn:
        async def execute(self, _sql, _params):
            class Cursor:
                async def fetchall(self):
                    # The query sorts by document ID: time-ordered, so oldest first.
                    return [(f"c{d}", d, "text") for d in sorted(newest_first)]

            return Cursor()

    sources = asyncio.run(_first_chunks(Conn(), newest_first))
    assert [s.document_id for s in sources] == newest_first[:10]


def test_specialties_in_the_fixture_cover_these_cases() -> None:
    assert {"Dermatology", "Gastroenterology"} <= set(SPECIALTIES)
