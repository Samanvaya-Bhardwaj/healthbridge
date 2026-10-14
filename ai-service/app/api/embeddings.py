"""Embeddings of public, non-patient text (M13.2 doctor search, ADR-0031).

Service token only, with no patient scope: the backend sends public doctor-profile text,
and search queries it built from the controlled vocabulary (specialty and area names),
never a patient's words. Nothing is stored here and the texts are not logged.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core.errors import ProblemError
from app.core.security import require_service_token
from app.embeddings import EmbeddingError

router = APIRouter(
    prefix="/v1/embeddings", tags=["embeddings"], dependencies=[Depends(require_service_token)]
)

Text = Annotated[str, Field(min_length=1, max_length=2000)]


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    purpose: Literal["doctor_profile", "doctor_search_query"]
    kind: Literal["document", "query"]
    texts: Annotated[list[Text], Field(min_length=1, max_length=64)]


def model_id(embedder) -> str:
    model = getattr(embedder, "_model", None)
    return f"{embedder.name}:{model}" if model else embedder.name


@router.post("")
async def embed(body: EmbedRequest, request: Request) -> dict:
    embedder = request.app.state.embedder
    try:
        vectors = await embedder.embed(body.texts, kind=body.kind)
    except EmbeddingError as exc:
        raise ProblemError(
            503, "embedding_unavailable", "Embeddings unavailable", "Try again later."
        ) from exc
    return {"model": model_id(embedder), "dimensions": embedder.dimensions, "vectors": vectors}
