"""Internal API (v1). Every route requires a valid backend service token.

Agent, extraction and retrieval endpoints are added here in later milestones.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.core.security import ServicePrincipal, require_service_token
from app.llm.base import ModelTier

router = APIRouter(prefix="/v1", tags=["internal"], dependencies=[Depends(require_service_token)])


@router.get("/meta")
async def meta(
    request: Request, principal: Annotated[ServicePrincipal, Depends(require_service_token)]
) -> dict:
    settings = request.app.state.settings
    llm = request.app.state.llm
    return {
        "service": "healthbridge-ai",
        "version": settings.service_version,
        "caller": principal.subject,
        "llm": {
            "provider": llm.name,
            "models": {tier.value: llm.resolve_model(tier) for tier in ModelTier},
            "externalProcessingApproved": settings.llm_external_processing_approved,
        },
    }
