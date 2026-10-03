import uuid

from fastapi.testclient import TestClient

from app.embeddings import HashingEmbeddingProvider
from app.llm.fake_handlers import DEFAULT_HANDLERS
from app.llm.instrumented import InstrumentedLLMProvider
from app.llm.providers.fake import FakeLLMProvider
from app.main import create_app
from tests.conftest import FakeDatabase, make_scope_token, make_settings, make_token

PATIENT = str(uuid.uuid4())
OTHER = str(uuid.uuid4())
RESPONSE = str(uuid.uuid4())
FOLLOW_UP = str(uuid.uuid4())
DOCTOR = str(uuid.uuid4())
FACTS = [
    "Overall, the patient feels worse than at the consultation.",
    "The patient reported this warning sign: Difficulty breathing.",
    "Patient's note: cough is worse at night (synthetic).",
    "The check-in was due on 2026-10-12.",
]


def app_with(responses: dict | None = None):
    db = FakeDatabase()
    llm = FakeLLMProvider({**DEFAULT_HANDLERS, **(responses or {})})
    app = create_app(
        make_settings(),
        database=db,
        llm_provider=InstrumentedLLMProvider(llm),
        embedding_provider=HashingEmbeddingProvider(),
    )
    return app, db, llm


def summarize(
    client, *, patient=PATIENT, scope_patient=PATIENT, purpose="follow_up_summary", facts=FACTS
):
    return client.post(
        "/v1/followups/summary",
        json={
            "patientId": patient,
            "followUpId": FOLLOW_UP,
            "doctorUserId": DOCTOR,
            "facts": [{"id": RESPONSE, "text": t} for t in facts],
        },
        headers={
            "Authorization": f"Bearer {make_token()}",
            "X-Patient-Scope": make_scope_token(scope_patient, [], purpose=purpose),
        },
    )


def test_summary_is_cited_stored_and_restates_only_the_facts() -> None:
    app, db, _ = app_with()
    with TestClient(app) as client:
        data = summarize(client).json()
    assert data["status"] == "ready"
    assert [s["text"] for s in data["sentences"]] == FACTS
    for sentence in data["sentences"]:
        assert sentence["citations"][0]["type"] == "follow_up_response"
    sql = [s for _, s, _ in db.statements]
    assert any("INSERT INTO ai.follow_up_summaries" in s for s in sql)
    assert any("INSERT INTO ai.ai_sources" in s for s in sql)
    # Everything runs inside the scoped patient's transaction.
    assert {pid for pid, _, _ in db.statements} == {PATIENT}


def test_unsafe_or_uncited_sentences_are_removed() -> None:
    def handler(_request):
        return {
            "sentences": [
                {
                    "text": "The patient likely has pneumonia and should start antibiotics.",
                    "citations": ["F1"],
                },
                {"text": "The patient reported difficulty breathing.", "citations": []},
                {
                    "text": "Overall, the patient feels worse than at the consultation.",
                    "citations": ["F1"],
                },
            ]
        }

    app, _, _ = app_with({"follow_up_summary": handler})
    with TestClient(app) as client:
        data = summarize(client).json()
    assert [s["text"] for s in data["sentences"]] == [FACTS[0]]
    assert data["removedSentenceCount"] == 2


def test_no_facts_means_insufficient_information_without_a_model_call() -> None:
    app, _, llm = app_with()
    with TestClient(app) as client:
        data = summarize(client, facts=[]).json()
    assert data["status"] == "insufficient_information"
    assert llm.calls == []


def test_scope_must_match_purpose_and_patient() -> None:
    app, _, _ = app_with()
    with TestClient(app) as client:
        assert summarize(client, purpose="doctor_brief").status_code == 403
        assert summarize(client, scope_patient=OTHER).status_code == 403
