"""Telemetry decorator for any LLMProvider.

Emits one structured `llm_call` event per generation with metadata only: workflow,
provider, model, latency, token usage, estimated cost, stop reason, IDs and error kind.
Prompt and output content are never logged. Persisting these records to `ai.ai_runs`
is added with the AI execution-record tables (ADR-0012).
"""

import logging

from app.core.logging import log_event, request_id_ctx
from app.llm.base import LLMError, LLMProvider, LLMRequest, LLMResponse, ModelTier, StopReason

logger = logging.getLogger("healthbridge.ai.llm")


class InstrumentedLLMProvider(LLMProvider):
    def __init__(self, inner: LLMProvider) -> None:
        self._inner = inner
        self.name = inner.name

    @property
    def inner(self) -> LLMProvider:
        return self._inner

    def resolve_model(self, tier: ModelTier) -> str:
        return self._inner.resolve_model(tier)

    async def aclose(self) -> None:
        await self._inner.aclose()

    async def generate(self, request: LLMRequest) -> LLMResponse:
        base = {
            "event": "llm_call",
            "workflow": request.workflow,
            "runId": request.run_id,
            "requestId": request.request_id or request_id_ctx.get(),
            "provider": self._inner.name,
            "requestedModel": self._inner.resolve_model(request.tier),
            "tier": request.tier.value,
            "structuredOutput": request.json_schema is not None,
        }
        try:
            response = await self._inner.generate(request)
        except LLMError as exc:
            log_event(
                logger,
                logging.WARNING,
                "llm call failed",
                **base,
                status="error",
                errorKind=exc.kind.value,
                retryable=exc.retryable,
                httpStatus=exc.status_code,
                providerRequestId=exc.provider_request_id,
            )
            raise

        log_event(
            logger,
            logging.INFO,
            "llm call completed",
            **base,
            status="refused" if response.stop_reason is StopReason.REFUSAL else "ok",
            model=response.model,
            stopReason=response.stop_reason.value,
            latencyMs=response.latency_ms,
            inputTokens=response.usage.input_tokens,
            outputTokens=response.usage.output_tokens,
            cacheReadInputTokens=response.usage.cache_read_input_tokens,
            cacheCreationInputTokens=response.usage.cache_creation_input_tokens,
            estimatedCostUsd=response.estimated_cost_usd,
            providerRequestId=response.provider_request_id,
        )
        return response
