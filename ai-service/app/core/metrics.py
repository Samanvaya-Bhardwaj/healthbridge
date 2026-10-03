"""Prometheus metrics (M11): metadata only, low-cardinality labels.

Labels are workflow names, providers, model ids and outcome enums: never identifiers,
prompts, outputs or anything patient-related.
"""

from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest
from prometheus_client.exposition import CONTENT_TYPE_LATEST

REGISTRY = CollectorRegistry(auto_describe=True)

HTTP_DURATION = Histogram(
    "ai_http_request_duration_seconds",
    "AI service request duration",
    ["method", "route", "status_code"],
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
    registry=REGISTRY,
)
LLM_CALLS = Counter(
    "ai_llm_calls_total",
    "LLM generations by outcome",
    ["workflow", "provider", "model", "status"],
    registry=REGISTRY,
)
LLM_LATENCY = Histogram(
    "ai_llm_call_duration_seconds",
    "LLM generation latency",
    ["workflow", "provider"],
    buckets=(0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 60, 120),
    registry=REGISTRY,
)
LLM_TOKENS = Counter(
    "ai_llm_tokens_total",
    "LLM tokens by direction",
    ["workflow", "model", "direction"],
    registry=REGISTRY,
)
LLM_COST = Counter(
    "ai_llm_estimated_cost_usd_total",
    "Estimated LLM spend in US dollars",
    ["workflow", "model"],
    registry=REGISTRY,
)

__all__ = [
    "CONTENT_TYPE_LATEST",
    "HTTP_DURATION",
    "LLM_CALLS",
    "LLM_COST",
    "LLM_LATENCY",
    "LLM_TOKENS",
    "REGISTRY",
    "generate_latest",
]
