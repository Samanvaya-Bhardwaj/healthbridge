"""Provider-neutral LLM contract.

Agents, pipelines and RAG code depend on these types only. Provider SDK types
(Anthropic or any future provider) never leak past an adapter in `app/llm/providers`.
"""

from abc import ABC, abstractmethod
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class ModelTier(StrEnum):
    """Logical model class; each provider maps tiers to concrete model IDs via config."""

    DEFAULT = "default"  # extraction, briefs, grounded answers
    FAST = "fast"  # classification, query understanding


class StopReason(StrEnum):
    END = "end"
    MAX_TOKENS = "max_tokens"
    REFUSAL = "refusal"
    OTHER = "other"


class LLMMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class LLMRequest(BaseModel):
    """A single generation request.

    `workflow` (e.g. "document_extraction") and the IDs are metadata for telemetry
    and AI execution records; they are logged, the message content never is.
    """

    workflow: str = Field(min_length=1, max_length=64)
    messages: list[LLMMessage] = Field(min_length=1)
    system: str | None = None
    tier: ModelTier = ModelTier.DEFAULT
    max_tokens: int = Field(default=4096, ge=1, le=64_000)
    # JSON Schema the output must conform to (provider-enforced where supported).
    json_schema: dict[str, Any] | None = None
    request_id: str | None = None
    run_id: str | None = None


class LLMUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


class LLMResponse(BaseModel):
    provider: str
    requested_model: str
    model: str  # model that actually served the request (may differ after a fallback)
    text: str
    json_output: dict[str, Any] | list[Any] | None = None
    stop_reason: StopReason
    usage: LLMUsage
    latency_ms: int
    provider_request_id: str | None = None
    estimated_cost_usd: float | None = None


class LLMErrorKind(StrEnum):
    RATE_LIMITED = "rate_limited"
    TIMEOUT = "timeout"
    UNAVAILABLE = "unavailable"
    AUTHENTICATION = "authentication"
    BAD_REQUEST = "bad_request"
    INVALID_OUTPUT = "invalid_output"


_RETRYABLE = {LLMErrorKind.RATE_LIMITED, LLMErrorKind.TIMEOUT, LLMErrorKind.UNAVAILABLE}


class LLMError(Exception):
    """Provider-neutral failure. Messages must not include prompt or output content."""

    def __init__(
        self,
        kind: LLMErrorKind,
        message: str,
        *,
        provider: str,
        model: str | None = None,
        provider_request_id: str | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.provider = provider
        self.model = model
        self.provider_request_id = provider_request_id
        self.status_code = status_code

    @property
    def retryable(self) -> bool:
        return self.kind in _RETRYABLE


class LLMProvider(ABC):
    """Interface every LLM adapter implements."""

    name: str

    @abstractmethod
    def resolve_model(self, tier: ModelTier) -> str:
        """Concrete model ID for a logical tier."""

    @abstractmethod
    async def generate(self, request: LLMRequest) -> LLMResponse:
        """Run one generation. Raises `LLMError` on failure."""

    async def aclose(self) -> None:  # noqa: B027 - optional hook
        """Release network resources."""
