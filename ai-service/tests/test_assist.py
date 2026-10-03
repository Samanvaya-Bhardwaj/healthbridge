import uuid

from fastapi.testclient import TestClient

from app.embeddings import HashingEmbeddingProvider
from app.llm.fake_handlers import DEFAULT_HANDLERS
from app.llm.instrumented import InstrumentedLLMProvider
from app.llm.providers.fake import FakeLLMProvider
from app.main import create_app
from app.rag.retrieval import Source
from app.rag.validation import INSUFFICIENT, validate_sentences
from tests.conftest import FakeDatabase, make_scope_token, make_settings, make_token

PATIENT = str(uuid.uuid4())
DOC_LAB = str(uuid.uuid4())
DOC_XRAY = str(uuid.uuid4())
FACT = str(uuid.uuid4())

CHUNKS = [
    {
        "id": str(uuid.uuid4()),
        "document_id": DOC_LAB,
        "content": (
            "Sunrise Diagnostics Laboratory\nHemoglobin: 12.9 g/dL (ref 12.0-15.5)\n"
            "WBC: 11.9 10^3/uL (ref 4.0-11.0)"
        ),
    },
    {
        "id": str(uuid.uuid4()),
        "document_id": DOC_XRAY,
        "content": "Chest X-ray report\nImpression: no acute findings",
    },
]


def app_with(responses: dict | None = None):
    db = FakeDatabase()
    db.chunks = [dict(c) for c in CHUNKS]
    llm = FakeLLMProvider({**DEFAULT_HANDLERS, **(responses or {})})
    app = create_app(
        make_settings(),
        database=db,
        llm_provider=InstrumentedLLMProvider(llm),
        embedding_provider=HashingEmbeddingProvider(),
    )
    return app, db, llm


def headers(purpose: str, docs: list[str]) -> dict:
    return {
        "Authorization": f"Bearer {make_token()}",
        "X-Patient-Scope": make_scope_token(PATIENT, docs, purpose=purpose),
    }


def ask(
    client, question, docs=(DOC_LAB, DOC_XRAY), facts=(), scope_docs=None, purpose="record_question"
):
    return client.post(
        "/v1/assist/answer",
        json={
            "patientId": PATIENT,
            "question": question,
            "documentIds": list(docs),
            "facts": [{"id": f[0], "text": f[1]} for f in facts],
        },
        headers=headers(purpose, list(scope_docs if scope_docs is not None else docs)),
    )


class TestValidator:
    SOURCES = (
        Source("S1", "document_chunk", "c1", "d1", "WBC: 11.9 10^3/uL (ref 4.0-11.0)"),
        Source("F1", "lab_result", "l1", None, "Hemoglobin 12.9 g/dL, verified"),
    )

    def test_keeps_only_cited_number_consistent_safe_sentences(self) -> None:
        kept, removed = validate_sentences(
            [
                {"text": "WBC was 11.9 10^3/uL.", "citations": ["S1"]},
                {"text": "Hemoglobin was 12.9 g/dL.", "citations": ["F1"]},
                {"text": "WBC was 15.2.", "citations": ["S1"]},  # number not in source
                {"text": "Hemoglobin is normal.", "citations": []},  # uncited
                {"text": "Platelets were fine.", "citations": ["S9"]},  # unknown source
                {
                    "text": "WBC 11.9 suggests a diagnosis of infection.",
                    "citations": ["S1"],
                },  # unsafe
                {"text": "Consider starting on antibiotics, WBC 11.9.", "citations": ["S1"]},
            ],
            self.SOURCES,
        )
        assert [k["text"] for k in kept] == ["WBC was 11.9 10^3/uL.", "Hemoglobin was 12.9 g/dL."]
        assert removed == 5
        assert kept[0]["citations"][0] == {
            "label": "S1",
            "type": "document_chunk",
            "id": "c1",
            "documentId": "d1",
        }

    def test_merges_identical_sentences_from_duplicate_documents(self) -> None:
        sources = (
            *self.SOURCES,
            Source("S2", "document_chunk", "c2", "d2", "WBC: 11.9 10^3/uL (ref 4.0-11.0)"),
        )
        kept, removed = validate_sentences(
            [
                {"text": "WBC: 11.9 10^3/uL (ref 4.0-11.0)", "citations": ["S1"]},
                {"text": "WBC: 11.9 10^3/uL (ref 4.0-11.0)", "citations": ["S2"]},
            ],
            sources,
        )
        assert removed == 0
        assert len(kept) == 1
        assert [c["label"] for c in kept[0]["citations"]] == ["S1", "S2"]

    def test_lab_names_are_not_mistaken_for_diagnoses(self) -> None:
        sources = (Source("S1", "document_chunk", "c1", "d1", "Sunrise Diagnostics Laboratory"),)
        kept, _ = validate_sentences(
            [
                {"text": "Sunrise Diagnostics Laboratory", "citations": ["S1"]},
                {"text": "Sunrise Laboratory diagnosed anaemia", "citations": ["S1"]},
            ],
            sources,
        )
        assert [k["text"] for k in kept] == ["Sunrise Diagnostics Laboratory"]


class TestAnswer:
    def test_scope_and_purpose_are_enforced(self) -> None:
        app, _, _ = app_with()
        with TestClient(app) as client:
            assert ask(client, "WBC?", purpose="doctor_brief").status_code == 403
            # A document outside the scope token cannot be named in the request.
            assert (
                ask(client, "WBC?", docs=[DOC_LAB, DOC_XRAY], scope_docs=[DOC_LAB]).status_code
                == 403
            )
            res = client.post(
                "/v1/assist/answer",
                json={"patientId": PATIENT, "question": "WBC?"},
                headers={"Authorization": f"Bearer {make_token()}"},
            )
            assert res.status_code == 401

    def test_answers_with_citations_to_retrieved_sources_only(self) -> None:
        app, db, _ = app_with()
        with TestClient(app) as client:
            data = ask(client, "What was the WBC count?").json()
        assert data["status"] == "answered"
        assert "WBC: 11.9 10^3/uL" in data["answer"]
        cited = data["sentences"][0]["citations"][0]
        assert cited["id"] == CHUNKS[0]["id"] and cited["documentId"] == DOC_LAB
        assert any("INSERT INTO ai.ai_sources" in s for _, s, _ in db.statements)
        # The question itself is never stored: only its hash.
        assert not any("What was the WBC" in str(p) for _, _, p in db.statements)

    def test_unauthorised_documents_are_never_retrieved(self) -> None:
        app, _, llm = app_with()
        with TestClient(app) as client:
            data = ask(client, "What did the X-ray show?", docs=[DOC_LAB]).json()
        for call in llm.calls:
            assert "Chest X-ray" not in call.messages[0].content
        assert data["status"] == "insufficient_information"

    def test_insufficient_information_is_the_exact_fallback_without_a_model_call(self) -> None:
        app, _, llm = app_with()
        with TestClient(app) as client:
            data = ask(client, "Is there an MRI of the knee?").json()
        assert data == {
            **data,
            "status": "insufficient_information",
            "answer": INSUFFICIENT,
            "sentences": [],
        }
        assert llm.calls == []

    def test_fabricated_or_uncited_output_falls_back(self) -> None:
        def fabricating(_request):
            return {
                "sentences": [
                    {"text": "WBC was 99.9 10^3/uL.", "citations": ["S1"]},
                    {"text": "The patient has leukaemia.", "citations": ["S1"]},
                    {"text": "Platelets were 300.", "citations": ["S7"]},
                ]
            }

        app, _, _ = app_with({"record_question": fabricating})
        with TestClient(app) as client:
            data = ask(client, "What was the WBC count?").json()
        assert data["status"] == "insufficient_information"
        assert data["answer"] == INSUFFICIENT
        assert data["removedSentenceCount"] == 3

    def test_verified_facts_are_citable(self) -> None:
        app, _, _ = app_with()
        with TestClient(app) as client:
            data = ask(
                client, "glucose", facts=[(FACT, "Fasting Glucose: 104 mg/dL (high), verified")]
            ).json()
        assert data["status"] == "answered"
        assert data["sentences"][0]["citations"][0] == {
            "label": "F1",
            "type": "lab_result",
            "id": FACT,
            "documentId": None,
        }


class TestBrief:
    def brief(self, client, docs=(DOC_LAB, DOC_XRAY), facts=()):
        return client.post(
            "/v1/assist/brief",
            json={
                "patientId": PATIENT,
                "appointmentId": str(uuid.uuid4()),
                "doctorUserId": str(uuid.uuid4()),
                "documentIds": list(docs),
                "facts": [{"id": f[0], "text": f[1]} for f in facts],
            },
            headers=headers("doctor_brief", list(docs)),
        )

    def test_brief_is_sectioned_cited_and_stored(self) -> None:
        app, db, _ = app_with()
        with TestClient(app) as client:
            data = self.brief(
                client, facts=[(FACT, "WBC: 11.9 10^3/uL (high), verified 2026-09-20")]
            ).json()
        assert data["status"] == "ready"
        headings = [s["heading"] for s in data["sections"]]
        assert headings == ["Recent verified lab values", "Documents on file"]
        for section in data["sections"]:
            for sentence in section["sentences"]:
                assert sentence["citations"]
        assert any("INSERT INTO ai.doctor_briefs" in s for _, s, _ in db.statements)

    def test_no_sources_means_insufficient_information(self) -> None:
        app, _, llm = app_with()
        with TestClient(app) as client:
            data = self.brief(client, docs=[]).json()
        assert data["status"] == "insufficient_information"
        assert data["message"] == INSUFFICIENT
        assert llm.calls == []
