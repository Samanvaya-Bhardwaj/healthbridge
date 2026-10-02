"""Embedding providers (ADR-0022): provider-neutral interface, hashing default, Voyage adapter."""

import hashlib
import itertools
import math
import re
from abc import ABC, abstractmethod

import httpx

EMBEDDING_DIMENSIONS = 1024
_TOKEN = re.compile(r"[a-z0-9]+(?:\.[0-9]+)?")


class EmbeddingError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


class EmbeddingProvider(ABC):
    name: str
    dimensions: int = EMBEDDING_DIMENSIONS

    @abstractmethod
    async def embed(self, texts: list[str], *, kind: str = "document") -> list[list[float]]:
        """One L2-normalised vector per text. `kind` is "document" or "query"."""

    async def aclose(self) -> None:  # noqa: B027 - optional hook
        """Release network resources."""


class HashingEmbeddingProvider(EmbeddingProvider):
    """Deterministic, offline feature-hashing embeddings (unigrams + bigrams).

    Lexical rather than semantic, but stable across runs and machines: used for
    development, tests and demo mode. Hybrid retrieval pairs it with full-text search.
    """

    name = "hashing"

    def _vector(self, text: str) -> list[float]:
        tokens = _TOKEN.findall(text.lower())
        features = tokens + [f"{a} {b}" for a, b in itertools.pairwise(tokens)]
        vec = [0.0] * self.dimensions
        for feature in features:
            digest = hashlib.blake2b(feature.encode(), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % self.dimensions
            sign = 1.0 if digest[4] & 1 else -1.0
            vec[index] += sign
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    async def embed(self, texts: list[str], *, kind: str = "document") -> list[list[float]]:
        return [self._vector(t) for t in texts]


class VoyageEmbeddingProvider(EmbeddingProvider):
    """Voyage AI embeddings over HTTPS (external processing; same production gate as LLMs)."""

    name = "voyage"

    def __init__(self, *, api_key: str, model: str, timeout_seconds: float) -> None:
        self._model = model
        self._client = httpx.AsyncClient(
            base_url="https://api.voyageai.com/v1",
            headers={"authorization": f"Bearer {api_key}"},
            timeout=timeout_seconds,
        )

    async def embed(self, texts: list[str], *, kind: str = "document") -> list[list[float]]:
        try:
            res = await self._client.post(
                "/embeddings",
                json={
                    "input": texts,
                    "model": self._model,
                    "input_type": "query" if kind == "query" else "document",
                    "output_dimension": self.dimensions,
                },
            )
        except httpx.TimeoutException as exc:
            raise EmbeddingError("timeout", "embedding provider timed out") from exc
        except httpx.HTTPError as exc:
            raise EmbeddingError("unavailable", "embedding provider unreachable") from exc
        if res.status_code >= 400:
            raise EmbeddingError(
                "unavailable" if res.status_code >= 500 else "bad_request",
                f"embedding provider error {res.status_code}",
            )
        data = sorted(res.json()["data"], key=lambda d: d["index"])
        return [d["embedding"] for d in data]

    async def aclose(self) -> None:
        await self._client.aclose()


def to_pgvector(vector: list[float]) -> str:
    return "[" + ",".join(f"{v:.6f}" for v in vector) + "]"
