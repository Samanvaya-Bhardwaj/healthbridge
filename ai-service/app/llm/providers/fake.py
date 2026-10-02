"""Deterministic, offline provider for tests, CI and local development without an API key."""

import json
from collections.abc import Callable
from typing import Any

from app.llm.base import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    LLMUsage,
    ModelTier,
    StopReason,
)

CannedOutput = str | dict[str, Any] | list[Any] | Callable[[LLMRequest], Any]


class FakeLLMProvider(LLMProvider):
    name = "fake"

    def __init__(self, responses: dict[str, CannedOutput] | None = None) -> None:
        # Canned outputs (or deterministic handlers) keyed by workflow name.
        self._responses = responses or {}
        self.calls: list[LLMRequest] = []

    def resolve_model(self, tier: ModelTier) -> str:
        return f"fake-{tier.value}"

    async def generate(self, request: LLMRequest) -> LLMResponse:
        self.calls.append(request)
        canned = self._responses.get(request.workflow)
        if callable(canned):
            canned = canned(request)
        json_output: dict[str, Any] | list[Any] | None = None
        if request.json_schema is not None:
            json_output = canned if isinstance(canned, dict | list) else {}
            text = json.dumps(json_output)
        else:
            text = canned if isinstance(canned, str) else "Fake response."

        prompt_chars = sum(len(m.content) for m in request.messages) + len(request.system or "")
        model = self.resolve_model(request.tier)
        return LLMResponse(
            provider=self.name,
            requested_model=model,
            model=model,
            text=text,
            json_output=json_output,
            stop_reason=StopReason.END,
            usage=LLMUsage(input_tokens=max(1, prompt_chars // 4), output_tokens=len(text) // 4),
            latency_ms=0,
            estimated_cost_usd=0.0,
        )
