"""Embeddings of public text for doctor search (M13.2): service token only, bounded."""

from fastapi.testclient import TestClient

from app.embeddings import EMBEDDING_DIMENSIONS, HashingEmbeddingProvider
from app.llm.fake_handlers import DEFAULT_HANDLERS
from app.llm.instrumented import InstrumentedLLMProvider
from app.llm.providers.fake import FakeLLMProvider
from app.main import create_app
from tests.conftest import FakeDatabase, make_settings, make_token


def client() -> TestClient:
    app = create_app(
        make_settings(),
        database=FakeDatabase(),
        llm_provider=InstrumentedLLMProvider(FakeLLMProvider(DEFAULT_HANDLERS)),
        embedding_provider=HashingEmbeddingProvider(),
    )
    return TestClient(app)


def post(c: TestClient, body: dict, token: str | None = None):
    headers = {"Authorization": f"Bearer {token or make_token()}"}
    return c.post("/v1/embeddings", json=body, headers=headers)


def test_embeds_public_profile_text_and_vocabulary_queries():
    with client() as c:
        res = post(
            c,
            {
                "purpose": "doctor_profile",
                "kind": "document",
                "texts": ["Dr. Synthetic. Dermatology. Lists Acne.", "Cardiology"],
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["model"] == "hashing"
        assert body["dimensions"] == EMBEDDING_DIMENSIONS
        assert [len(v) for v in body["vectors"]] == [EMBEDDING_DIMENSIONS] * 2
        query = post(c, {"purpose": "doctor_search_query", "kind": "query", "texts": ["Acne"]})
        assert query.status_code == 200


def test_requires_a_service_token_and_refuses_anything_else():
    with client() as c:
        assert c.post("/v1/embeddings", json={}).status_code == 401
        bad = [
            {"purpose": "record_question", "kind": "query", "texts": ["my rash"]},
            {"purpose": "doctor_profile", "kind": "document", "texts": []},
            {"purpose": "doctor_profile", "kind": "document", "texts": ["x"] * 65},
            {"purpose": "doctor_profile", "kind": "document", "texts": ["x" * 2001]},
            {"purpose": "doctor_profile", "kind": "document", "texts": ["x"], "patientId": "p"},
        ]
        for body in bad:
            assert post(c, body).status_code in (400, 422), body
