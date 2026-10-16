"""Ollama adapter (self-hosted models, e.g. on the developer's laptop or a private server).

Prompts and records go to the Ollama server named by OLLAMA_BASE_URL and nowhere else.
Structured output uses Ollama's `format` (a JSON schema), so the reply is constrained the
same way as with the hosted provider; the workflows still validate everything.
"""

import json
import time

import httpx

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

_STOP_REASONS = {"stop": StopReason.END, "length": StopReason.MAX_TOKENS}


class OllamaProvider(LLMProvider):
    name = "ollama"

    def __init__(
        self,
        *,
        base_url: str,
        model_default: str,
        model_fast: str,
        timeout_seconds: float,
        keep_alive: str = "30m",
        context_tokens: int = 8192,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._models = {ModelTier.DEFAULT: model_default, ModelTier.FAST: model_fast}
        self._keep_alive = keep_alive
        self._context_tokens = context_tokens
        self._client = client or httpx.AsyncClient(base_url=base_url, timeout=timeout_seconds)

    def resolve_model(self, tier: ModelTier) -> str:
        return self._models[tier]

    async def aclose(self) -> None:
        await self._client.aclose()

    async def generate(self, request: LLMRequest) -> LLMResponse:
        model = self.resolve_model(request.tier)
        messages = [{"role": "system", "content": request.system}] if request.system else []
        messages += [m.model_dump() for m in request.messages]
        body: dict = {
            "model": model,
            "messages": messages,
            "stream": False,
            # The model stays loaded between turns, so the prompt prefix is reused.
            "keep_alive": self._keep_alive,
            "options": {
                "temperature": 0,
                "num_predict": request.max_tokens,
                "num_ctx": self._context_tokens,
            },
        }
        if request.json_schema is not None:
            body["format"] = request.json_schema

        started = time.perf_counter()
        try:
            res = await self._client.post("/api/chat", json=body)
        except httpx.TimeoutException as exc:
            raise self._error(LLMErrorKind.TIMEOUT, "Ollama timed out", model) from exc
        except httpx.HTTPError as exc:
            raise self._error(LLMErrorKind.UNAVAILABLE, "Ollama unreachable", model) from exc
        latency_ms = round((time.perf_counter() - started) * 1000)
        if res.status_code >= 400:
            kind = LLMErrorKind.UNAVAILABLE if res.status_code >= 500 else LLMErrorKind.BAD_REQUEST
            # 404: the model is not pulled. The body may name the model, never content.
            raise self._error(kind, f"Ollama error {res.status_code}", model, res.status_code)

        data = res.json()
        text = (data.get("message") or {}).get("content", "")
        stop_reason = _STOP_REASONS.get(data.get("done_reason") or "stop", StopReason.OTHER)
        json_output = None
        if request.json_schema is not None and stop_reason is StopReason.END:
            try:
                json_output = json.loads(text)
            except json.JSONDecodeError as exc:
                raise self._error(
                    LLMErrorKind.INVALID_OUTPUT, "Model output was not valid JSON", model
                ) from exc
        usage = LLMUsage(
            input_tokens=int(data.get("prompt_eval_count") or 0),
            output_tokens=int(data.get("eval_count") or 0),
        )
        return LLMResponse(
            provider=self.name,
            requested_model=model,
            model=data.get("model") or model,
            text=text,
            json_output=json_output,
            stop_reason=stop_reason,
            usage=usage,
            latency_ms=latency_ms,
            # Self-hosted: no per-token price.
            estimated_cost_usd=0.0,
        )

    def _error(
        self, kind: LLMErrorKind, message: str, model: str, status: int | None = None
    ) -> LLMError:
        return LLMError(kind, message, provider=self.name, model=model, status_code=status)
