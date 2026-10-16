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


@router.get("/model")
async def current_model(request: Request) -> dict:
    """The model new vectors come from (the backend re-embeds when it changes)."""
    embedder = request.app.state.embedder
    return {"model": embedder.model_id, "dimensions": embedder.dimensions}


@router.post("")
async def embed(body: EmbedRequest, request: Request) -> dict:
    embedder = request.app.state.embedder
    try:
        vectors = await embedder.embed(body.texts, kind=body.kind)
    except EmbeddingError as exc:
        raise ProblemError(
            503, "embedding_unavailable", "Embeddings unavailable", "Try again later."
        ) from exc
    return {"model": embedder.model_id, "dimensions": embedder.dimensions, "vectors": vectors}
