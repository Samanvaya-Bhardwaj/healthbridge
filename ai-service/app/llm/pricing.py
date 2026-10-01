"""Approximate per-token prices for AI cost tracking (estimates, not billing).

Source: Anthropic first-party API list prices as of PRICING_AS_OF (USD per million tokens).
Cache-write prices assume the default 5-minute cache TTL (1.25 x input). Unknown models
return None rather than a guess. Update this table when models or prices change.
"""

from dataclasses import dataclass

from app.llm.base import LLMUsage

PRICING_AS_OF = "2026-09-25"


@dataclass(frozen=True)
class ModelPrice:
    input_per_mtok: float
    output_per_mtok: float
    cache_read_per_mtok: float
    cache_write_per_mtok: float


PRICES: dict[str, ModelPrice] = {
    "claude-opus-5-5": ModelPrice(4.00, 20.00, 0.20, 5.00),
    "claude-sonnet-5-5": ModelPrice(2.00, 10.00, 0.20, 2.50),
    "claude-haiku-4-5": ModelPrice(1.00, 5.00, 0.10, 1.25),
}


def estimate_cost_usd(model: str, usage: LLMUsage) -> float | None:
    price = PRICES.get(model)
    if price is None:
        return None
    total = (
        usage.input_tokens * price.input_per_mtok
        + usage.output_tokens * price.output_per_mtok
        + usage.cache_read_input_tokens * price.cache_read_per_mtok
        + usage.cache_creation_input_tokens * price.cache_write_per_mtok
    ) / 1_000_000
    return round(total, 6)
