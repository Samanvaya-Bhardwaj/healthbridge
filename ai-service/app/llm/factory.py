"""Builds the configured LLMProvider. The only place that chooses a concrete provider."""

from app.core.config import Settings
from app.llm.base import LLMProvider
from app.llm.fake_handlers import DEFAULT_HANDLERS
from app.llm.instrumented import InstrumentedLLMProvider
from app.llm.providers.fake import FakeLLMProvider


def build_llm_provider(settings: Settings) -> LLMProvider:
    if settings.llm_provider == "claude":
        # Imported lazily so the SDK is only loaded when this provider is selected.
        from app.llm.providers.claude import ClaudeProvider

        if settings.anthropic_api_key is None:  # also enforced by Settings validation
            raise ValueError("ANTHROPIC_API_KEY is required when LLM_PROVIDER=claude")
        inner: LLMProvider = ClaudeProvider(
            api_key=settings.anthropic_api_key.get_secret_value(),
            model_default=settings.llm_model_default,
            model_fast=settings.llm_model_fast,
            timeout_seconds=settings.llm_timeout_seconds,
            max_retries=settings.llm_max_retries,
            refusal_fallback=settings.llm_refusal_fallback,
        )
    else:
        # Deterministic, rule-based stand-ins for the document/RAG workflows.
        inner = FakeLLMProvider(dict(DEFAULT_HANDLERS))
    return InstrumentedLLMProvider(inner)
