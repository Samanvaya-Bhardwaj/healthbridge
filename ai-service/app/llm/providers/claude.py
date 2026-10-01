"""Anthropic Claude adapter. The only module that imports the Anthropic SDK."""

import json
import time

import anthropic

from app.llm.base import (
    LLMError,
    LLMErrorKind,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    LLMUsage,
    ModelTier,
    StopReason,
)
from app.llm.pricing import estimate_cost_usd

# Models that support the server-side refusal fallback (`fallbacks: "default"`).
FALLBACK_CAPABLE_MODELS = frozenset(
    {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
)
FALLBACK_BETA = "server-side-fallback-2026-07-01"

_STOP_REASONS = {
    "end_turn": StopReason.END,
    "stop_sequence": StopReason.END,
    "max_tokens": StopReason.MAX_TOKENS,
    "refusal": StopReason.REFUSAL,
}


class ClaudeProvider(LLMProvider):
    name = "anthropic"

    def __init__(
        self,
        *,
        api_key: str,
        model_default: str,
        model_fast: str,
        timeout_seconds: float,
        max_retries: int,
        refusal_fallback: bool,
        client: anthropic.AsyncAnthropic | None = None,
    ) -> None:
        self._models = {ModelTier.DEFAULT: model_default, ModelTier.FAST: model_fast}
        self._refusal_fallback = refusal_fallback
        self._client = client or anthropic.AsyncAnthropic(
            api_key=api_key, timeout=timeout_seconds, max_retries=max_retries
        )

    def resolve_model(self, tier: ModelTier) -> str:
        return self._models[tier]

    async def aclose(self) -> None:
        await self._client.close()

    async def generate(self, request: LLMRequest) -> LLMResponse:
        model = self.resolve_model(request.tier)
        params: dict = {
            "model": model,
            "max_tokens": request.max_tokens,
            "messages": [m.model_dump() for m in request.messages],
        }
        if request.system:
            params["system"] = request.system
        if request.json_schema is not None:
            params["output_config"] = {
                "format": {"type": "json_schema", "schema": request.json_schema}
            }

        started = time.perf_counter()
        try:
            if self._refusal_fallback and model in FALLBACK_CAPABLE_MODELS:
                message = await self._client.beta.messages.create(
                    **params, betas=[FALLBACK_BETA], fallbacks="default"
                )
            else:
                message = await self._client.messages.create(**params)
        except anthropic.APIError as exc:
            raise self._map_error(exc, model) from exc
        latency_ms = round((time.perf_counter() - started) * 1000)

        text = "".join(block.text for block in message.content if block.type == "text")
        stop_reason = _STOP_REASONS.get(message.stop_reason or "", StopReason.OTHER)
        provider_request_id = getattr(message, "_request_id", None)

        json_output = None
        if request.json_schema is not None and stop_reason is StopReason.END:
            try:
                json_output = json.loads(text)
            except json.JSONDecodeError as exc:
                raise LLMError(
                    LLMErrorKind.INVALID_OUTPUT,
                    "Model output was not valid JSON",
                    provider=self.name,
                    model=message.model,
                    provider_request_id=provider_request_id,
                ) from exc

        usage = LLMUsage(
            input_tokens=message.usage.input_tokens or 0,
            output_tokens=message.usage.output_tokens or 0,
            cache_read_input_tokens=getattr(message.usage, "cache_read_input_tokens", None) or 0,
            cache_creation_input_tokens=(
                getattr(message.usage, "cache_creation_input_tokens", None) or 0
            ),
        )
        return LLMResponse(
            provider=self.name,
            requested_model=model,
            model=message.model,
            text=text,
            json_output=json_output,
            stop_reason=stop_reason,
            usage=usage,
            latency_ms=latency_ms,
            provider_request_id=provider_request_id,
            estimated_cost_usd=estimate_cost_usd(message.model, usage),
        )

    def _map_error(self, exc: anthropic.APIError, model: str) -> LLMError:
        # Most specific first: APITimeoutError subclasses APIConnectionError.
        if isinstance(exc, anthropic.APITimeoutError):
            kind = LLMErrorKind.TIMEOUT
        elif isinstance(exc, anthropic.APIConnectionError):
            kind = LLMErrorKind.UNAVAILABLE
        elif isinstance(exc, anthropic.RateLimitError):
            kind = LLMErrorKind.RATE_LIMITED
        elif isinstance(exc, anthropic.AuthenticationError | anthropic.PermissionDeniedError):
            kind = LLMErrorKind.AUTHENTICATION
        elif isinstance(exc, anthropic.APIStatusError) and exc.status_code >= 500:
            kind = LLMErrorKind.UNAVAILABLE
        else:
            kind = LLMErrorKind.BAD_REQUEST

        status_code = getattr(exc, "status_code", None)
        request_id = getattr(exc, "request_id", None)
        return LLMError(
            kind,
            f"Anthropic API error ({type(exc).__name__})",
            provider=self.name,
            model=model,
            provider_request_id=request_id,
            status_code=status_code,
        )
