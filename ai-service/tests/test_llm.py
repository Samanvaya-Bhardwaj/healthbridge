import json
import logging
from types import SimpleNamespace

import anthropic
import httpx2
import pytest

from app.llm.base import LLMError, LLMErrorKind, LLMMessage, LLMRequest, ModelTier, StopReason
from app.llm.factory import build_llm_provider
from app.llm.instrumented import InstrumentedLLMProvider
from app.llm.pricing import estimate_cost_usd
from app.llm.providers.claude import FALLBACK_BETA, ClaudeProvider
from app.llm.providers.fake import FakeLLMProvider
from tests.conftest import make_settings

SYNTHETIC_PROMPT = "SYNTHETIC-PATIENT-MARKER: HbA1c 7.8% on 2026-09-14"
SYNTHETIC_OUTPUT = "SYNTHETIC-OUTPUT-MARKER"


def request(**overrides) -> LLMRequest:
    values = {
        "workflow": "test_workflow",
        "messages": [LLMMessage(role="user", content=SYNTHETIC_PROMPT)],
        "request_id": "req-0123456789abcdef",
        "run_id": "run-1",
    }
    values.update(overrides)
    return LLMRequest(**values)


def message(text: str, *, model: str = "claude-opus-5-5", stop_reason: str = "end_turn"):
    msg = SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        stop_reason=stop_reason,
        model=model,
        usage=SimpleNamespace(
            input_tokens=1000,
            output_tokens=200,
            cache_read_input_tokens=0,
            cache_creation_input_tokens=None,
        ),
    )
    msg._request_id = "req_provider_123"
    return msg


class RecordingCreate:
    def __init__(self, result=None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error
        self.calls: list[dict] = []

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.result


def fake_anthropic_client(create: RecordingCreate, beta_create: RecordingCreate | None = None):
    async def close() -> None:
        return None

    return SimpleNamespace(
        messages=SimpleNamespace(create=create),
        beta=SimpleNamespace(messages=SimpleNamespace(create=beta_create or create)),
        close=close,
    )


def claude(client, *, refusal_fallback: bool = False, model_default: str = "claude-opus-5-5"):
    return ClaudeProvider(
        api_key="unused",
        model_default=model_default,
        model_fast="claude-haiku-4-5",
        timeout_seconds=30,
        max_retries=0,
        refusal_fallback=refusal_fallback,
        client=client,
    )


# ── Factory ──────────────────────────────────────────────────────────────


def test_factory_builds_instrumented_fake_provider() -> None:
    provider = build_llm_provider(make_settings())
    assert isinstance(provider, InstrumentedLLMProvider)
    assert provider.name == "fake"


def test_factory_builds_claude_provider_from_config() -> None:
    provider = build_llm_provider(make_settings(llm_provider="claude", anthropic_api_key="sk-x"))
    assert isinstance(provider, InstrumentedLLMProvider)
    assert isinstance(provider.inner, ClaudeProvider)
    assert provider.resolve_model(ModelTier.DEFAULT) == "claude-opus-5-5"
    assert provider.resolve_model(ModelTier.FAST) == "claude-haiku-4-5"


# ── Claude adapter ───────────────────────────────────────────────────────


async def test_claude_maps_text_usage_and_cost() -> None:
    create = RecordingCreate(message("Hello"))
    provider = claude(fake_anthropic_client(create))

    response = await provider.generate(request(system="Be concise.", max_tokens=512))

    call = create.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["max_tokens"] == 512
    assert call["system"] == "Be concise."
    assert call["messages"] == [{"role": "user", "content": SYNTHETIC_PROMPT}]
    assert response.text == "Hello"
    assert response.stop_reason is StopReason.END
    assert response.usage.input_tokens == 1000
    assert response.provider_request_id == "req_provider_123"
    assert response.estimated_cost_usd == pytest.approx((1000 * 4 + 200 * 20) / 1_000_000)


async def test_claude_requests_structured_output_and_parses_json() -> None:
    schema = {"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"]}
    create = RecordingCreate(message(json.dumps({"a": 1})))
    provider = claude(fake_anthropic_client(create))

    response = await provider.generate(request(json_schema=schema))

    assert create.calls[0]["output_config"] == {"format": {"type": "json_schema", "schema": schema}}
    assert response.json_output == {"a": 1}


async def test_claude_invalid_json_raises_invalid_output() -> None:
    provider = claude(fake_anthropic_client(RecordingCreate(message("not json"))))
    with pytest.raises(LLMError) as exc_info:
        await provider.generate(request(json_schema={"type": "object"}))
    assert exc_info.value.kind is LLMErrorKind.INVALID_OUTPUT
    assert "not json" not in str(exc_info.value)


async def test_claude_uses_server_side_fallback_for_supported_models() -> None:
    plain = RecordingCreate(message("plain"))
    beta = RecordingCreate(message("served", model="claude-opus-4-8"))
    provider = claude(fake_anthropic_client(plain, beta), refusal_fallback=True)

    response = await provider.generate(request())

    assert plain.calls == []
    assert beta.calls[0]["betas"] == [FALLBACK_BETA]
    assert beta.calls[0]["fallbacks"] == "default"
    assert response.requested_model == "claude-opus-5-5"
    assert response.model == "claude-opus-4-8"


async def test_claude_skips_fallback_for_unsupported_models() -> None:
    plain = RecordingCreate(message("ok", model="claude-haiku-4-5"))
    beta = RecordingCreate(message("unexpected"))
    provider = claude(fake_anthropic_client(plain, beta), refusal_fallback=True)

    await provider.generate(request(tier=ModelTier.FAST))

    assert beta.calls == []
    assert plain.calls[0]["model"] == "claude-haiku-4-5"


async def test_claude_reports_refusals() -> None:
    provider = claude(fake_anthropic_client(RecordingCreate(message("", stop_reason="refusal"))))
    response = await provider.generate(request())
    assert response.stop_reason is StopReason.REFUSAL


def _http_request() -> httpx2.Request:
    return httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


@pytest.mark.parametrize(
    ("error", "kind", "retryable"),
    [
        (
            anthropic.RateLimitError(
                "rate limited", response=httpx2.Response(429, request=_http_request()), body=None
            ),
            LLMErrorKind.RATE_LIMITED,
            True,
        ),
        (anthropic.APITimeoutError(request=_http_request()), LLMErrorKind.TIMEOUT, True),
        (anthropic.APIConnectionError(request=_http_request()), LLMErrorKind.UNAVAILABLE, True),
        (
            anthropic.InternalServerError(
                "overloaded", response=httpx2.Response(529, request=_http_request()), body=None
            ),
            LLMErrorKind.UNAVAILABLE,
            True,
        ),
        (
            anthropic.AuthenticationError(
                "bad key", response=httpx2.Response(401, request=_http_request()), body=None
            ),
            LLMErrorKind.AUTHENTICATION,
            False,
        ),
        (
            anthropic.BadRequestError(
                "bad", response=httpx2.Response(400, request=_http_request()), body=None
            ),
            LLMErrorKind.BAD_REQUEST,
            False,
        ),
    ],
)
async def test_claude_maps_sdk_errors(error, kind, retryable) -> None:
    provider = claude(fake_anthropic_client(RecordingCreate(error=error)))
    with pytest.raises(LLMError) as exc_info:
        await provider.generate(request())
    assert exc_info.value.kind is kind
    assert exc_info.value.retryable is retryable
    assert exc_info.value.provider == "anthropic"


# ── Fake provider ────────────────────────────────────────────────────────


async def test_fake_provider_is_deterministic_and_records_calls() -> None:
    provider = FakeLLMProvider({"classify": {"documentType": "lab_report"}})
    response = await provider.generate(request(workflow="classify", json_schema={"type": "object"}))
    assert response.json_output == {"documentType": "lab_report"}
    assert response.estimated_cost_usd == 0.0
    assert len(provider.calls) == 1


# ── Telemetry: metadata only, never content ──────────────────────────────


async def test_telemetry_logs_metadata_but_never_content(caplog) -> None:
    provider = InstrumentedLLMProvider(FakeLLMProvider({"test_workflow": SYNTHETIC_OUTPUT}))
    with caplog.at_level(logging.INFO, logger="healthbridge.ai.llm"):
        await provider.generate(request())

    records = [r for r in caplog.records if r.name == "healthbridge.ai.llm"]
    assert len(records) == 1
    fields = records[0].fields
    assert fields["event"] == "llm_call"
    assert fields["status"] == "ok"
    assert fields["workflow"] == "test_workflow"
    assert fields["runId"] == "run-1"
    assert fields["requestId"] == "req-0123456789abcdef"
    assert fields["provider"] == "fake"
    assert {"latencyMs", "inputTokens", "outputTokens", "estimatedCostUsd"} <= fields.keys()

    rendered = caplog.text + json.dumps(fields, default=str)
    assert "SYNTHETIC-PATIENT-MARKER" not in rendered
    assert SYNTHETIC_OUTPUT not in rendered


async def test_telemetry_logs_failures_without_content(caplog) -> None:
    error = anthropic.APIConnectionError(request=_http_request())
    provider = InstrumentedLLMProvider(claude(fake_anthropic_client(RecordingCreate(error=error))))
    with caplog.at_level(logging.INFO, logger="healthbridge.ai.llm"), pytest.raises(LLMError):
        await provider.generate(request())

    fields = caplog.records[-1].fields
    assert fields["status"] == "error"
    assert fields["errorKind"] == "unavailable"
    assert "SYNTHETIC-PATIENT-MARKER" not in caplog.text


# ── Pricing ──────────────────────────────────────────────────────────────


def test_unknown_model_cost_is_none_not_a_guess() -> None:
    from app.llm.base import LLMUsage

    assert estimate_cost_usd("some-future-model", LLMUsage(input_tokens=10)) is None
