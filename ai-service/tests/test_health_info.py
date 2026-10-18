"""General health information from the library (ADR-0040)."""

import uuid

import pytest
from fastapi.testclient import TestClient

from app.agents.health_agent import validate_health
from app.embeddings import HashingEmbeddingProvider
from app.health.library import (
    ARTICLES_DIR,
    LibraryError,
    load_library,
    match,
    parse_article,
    sources,
)
from app.llm.fake_handlers import DEFAULT_HANDLERS
from app.llm.instrumented import InstrumentedLLMProvider
from app.llm.providers.fake import FakeLLMProvider
from app.main import create_app
from tests.conftest import FakeDatabase, make_scope_token, make_settings, make_token
from tests.test_care_assistant import _Down, digest

PATIENT = str(uuid.uuid4())
ACIDITY = "I am having acidity for past 3 days, i took unienzyme but nothing changes"
LIBRARY = load_library(production=False)


def app_with(responses=None, provider=None, **settings):
    db = FakeDatabase()
    llm = provider or FakeLLMProvider({**DEFAULT_HANDLERS, **(responses or {})})
    app = create_app(
        make_settings(**settings),
        database=db,
        llm_provider=InstrumentedLLMProvider(llm),
        embedding_provider=HashingEmbeddingProvider(),
    )
    return app, db, llm


def ask(client, message, patient=PATIENT, purpose="care_assistant"):
    return client.post(
        "/v1/health-info/answer",
        json={"patientId": PATIENT, "message": message, "inputDigest": digest(message)},
        headers={
            "Authorization": f"Bearer {make_token()}",
            "X-Patient-Scope": make_scope_token(patient, [], purpose=purpose),
        },
    )


class TestLibrary:
    def test_every_article_is_complete_and_draft_until_reviewed(self) -> None:
        assert len(LIBRARY) >= 15
        for article in LIBRARY:
            assert article.overview and article.linked and article.help and article.see_doctor
            assert article.review == "draft"
        assert len({a.id for a in LIBRARY}) == len(LIBRARY)
        # Production serves approved articles only: none are yet.
        assert load_library(production=True) == []

    def test_malformed_or_unreviewed_approvals_fail_loudly(self) -> None:
        good = (ARTICLES_DIR / "acidity.md").read_text(encoding="utf-8")
        with pytest.raises(LibraryError, match="missing section"):
            parse_article(good.replace("## What may help", "## Often linked with"))
        with pytest.raises(LibraryError, match="reviewed_by"):
            parse_article(good.replace("review: draft", "review: approved"))
        approved = good.replace(
            "review: draft", "review: approved\nreviewed_by: Dr. Test\nreviewed_on: 2026-10-18"
        )
        assert parse_article(approved).review == "approved"

    @pytest.mark.parametrize(
        ("message", "article"),
        [
            (ACIDITY, "acidity"),
            ("mujhe khansi hai do din se", "cough"),
            ("I don't have a fever but I have a bad cold", "common_cold"),
            ("kamar dard ho raha hai", "back_pain"),
            ("stomach pain since this morning", "stomach_ache"),
            ("pimples on my face", "acne"),
            ("loose motions since yesterday", "diarrhoea"),
            ("burning when passing urine", "urine_burning"),
            ("Find me a dermatologist in Pune tomorrow", None),
            ("book Dr Meera", None),
            ("I need a doctor for my diabetes, online, tomorrow morning", None),
        ],
    )
    def test_the_message_picks_an_article_by_its_words(self, message, article) -> None:
        found = match(message, LIBRARY)
        assert (found.id if found else None) == article

    def test_urgent_signs_never_reach_the_summary(self) -> None:
        acidity = match(ACIDITY, LIBRARY)
        texts = " ".join(s.text for s in sources(acidity))
        assert all(u not in texts for u in acidity.urgent)


class TestValidation:
    passages = sources(match(ACIDITY, LIBRARY))

    def label(self, fragment: str) -> str:
        return next(s.label for s in self.passages if fragment in s.text)

    def check(self, text: str, fragment: str) -> bool:
        kept, _ = validate_health(
            [{"text": text, "citations": [self.label(fragment)]}], self.passages, ACIDITY
        )
        return bool(kept)

    def test_keeps_sentences_in_the_library_own_words(self) -> None:
        assert self.check(
            "Acidity is often linked with large meals, or eating late at night.", "Large meals"
        )
        assert self.check("Eating smaller meals more often may help.", "smaller meals")
        # Seen live with llama3.2: plain paraphrases of the passage are kept.
        assert self.check(
            "Cutting down on spicy, oily and fried food may help alleviate your symptoms.",
            "spicy, oily",
        )
        assert self.check("Drinking water through the day can also provide relief.", "Drink water")

    def test_drops_medicines_personal_details_and_reassurance(self) -> None:
        assert not self.check(
            "Unienzyme may not help acidity linked with large meals.", "Large meals"
        )
        assert not self.check("Take an antacid tablet after large meals.", "Large meals")
        assert not self.check("Large meals are not serious, nothing to worry about.", "Large meals")
        assert not self.check("You have reflux disease from large meals.", "Large meals")
        # Not supported by the passage it cites.
        assert not self.check("Yoga and meditation cure acidity quickly.", "Large meals")


class TestEndpoint:
    def test_answers_with_the_article_and_a_cited_summary(self) -> None:
        app, db, llm = app_with()
        with TestClient(app) as client:
            res = ask(client, ACIDITY)
        assert res.status_code == 200
        body = res.json()
        assert body["matched"] is True and body["status"] == "answered"
        article = body["article"]
        assert article["id"] == "acidity" and article["title"] == "Acidity and heartburn"
        assert (
            article["urgentIf"]
            and article["seeDoctorIf"]
            and article["review"]["status"] == "draft"
        )
        assert body["summary"]
        for sentence in body["summary"]:
            assert sentence["citations"]
            assert {c["section"] for c in sentence["citations"]} <= {
                "overview",
                "often linked with",
                "what may help",
                "see a doctor if",
            }
            assert "unienzyme" not in sentence["text"].lower()
        assert [c.workflow for c in llm.calls] == ["health_info"]
        # One run, with the backend's keyed digest; the message itself is stored nowhere.
        runs = [s for s in db.statements if "INSERT INTO ai.ai_runs" in s[1]]
        assert len(runs) == 1 and "health_info" in runs[0][2]
        assert digest(ACIDITY)["value"] in runs[0][2]
        assert all(ACIDITY not in str(s) for s in db.statements)

    def test_no_article_means_no_model_call_and_no_run(self) -> None:
        app, db, llm = app_with()
        with TestClient(app) as client:
            res = ask(client, "Find me a dermatologist in Pune tomorrow")
        assert res.json() == {"matched": False}
        assert llm.calls == [] and db.statements == []

    def test_scope_is_enforced(self) -> None:
        app, _, llm = app_with()
        with TestClient(app) as client:
            assert ask(client, ACIDITY, patient=str(uuid.uuid4())).status_code == 403
            assert ask(client, ACIDITY, purpose="record_question").status_code == 403
        assert llm.calls == []

    def test_model_down_still_returns_the_article_lists(self) -> None:
        app, _, _ = app_with(provider=_Down())
        with TestClient(app) as client:
            body = ask(client, ACIDITY).json()
        assert body["status"] == "failed" and body["summary"] == []
        assert body["article"]["mayHelp"]

    def test_production_serves_approved_articles_only(self) -> None:
        app, _, llm = app_with(
            app_env="production",
            llm_provider="claude",
            anthropic_api_key="k" * 40,
            llm_external_processing_approved=True,
            llm_daily_budget_usd=5,
        )
        assert app.state.health_library == []
        assert llm.calls == []
