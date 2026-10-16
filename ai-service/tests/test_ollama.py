"""Local models through Ollama: chat with structured output, and embeddings (no network)."""

import json
import math

import httpx
import pytest

from app.embeddings import OllamaEmbeddingProvider
from app.llm.base import LLMError, LLMErrorKind, LLMMessage, LLMRequest, ModelTier
from app.llm.providers.ollama import OllamaProvider
from tests.conftest import make_settings


def provider(handler) -> OllamaProvider:
    client = httpx.AsyncClient(base_url="http://ollama", transport=httpx.MockTransport(handler))
    return OllamaProvider(
        base_url="http://ollama",
        model_default="llama3.1",
        model_fast="llama3.2",
        timeout_seconds=5,
        client=client,
    )


def request(**overrides) -> LLMRequest:
    return LLMRequest(
        workflow="care_assistant_intent",
        tier=ModelTier.FAST,
        system="Fill the form.",
        messages=[LLMMessage(role="user", content="synthetic message")],
        **overrides,
    )


async def test_structured_output_uses_the_schema_and_the_fast_model() -> None:
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(json.loads(req.content))
        return httpx.Response(
            200,
            json={
                "model": "llama3.2",
                "message": {"role": "assistant", "content": '{"intent": "find_doctor"}'},
                "done_reason": "stop",
                "prompt_eval_count": 120,
                "eval_count": 9,
            },
        )

    schema = {"type": "object", "properties": {"intent": {"type": "string"}}}
    res = await provider(handler).generate(request(json_schema=schema))
    assert seen["model"] == "llama3.2"
    assert seen["format"] == schema
    assert seen["messages"][0] == {"role": "system", "content": "Fill the form."}
    assert seen["options"]["temperature"] == 0
    assert res.json_output == {"intent": "find_doctor"}
    assert res.usage.input_tokens == 120
    assert res.estimated_cost_usd == 0.0  # self-hosted


@pytest.mark.parametrize(
    ("response", "kind"),
    [
        (httpx.Response(404, json={"error": "model not found"}), LLMErrorKind.BAD_REQUEST),
        (httpx.Response(500, json={"error": "boom"}), LLMErrorKind.UNAVAILABLE),
        (
            httpx.Response(200, json={"message": {"content": "not json"}, "done_reason": "stop"}),
            LLMErrorKind.INVALID_OUTPUT,
        ),
    ],
)
async def test_errors_map_to_provider_neutral_kinds(response, kind) -> None:
    with pytest.raises(LLMError) as raised:
        await provider(lambda _req: response).generate(request(json_schema={"type": "object"}))
    assert raised.value.kind is kind


async def test_an_unreachable_server_is_unavailable_not_a_crash() -> None:
    def handler(_req):
        raise httpx.ConnectError("refused")

    with pytest.raises(LLMError) as raised:
        await provider(handler).generate(request())
    assert raised.value.kind is LLMErrorKind.UNAVAILABLE
    assert raised.value.retryable


async def test_embeddings_are_normalised_padded_and_prefixed() -> None:
    sent = {}

    def handler(req: httpx.Request) -> httpx.Response:
        sent.update(json.loads(req.content))
        return httpx.Response(200, json={"embeddings": [[3.0, 4.0] + [0.0] * 766]})

    emb = OllamaEmbeddingProvider(
        base_url="http://ollama", model="nomic-embed-text", timeout_seconds=5
    )
    emb._client = httpx.AsyncClient(
        base_url="http://ollama", transport=httpx.MockTransport(handler)
    )
    [vector] = await emb.embed(["HbA1c 6.4 %"], kind="query")
    assert sent["input"] == ["search_query: HbA1c 6.4 %"]
    assert len(vector) == 1024  # zero-padded to the column size
    assert math.isclose(math.sqrt(sum(v * v for v in vector)), 1.0)
    assert vector[:2] == [0.6, 0.8]
    assert emb.model_id == "ollama:nomic-embed-text"


def test_ollama_is_self_hosted_needs_no_approval_or_budget() -> None:
    settings = make_settings(
        app_env="production", llm_provider="ollama", embedding_provider="ollama"
    )
    assert not settings.llm_is_external
    assert settings.llm_daily_budget_usd is None
