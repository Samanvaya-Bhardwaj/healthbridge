"""Liveness and readiness probes (unauthenticated, reachable on the private network only)."""

import asyncio
import time

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from app.core.metrics import CONTENT_TYPE_LATEST, REGISTRY, generate_latest

router = APIRouter(tags=["health"])

CHECK_TIMEOUT_SECONDS = 2.0


@router.get("/health/live")
async def live(request: Request) -> dict:
    return {"status": "ok", "version": request.app.state.settings.service_version}


@router.get("/health/ready")
async def ready(request: Request) -> JSONResponse:
    checks: dict[str, dict] = {}

    started = time.perf_counter()
    try:
        await asyncio.wait_for(request.app.state.db.ping(), CHECK_TIMEOUT_SECONDS)
        checks["database"] = {"status": "up"}
    except Exception as exc:
        checks["database"] = {"status": "down", "error": type(exc).__name__}
    checks["database"]["latencyMs"] = round((time.perf_counter() - started) * 1000)

    # Configuration-level check only: readiness probes must not spend money on LLM calls.
    llm = request.app.state.llm
    checks["llm"] = {"status": "up", "provider": llm.name}

    healthy = all(check["status"] == "up" for check in checks.values())
    return JSONResponse(
        {
            "status": "ok" if healthy else "unavailable",
            "checks": checks,
            "version": request.app.state.settings.service_version,
        },
        status_code=200 if healthy else 503,
    )


@router.get("/metrics", include_in_schema=False)
async def metrics() -> Response:
    """Prometheus scrape endpoint (private network only; metadata, no content)."""
    return Response(generate_latest(REGISTRY), media_type=CONTENT_TYPE_LATEST)
